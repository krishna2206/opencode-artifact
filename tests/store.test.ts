import { describe, expect, it } from "bun:test";
import { agentEdit, agentWrite, switchTo, userSave } from "../src/artifact";
import { createStore } from "../src/store";

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    remove: async (key: string) => void data.delete(key),
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
      const matching = [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = after ? matching.indexOf(after) + 1 : 0;
      const page = matching.slice(start, start + limit);
      const next = start + limit < matching.length ? page.at(-1) : undefined;
      return { entries: page.map((key) => ({ key, value: data.get(key) })), ...(next ? { next } : {}) };
    },
  };
  return { data, store: createStore(storage as never) };
}

describe("store", () => {
  it("keeps each revision's text, switches back and replaces the redo ones", async () => {
    const { data, store } = memoryStorage();
    for (const text of ["one", "two", "three"]) {
      await store.update("s", (artifact) => agentWrite(artifact, "Plan", text, 1));
    }
    expect([...data.keys()].sort()).toEqual(["rev/s/1", "rev/s/2", "rev/s/3", "session/s"]);

    await store.update("s", async (artifact, revisions) => switchTo(artifact, 1, await revisions.get(1), "user", 2));
    expect((await store.read("s")).content).toBe("one");
    expect((await store.revision("s", 3)).content).toBe("three");

    await store.update("s", (artifact) => agentEdit(artifact, "one", "one bis", false, 3));
    expect([...data.keys()].sort()).toEqual(["rev/s/1", "rev/s/2", "session/s"]);
    expect((await store.revision("s", 2)).content).toBe("one bis");
  });

  it("keeps the text of an artifact from the first version once it changes", async () => {
    const { data, store } = memoryStorage();
    data.set("session/s", { revision: 4, title: "Old", content: "old", updatedAt: 1, updatedBy: "agent", editedByUser: false, comments: [] });
    await store.update("s", (artifact) => userSave(artifact, "new", 2));
    expect((await store.read("s")).revision).toBe(5);
    expect((await store.revision("s", 4)).content).toBe("old");
  });

  it("removes the revisions with the artifact", async () => {
    const { data, store } = memoryStorage();
    await store.update("s", (artifact) => agentWrite(artifact, "Plan", "one", 1));
    await store.update("s", (artifact) => agentWrite(artifact, "Plan", "two", 1));
    await store.update("t", (artifact) => agentWrite(artifact, "Other", "x", 1));
    await store.remove("s");
    expect([...data.keys()].sort()).toEqual(["rev/t/1", "session/t"]);
  });
});
