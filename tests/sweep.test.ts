import { describe, expect, it } from "bun:test";
import { isNotFound, sweepOrphans, SWEEP_INTERVAL_MS, type SweepStorage } from "../src/sweep";

function memoryStorage(keys: string[]): SweepStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(keys.map((key) => [key, {}]));
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    // Two entries per page, so the sweep has to follow `next`.
    scan: async ({ prefix, after }) => {
      const matching = [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = after ? matching.indexOf(after) + 1 : 0;
      const page = matching.slice(start, start + 2);
      const next = start + 2 < matching.length ? page.at(-1) : undefined;
      return { entries: page.map((key) => ({ key })), ...(next ? { next } : {}) };
    },
  };
}

const PREFIXES = ["a/", "r/", "s/", "session/"];
const live = new Set(["a", "c"]);
const exists = async (sessionID: string) => live.has(sessionID);

describe("sweepOrphans", () => {
  it("finds every session under the prefixes, across pages, and removes the missing ones once", async () => {
    const storage = memoryStorage([
      "a/a/lot-1",
      "a/b/lot-1",
      "a/b/lot-2",
      "r/b/lot-1/3",
      "s/d",
      "session/c",
      "session/e",
    ]);
    const removed: string[] = [];
    await sweepOrphans(storage, PREFIXES, exists, async (sessionID) => void removed.push(sessionID), 1_000_000);
    expect(removed.sort()).toEqual(["b", "d", "e"]);
  });

  it("runs at most once per interval", async () => {
    const storage = memoryStorage(["a/b/x"]);
    const removed: string[] = [];
    const remove = async (sessionID: string) => void removed.push(sessionID);
    await storage.set("meta/last-sweep", 1_000_000);
    expect(await sweepOrphans(storage, PREFIXES, exists, remove, 1_000_000 + SWEEP_INTERVAL_MS - 1)).toEqual([]);
    expect(await sweepOrphans(storage, PREFIXES, exists, remove, 1_000_000 + SWEEP_INTERVAL_MS)).toEqual(["b"]);
  });

  it("keeps a session's artifacts when the lookup fails for another reason", async () => {
    const storage = memoryStorage(["a/x/doc"]);
    const unsure = async () => true; // what sessionExists returns on a non-NotFound error
    expect(await sweepOrphans(storage, PREFIXES, unsure, async () => {}, 1_000_000)).toEqual([]);
  });
});

describe("isNotFound", () => {
  it("recognises not-found errors by tag, name or cause", () => {
    expect(isNotFound({ _tag: "SessionNotFoundError" })).toBe(true);
    expect(isNotFound({ _tag: "Session.NotFoundError" })).toBe(true);
    expect(isNotFound({ name: "Error", cause: { _tag: "SessionNotFoundError" } })).toBe(true);
    expect(isNotFound(new Error("timeout"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
