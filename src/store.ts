// Artifacts live in opencode's own durable key-value storage, which the host
// scopes to this plugin. Nothing lands in the user's repositories.
//
// `session/<id>`: the artifact's state, with the text of its current revision.
// `rev/<id>/<n>`: the text of each revision kept, for undo and redo.

import type { Plugin } from "@opencode/plugin";
import { EMPTY_ARTIFACT, fromStored, type Artifact, type Change, type Snapshot } from "./artifact.js";

type Storage = Plugin.Context["storage"];
type Json = Parameters<Storage["set"]>[1];

const stateKey = (sessionID: string) => `session/${sessionID}`;
const revisionPrefix = (sessionID: string) => `rev/${sessionID}/`;
const revisionKey = (sessionID: string, revision: number) => `${revisionPrefix(sessionID)}${revision}`;

function isSnapshot(value: unknown): value is Snapshot {
  const snapshot = value as Snapshot | undefined;
  return typeof snapshot?.title === "string" && typeof snapshot.content === "string";
}

export interface Revisions {
  /** The text of a kept revision. */
  get(revision: number): Promise<Snapshot>;
}

export function createStore(storage: Storage) {
  // Writes to one session run one after another: the agent's tool calls and
  // the user's actions must not read the same state and overwrite each other.
  const queues = new Map<string, Promise<unknown>>();
  const queue = <T>(sessionID: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(sessionID, next);
    return next;
  };

  const load = async (sessionID: string) => fromStored(await storage.get(stateKey(sessionID)));

  const read = async (sessionID: string): Promise<Artifact> => (await load(sessionID))?.artifact ?? EMPTY_ARTIFACT;

  const revisionsOf = (sessionID: string, artifact: Artifact): Revisions => ({
    async get(revision) {
      if (revision === artifact.revision) return { title: artifact.title, content: artifact.content };
      const value = await storage.get(revisionKey(sessionID, revision));
      if (!isSnapshot(value)) throw new Error(`Revision ${revision} is not stored.`);
      return value;
    },
  });

  const removeRevisions = async (sessionID: string) => {
    let after: string | undefined;
    do {
      const page = await storage.scan({ prefix: revisionPrefix(sessionID), after, limit: 100 });
      for (const { key } of page.entries) await storage.remove(key);
      after = page.next;
    } while (after);
  };

  return {
    read,
    /** A kept revision's text, the current one included. */
    async revision(sessionID: string, revision: number): Promise<Snapshot> {
      return revisionsOf(sessionID, await read(sessionID)).get(revision);
    },
    /**
     * Applies `change` to the stored artifact and saves the result when it
     * differs: the state, the revision text to keep and the ones to drop.
     */
    update(
      sessionID: string,
      change: (artifact: Artifact, revisions: Revisions) => Change | Artifact | Promise<Change | Artifact>,
    ): Promise<{ before: Artifact; after: Artifact }> {
      return queue(sessionID, async () => {
        const loaded = await load(sessionID);
        const before = loaded?.artifact ?? EMPTY_ARTIFACT;
        const result = await change(before, revisionsOf(sessionID, before));
        const { artifact: after, put, drop } = "artifact" in result ? result : { artifact: result, put: undefined, drop: [] };
        if (after === before) return { before, after };
        // An artifact from the first version keeps its text as a revision to come back to.
        if (loaded?.legacy) {
          await storage.set(revisionKey(sessionID, before.revision), { title: before.title, content: before.content });
        }
        if (put) await storage.set(revisionKey(sessionID, put.revision), put.snapshot as unknown as Json);
        await storage.set(stateKey(sessionID), after as unknown as Json);
        for (const revision of drop) await storage.remove(revisionKey(sessionID, revision));
        return { before, after };
      });
    },
    /** Removes the session's artifact and its revisions, after the writes already queued. Returns what was removed. */
    remove(sessionID: string): Promise<Artifact> {
      return queue(sessionID, async () => {
        const before = await read(sessionID);
        await storage.remove(stateKey(sessionID));
        await removeRevisions(sessionID);
        return before;
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
