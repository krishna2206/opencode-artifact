// Artifacts live in opencode's own durable key-value storage, which the host
// scopes to this plugin. Nothing lands in the user's repositories.
//
// `a/<session>/<id>`: an artifact's state, with the text of its current revision.
// `r/<session>/<id>/<n>`: the text of each revision kept, for undo and redo.
// `s/<session>`: the changes the agent is told about (SessionMeta).
//
// The second version kept one artifact per session under `session/<session>`
// and `rev/<session>/<n>`: it moves to the keys above, once, the first time
// its session is used.

import type { Plugin } from "@opencode/plugin";
import {
  EMPTY_ARTIFACT,
  EMPTY_META,
  exists,
  fromStored,
  lastEvent,
  slugify,
  uniqueId,
  withEvent,
  type Artifact,
  type Change,
  type SessionMeta,
  type Snapshot,
} from "./artifact.js";

type Storage = Plugin.Context["storage"];
type Json = Parameters<Storage["set"]>[1];

const metaKey = (sessionID: string) => `s/${sessionID}`;
const statePrefix = (sessionID: string) => `a/${sessionID}/`;
const stateKey = (sessionID: string, id: string) => `${statePrefix(sessionID)}${id}`;
const revisionPrefix = (sessionID: string, id: string) => `r/${sessionID}/${id}/`;
const revisionKey = (sessionID: string, id: string, revision: number) => `${revisionPrefix(sessionID, id)}${revision}`;
const legacyState = (sessionID: string) => `session/${sessionID}`;
const legacyRevisions = (sessionID: string) => `rev/${sessionID}/`;

/** The key prefixes that hold a session's data: the sweep looks for orphans under them. */
export const SESSION_PREFIXES = ["a/", "r/", "s/", "session/", "rev/"];

function isSnapshot(value: unknown): value is Snapshot {
  const snapshot = value as Snapshot | undefined;
  return typeof snapshot?.title === "string" && typeof snapshot.content === "string";
}

function toMeta(value: unknown): SessionMeta {
  const meta = value as SessionMeta | undefined;
  return typeof meta?.seq === "number" && Array.isArray(meta.events) ? meta : EMPTY_META;
}

export interface UpdateContext {
  /** The text of a kept revision. */
  revision(revision: number): Promise<Snapshot>;
  /** The last change the agent was told about on this artifact. */
  lastEvent?: string;
}

