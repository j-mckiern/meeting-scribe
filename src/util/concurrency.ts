/**
 * Runs `worker` over `items`, at most `limit` at a time, and returns the
 * results in the original order.
 *
 * `Promise.all(items.map(worker))` would start every request at once, which a
 * free-tier API answers with a wall of 429s. This keeps a fixed number of
 * workers pulling from a shared cursor instead, so a slow item delays only
 * itself.
 *
 * The first rejection stops new items being picked up and is re-thrown once
 * the in-flight ones settle. That matters for the case it exists for: an
 * expired API key should fail after three requests, not after two hundred.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown = null;

  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async (): Promise<void> => {
      while (failure === null) {
        const index = next;
        next += 1;
        if (index >= items.length) return;

        try {
          results[index] = await worker(items[index]!, index);
        } catch (error) {
          failure ??= error;
        }
      }
    },
  );

  await Promise.all(runners);
  if (failure !== null) throw failure;

  return results;
}
