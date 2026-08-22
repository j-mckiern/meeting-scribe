"""
faster-whisper as a long-lived worker process.

Loading the model costs far more than transcribing with it - about 35 seconds
against 5 seconds for ten seconds of audio, on a laptop CPU. So this is a
worker that loads once and then answers many jobs, not a script invoked per
file. That is the concrete reason the `Transcriber` interface is
batch-in/batch-out: a per-segment interface would pay the load cost per
segment and be an order of magnitude slower for a real meeting.

Protocol, NDJSON both ways so results can stream back as they finish:

  argv[1]  JSON config: model, device, computeType, language
  stdin    one job per line: {"id": ..., "path": ..., "prompt": ...}
  stdout   {"event": "ready", ...} once, then one {"event": "result", ...} per job

Nothing here writes to stdout except protocol messages; progress and warnings
go to stderr, which the caller logs.
"""

import json
import sys
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    config = json.loads(sys.argv[1])

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({
            "event": "fatal",
            "error": "faster-whisper is not installed in this interpreter. "
                     "Create it with: uv venv .venv-whisper && "
                     "uv pip install --python .venv-whisper faster-whisper",
        })
        return 1

    started = time.monotonic()
    try:
        model = WhisperModel(
            config["model"],
            device=config["device"],
            compute_type=config["computeType"],
        )
    except Exception as error:
        emit({"event": "fatal", "error": f"{type(error).__name__}: {error}"})
        return 1

    emit({"event": "ready", "loadSeconds": round(time.monotonic() - started, 2)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        job = json.loads(line)
        try:
            emit(transcribe(model, job, config))
        except Exception as error:
            emit({
                "event": "result",
                "id": job.get("id"),
                "error": f"{type(error).__name__}: {error}",
            })

    return 0


def transcribe(model, job, config):
    segments, _info = model.transcribe(
        job["path"],
        language=config.get("language") or None,
        initial_prompt=job.get("prompt") or None,
        # Deterministic, and far less inclined to invent words for audio it
        # cannot make out - matching what groq.ts asks for.
        temperature=0,
        # faster-whisper ships its own Silero VAD, but this pipeline already
        # has an energy gate that ran before the file got here. Running both
        # would risk clipping quiet speech twice, and would make local output
        # incomparable to the hosted API's.
        vad_filter=False,
    )

    # The generator is lazy: nothing is actually decoded until it is consumed.
    windows = [
        {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "avgLogProb": segment.avg_logprob,
            "noSpeechProb": segment.no_speech_prob,
            "compressionRatio": segment.compression_ratio,
        }
        for segment in segments
    ]

    return {
        "event": "result",
        "id": job["id"],
        "text": "".join(window["text"] for window in windows).strip(),
        "windows": windows,
    }


if __name__ == "__main__":
    sys.exit(main())
