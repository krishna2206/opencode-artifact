import { describe, expect, it } from "bun:test";
import { isNotFound, sweepOrphans, SWEEP_INTERVAL_MS, type SweepStorage } from "../src/sweep";

function memoryStorage(keys: string[]): SweepStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(keys.map((key) => [key, {}]));
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
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

const live = new Set(["a", "c"]);
const exists = async (sessionID: string) => live.has(sessionID);

describe("sweepOrphans", () => {
  it("removes the artifacts of missing sessions only, across pages", async () => {
    const storage = memoryStorage(["session/a", "session/b", "session/c", "session/d", "session/e"]);
    const removed = await sweepOrphans(storage, exists, 1_000_000);
    expect(removed.sort()).toEqual(["b", "d", "e"]);
    expect([...storage.data.keys()].filter((key) => key.startsWith("session/")).sort()).toEqual([
      "session/a",
      "session/c",
    ]);
  });

  it("runs at most once per interval", async () => {
    const storage = memoryStorage(["session/b"]);
    await storage.set("meta/last-sweep", 1_000_000);
    expect(await sweepOrphans(storage, exists, 1_000_000 + SWEEP_INTERVAL_MS - 1)).toEqual([]);
    expect(storage.data.has("session/b")).toBe(true);
    expect(await sweepOrphans(storage, exists, 1_000_000 + SWEEP_INTERVAL_MS)).toEqual(["b"]);
  });

  it("keeps an artifact when the lookup fails for another reason", async () => {
    const storage = memoryStorage(["session/x"]);
    const unsure = async () => true; // what sessionExists returns on a non-NotFound error
    expect(await sweepOrphans(storage, unsure, 1_000_000)).toEqual([]);
    expect(storage.data.has("session/x")).toBe(true);
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
