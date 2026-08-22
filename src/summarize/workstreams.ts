import type { MeetingSummary } from './schema.js';

/**
 * Snapping the model's workstream names back onto the team's canonical ones.
 *
 * Workstreams cannot be a hard enum: projects end and new ones start, and a
 * meeting where someone says "let's talk about Project Aurora" has to be able
 * to produce a section called Project Aurora rather than dumping it in Other.
 * But left completely free, the same workstream comes back as "platform
 * migration" one week and "Platform Migration work" the next, and a reader
 * scanning for their section has to notice they are the same thing.
 *
 * So: the model names freely, and anything recognisable as a configured
 * workstream is snapped to the configured spelling. Anything unrecognisable is
 * kept exactly as the model wrote it - that is the new project, and losing it
 * would be worse than an inconsistent name.
 */

export function normalizeWorkstreams(
  summary: MeetingSummary,
  configured: readonly string[],
): MeetingSummary {
  const snapped = configured.length === 0 ? summary : snapNames(summary, configured);
  return dropEmptyWorkstreams(snapped);
}

/**
 * Removes workstream sections with nothing under them.
 *
 * The prompt asks the model to omit a workstream that was not discussed, and
 * a 4B model does not reliably obey: given a list of the team's usual
 * workstreams it tends to emit all of them, two with bullets and the rest as
 * bare headings. A heading with nothing under it reads as "we discussed this
 * and it produced nothing", which is a different and wrong claim.
 *
 * A section is only empty if nothing is tagged to it either - a workstream
 * whose whole contribution was one action item still deserves its heading.
 */
function dropEmptyWorkstreams(summary: MeetingSummary): MeetingSummary {
  const tagged = new Set([
    ...summary.decisions.map((d) => d.workstream),
    ...summary.actionItems.map((a) => a.workstream),
    ...summary.openQuestions.map((q) => q.workstream),
  ]);

  return {
    ...summary,
    workstreams: summary.workstreams.filter(
      (stream) => stream.points.length > 0 || tagged.has(stream.name),
    ),
  };
}

function snapNames(summary: MeetingSummary, configured: readonly string[]): MeetingSummary {
  const snap = (name: string): string => canonical(name, configured);

  return {
    ...summary,
    workstreams: mergeByName(
      summary.workstreams.map((stream) => ({ ...stream, name: snap(stream.name) })),
    ),
    decisions: summary.decisions.map((d) => ({ ...d, workstream: snap(d.workstream) })),
    actionItems: summary.actionItems.map((a) => ({ ...a, workstream: snap(a.workstream) })),
    openQuestions: summary.openQuestions.map((q) => ({ ...q, workstream: snap(q.workstream) })),
  };
}

/**
 * Exact match on a normalised form first, then containment either way, which
 * covers "the platform migration" and "Platform Migration work" alike.
 * Deliberately no fuzzy distance: snapping a genuinely new project onto a
 * similarly-spelled old one would silently lose it, and that is a worse
 * failure than an unsnapped name.
 */
function canonical(name: string, configured: readonly string[]): string {
  const target = simplify(name);
  if (target.length === 0) return name;

  for (const option of configured) {
    if (simplify(option) === target) return option;
  }

  for (const option of configured) {
    const candidate = simplify(option);
    if (candidate.length >= 4 && (target.includes(candidate) || candidate.includes(target))) {
      return option;
    }
  }

  return name;
}

/** Two sections that snapped to the same name are one section. */
function mergeByName(
  streams: MeetingSummary['workstreams'],
): MeetingSummary['workstreams'] {
  const merged = new Map<string, string[]>();

  for (const stream of streams) {
    const existing = merged.get(stream.name);
    if (existing) existing.push(...stream.points);
    else merged.set(stream.name, [...stream.points]);
  }

  return [...merged].map(([name, points]) => ({ name, points }));
}

function simplify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|workstream|work|stream|project|track)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
