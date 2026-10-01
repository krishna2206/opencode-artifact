import { describe, expect, it } from "bun:test";
import { agentEdit, agentWrite, EMPTY_ARTIFACT, switchTo, userSave } from "../src/artifact";
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
  const keys = () => [...data.keys()].sort();
  return { data, keys, store: createStore(storage as never) };
}

const write = (text: string) => (artifact: never) => agentWrite(artifact, "Plan", text, 1);

describe("store", () => {
  it("keeps each artifact's revisions apart, switches back and replaces the redo ones", async () => {
    const { keys, store } = memoryStorage();
    for (const text of ["one", "two", "three"]) await store.update("s", "lot-1", write(text));
    await store.update("s", "lot-10", write("other"));
    expect(keys()).toEqual(["a/s/lot-1", "a/s/lot-10", "r/s/lot-1/1", "r/s/lot-1/2", "r/s/lot-1/3", "r/s/lot-10/1"]);

    await store.update("s", "lot-1", async (artifact, context) => switchTo(artifact, 1, await context.revision(1), "user", 2));
    expect((await store.read("s", "lot-1")).content).toBe("one");
    expect((await store.meta("s")).events.map((event) => event.artifact)).toEqual(["lot-1"]);

    await store.update("s", "lot-1", (artifact) => agentEdit(artifact, [{ old_string: "one", new_string: "one bis" }], 3));
    expect(keys().filter((key) => key.startsWith("r/s/lot-1/"))).toEqual(["r/s/lot-1/1", "r/s/lot-1/2"]);
    expect((await store.revision("s", "lot-1", 2)).content).toBe("one bis");
    expect((await store.list("s")).map((artifact) => artifact.id).sort()).toEqual(["lot-1", "lot-10"]);
  });

  it("moves the second version's single artifact under an identifier from its title", async () => {
    const { data, keys, store } = memoryStorage();
    const old = agentWrite(EMPTY_ARTIFACT, "Spec — Lot 1", "v2", 1).artifact;
    data.set("session/s", { ...old, revision: 2, latest: 2, id: undefined, events: [{ at: 5, text: "the user undid" }] });
    data.set("rev/s/1", { title: "Spec — Lot 1", content: "v1" });
    data.set("rev/s/2", { title: "Spec — Lot 1", content: "v2" });
    const [artifact] = await store.list("s");
    expect(artifact).toMatchObject({ id: "spec-lot-1", revision: 2 });
    expect(keys()).toEqual(["a/s/spec-lot-1", "r/s/spec-lot-1/1", "r/s/spec-lot-1/2", "s/s"]);
    expect((await store.revision("s", "spec-lot-1", 1)).content).toBe("v1");
    expect((await store.meta("s")).events).toEqual([{ artifact: "spec-lot-1", at: 5, text: "the user undid" }]);
  });

  it("keeps the text of a first-version artifact as a revision", async () => {
    const { data, store } = memoryStorage();
    data.set("session/s", { revision: 4, title: "Old", content: "old", updatedAt: 1, updatedBy: "agent", editedByUser: false, comments: [] });
    await store.update("s", "old", (artifact) => userSave(artifact, "new", 2));
    expect((await store.read("s", "old")).revision).toBe(5);
    expect((await store.revision("s", "old", 4)).content).toBe("old");
  });

  it("renames an artifact with its revisions and its events, refusing a taken identifier", async () => {
    const { keys, store } = memoryStorage();
    await store.update("s", "a", write("one"));
    await store.update("s", "a", (artifact) => userSave(artifact, "mine", 2));
    await store.update("s", "b", write("b"));
    await expect(store.rename("s", "a", "b")).rejects.toThrow("already exists");
    const renamed = await store.rename("s", "a", "lot-1", "the user renamed the artifact a to lot-1.");
    expect(renamed.id).toBe("lot-1");
    expect(keys()).toEqual(["a/s/b", "a/s/lot-1", "r/s/b/1", "r/s/lot-1/1", "r/s/lot-1/2", "s/s"]);
    expect((await store.meta("s")).events.map((event) => event.artifact)).toEqual(["lot-1", "lot-1"]);
  });

  it("keeps the artifact shown through renames, and drops it with the artifact", async () => {
    const { store } = memoryStorage();
    await store.update("s", "a", write("one"));
    await store.update("s", "b", write("two"));
    expect((await store.show("s", "missing")).shown).toBeUndefined();
    const shown = await store.show("s", "a");
    expect(shown.shown).toBe("a");
    expect((await store.show("s", "a")).seq).toBe(shown.seq);
    await store.rename("s", "a", "lot-1");
    expect((await store.meta("s")).shown).toBe("lot-1");
    await store.remove("s", "lot-1");
    expect((await store.meta("s")).shown).toBeUndefined();
  });

  it("removes one artifact with its revisions and events, or a whole session", async () => {
    const { keys, store } = memoryStorage();
    await store.update("s", "a", write("one"));
    await store.update("s", "a", (artifact) => userSave(artifact, "mine", 2));
    await store.update("s", "b", write("b"));
    await store.update("t", "c", write("c"));
    await store.remove("s", "a");
    expect(keys()).toEqual(["a/s/b", "a/t/c", "r/s/b/1", "r/t/c/1", "s/s"]);
    expect((await store.meta("s")).events).toEqual([]);
    await store.removeSession("s");
    expect(keys()).toEqual(["a/t/c", "r/t/c/1"]);
  });
});
