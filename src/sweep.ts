// Removes the artifacts whose session no longer exists.
//
// A session's artifacts are removed right away when the session is deleted
// while this plugin runs (the session.deleted event). A session deleted while
// it was not loaded (opencode stopped, plugin disabled, another client) leaves
// them behind: this sweep catches those, at most once a day.

const LAST_SWEEP_KEY = "meta/last-sweep";
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;

export interface SweepStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: number): Promise<void>;
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string }[];
    next?: string;
  }>;
}

/**
 * Whether a lookup failed because the session does not exist. Any other
 * failure (a transient error, a timeout) keeps the artifacts: removing them
 * then would lose a live session's documents.
 */
export function isNotFound(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const tag = (current as { _tag?: unknown; name?: unknown })._tag ?? (current as { name?: unknown }).name;
    if (typeof tag === "string" && /NotFound/.test(tag)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs the sweep if the last one is older than the interval: every session
 * with a key under one of `prefixes` (`<prefix><session>…`) is looked up, and
 * `removeSession` removes what a missing one left. Returns those sessions.
 */
export async function sweepOrphans(
  storage: SweepStorage,
  prefixes: readonly string[],
  sessionExists: (sessionID: string) => Promise<boolean>,
  removeSession: (sessionID: string) => Promise<unknown>,
  now: number,
): Promise<string[]> {
  const last = await storage.get(LAST_SWEEP_KEY);
  if (typeof last === "number" && now - last < SWEEP_INTERVAL_MS) return [];
  // Stamped first: another location starting at the same time skips it.
  await storage.set(LAST_SWEEP_KEY, now);

  const sessions = new Set<string>();
  for (const prefix of prefixes) {
    let after: string | undefined;
    do {
      const page = await storage.scan({ prefix, after, limit: PAGE });
      for (const { key } of page.entries) {
        const sessionID = key.slice(prefix.length).split("/")[0];
        if (sessionID) sessions.add(sessionID);
      }
      after = page.next;
    } while (after);
  }

  const removed: string[] = [];
  for (const sessionID of sessions) {
    if (await sessionExists(sessionID)) continue;
    await removeSession(sessionID);
    removed.push(sessionID);
  }
  return removed;
}