export function createStore(storage: Storage) {
  // Changes to one session run one after another: the agent's tool calls and
  // the user's actions must not read the same state and overwrite each other.
  const queues = new Map<string, Promise<unknown>>();
  const migrated = new Set<string>();

  const scanAll = async (prefix: string) => {
    const entries: { key: string; value: unknown }[] = [];
    let after: string | undefined;
    do {
      const page = await storage.scan({ prefix, after, limit: 100 });
      entries.push(...page.entries);
      after = page.next;
    } while (after);
    return entries;
  };

  const removeAll = async (prefix: string) => {
    for (const { key } of await scanAll(prefix)) await storage.remove(key);
  };

  const readMeta = async (sessionID: string) => toMeta(await storage.get(metaKey(sessionID)));

  const readState = async (sessionID: string, id: string): Promise<Artifact> =>
    fromStored(await storage.get(stateKey(sessionID, id)), id)?.artifact ?? { ...EMPTY_ARTIFACT, id };

  const listStates = async (sessionID: string): Promise<Artifact[]> => {
    const prefix = statePrefix(sessionID);
    const artifacts: Artifact[] = [];
    for (const { key, value } of await scanAll(prefix)) {
      const artifact = fromStored(value, key.slice(prefix.length))?.artifact;
      if (artifact && exists(artifact)) artifacts.push(artifact);
    }
    return artifacts;
  };

  /** The second version's artifact, under an identifier from its title. */
  const migrate = async (sessionID: string) => {
    if (migrated.has(sessionID)) return;
    const old = await storage.get(legacyState(sessionID));
    if (old !== undefined) {
      const parsed = fromStored(old);
      if (parsed && exists(parsed.artifact)) {
        const taken = new Set((await listStates(sessionID)).map((artifact) => artifact.id));
        const id = uniqueId(slugify(parsed.artifact.title), taken);
        for (const { key, value } of await scanAll(legacyRevisions(sessionID))) {
          const revision = Number(key.slice(legacyRevisions(sessionID).length));
          if (Number.isInteger(revision)) await storage.set(revisionKey(sessionID, id, revision), value as Json);
        }
        if (parsed.legacy) {
          const snapshot: Snapshot = { title: parsed.artifact.title, content: parsed.artifact.content };
          await storage.set(revisionKey(sessionID, id, parsed.artifact.revision), snapshot as unknown as Json);
        }
        await storage.set(stateKey(sessionID, id), { ...parsed.artifact, id } as unknown as Json);
        if (parsed.events.length > 0) {
          let meta = await readMeta(sessionID);
          for (const event of parsed.events) meta = withEvent(meta, { artifact: id, at: event.at, text: event.text });
          await storage.set(metaKey(sessionID), meta as unknown as Json);
        }
      }
      // Only once the new keys hold everything.
      await removeAll(legacyRevisions(sessionID));
      await storage.remove(legacyState(sessionID));
    }
    migrated.add(sessionID);
  };

  const queue = <T>(sessionID: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(sessionID) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await migrate(sessionID);
        return run();
      });
    queues.set(sessionID, next);
    return next;
  };

  const snapshotOf = async (sessionID: string, artifact: Artifact, revision: number): Promise<Snapshot> => {
    if (revision === artifact.revision) return { title: artifact.title, content: artifact.content };
    const value = await storage.get(revisionKey(sessionID, artifact.id, revision));
    if (!isSnapshot(value)) throw new Error(`Revision ${revision} of ${artifact.id} is not stored.`);
    return value;
  };

  return {
    /** The session's artifacts, in no particular order. */
    list: (sessionID: string) => queue(sessionID, () => listStates(sessionID)),
    /** One artifact; an empty one (revision 0) when it does not exist. */
    read: (sessionID: string, id: string) => queue(sessionID, () => readState(sessionID, id)),
    meta: (sessionID: string) => queue(sessionID, () => readMeta(sessionID)),
    /** A kept revision's text, the current one included. */
    revision: (sessionID: string, id: string, revision: number) =>
      queue(sessionID, async () => snapshotOf(sessionID, await readState(sessionID, id), revision)),
    /**
     * Applies `change` to an artifact and saves the result when it differs:
     * the state, the revision text to keep and the ones to drop, and the event
     * for the agent.
     */
    update(
      sessionID: string,
      id: string,
      change: (artifact: Artifact, context: UpdateContext) => Change | Artifact | Promise<Change | Artifact>,
    ): Promise<{ before: Artifact; after: Artifact }> {
      return queue(sessionID, async () => {
        const before = await readState(sessionID, id);
        const meta = await readMeta(sessionID);
        const result = await change(before, {
          revision: (revision) => snapshotOf(sessionID, before, revision),
          lastEvent: lastEvent(meta, id),
        });
        const { artifact, put, drop, event } = "drop" in result ? result : { artifact: result, put: undefined, drop: [], event: undefined };
        if (artifact === before) return { before, after: before };
        const after = { ...artifact, id };
        if (put) await storage.set(revisionKey(sessionID, id, put.revision), put.snapshot as unknown as Json);
        await storage.set(stateKey(sessionID, id), after as unknown as Json);
        for (const revision of drop) await storage.remove(revisionKey(sessionID, id, revision));
        if (event) {
          const next = withEvent(meta, { artifact: id, at: after.updatedAt || Date.now(), text: event });
          await storage.set(metaKey(sessionID), next as unknown as Json);
        }
        return { before, after };
      });
    },
    /**
     * Gives an artifact another identifier, its revisions with it. `event`:
     * what to tell the agent, when it did not do it.
     */
    rename(sessionID: string, from: string, to: string, event?: string): Promise<Artifact> {
      return queue(sessionID, async () => {
        const before = await readState(sessionID, from);
        if (!exists(before)) throw new Error(`There is no artifact ${from} in this session.`);
        if (from === to) return before;
        if (exists(await readState(sessionID, to))) throw new Error(`An artifact ${to} already exists in this session.`);
        for (const { key, value } of await scanAll(revisionPrefix(sessionID, from))) {
          const revision = Number(key.slice(revisionPrefix(sessionID, from).length));
          await storage.set(revisionKey(sessionID, to, revision), value as Json);
        }
        const after = { ...before, id: to, seq: before.seq + 1 };
        await storage.set(stateKey(sessionID, to), after as unknown as Json);
        await storage.remove(stateKey(sessionID, from));
        await removeAll(revisionPrefix(sessionID, from));
        // The changes already told stay true under the new name.
        const meta = await readMeta(sessionID);
        const events = meta.events.map((item) => (item.artifact === from ? { ...item, artifact: to } : item));
        const shown = meta.shown === from ? to : meta.shown;
        const renamed: SessionMeta = { ...meta, seq: meta.seq + (shown !== meta.shown ? 1 : 0), events, shown };
        const next = event ? withEvent(renamed, { artifact: to, at: Date.now(), text: event }) : renamed;
        if (event || shown !== meta.shown || events.some((item, index) => item !== meta.events[index])) {
          await storage.set(metaKey(sessionID), next as unknown as Json);
        }
        return after;
      });
    },
    /** Removes one artifact and its revisions. Returns what was removed. */
    remove(sessionID: string, id: string): Promise<Artifact> {
      return queue(sessionID, async () => {
        const before = await readState(sessionID, id);
        await storage.remove(stateKey(sessionID, id));
        await removeAll(revisionPrefix(sessionID, id));
        // Its changes no longer matter to the agent.
        const meta = await readMeta(sessionID);
        const events = meta.events.filter((event) => event.artifact !== id);
        const shown = meta.shown === id ? undefined : meta.shown;
        if (events.length !== meta.events.length || shown !== meta.shown) {
          const next: SessionMeta = { ...meta, seq: meta.seq + 1, events, shown };
          await storage.set(metaKey(sessionID), next as unknown as Json);
        }
        return before;
      });
    },
    /** The artifact the user has open in the panel. Returns the meta, its `seq` moved when it changed. */
    show(sessionID: string, id: string): Promise<SessionMeta> {
      return queue(sessionID, async () => {
        const meta = await readMeta(sessionID);
        if (meta.shown === id || !exists(await readState(sessionID, id))) return meta;
        const next: SessionMeta = { ...meta, seq: meta.seq + 1, shown: id };
        await storage.set(metaKey(sessionID), next as unknown as Json);
        return next;
      });
    },
    /** Removes everything a session left: its artifacts, their revisions and its meta. */
    removeSession(sessionID: string): Promise<void> {
      return queue(sessionID, async () => {
        await removeAll(statePrefix(sessionID));
        await removeAll(`r/${sessionID}/`);
        await storage.remove(metaKey(sessionID));
        await storage.remove(legacyState(sessionID));
        await removeAll(legacyRevisions(sessionID));
        migrated.delete(sessionID);
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
