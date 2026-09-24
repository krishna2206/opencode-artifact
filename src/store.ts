// Artifacts live in opencode's own durable key-value storage, which the host
// scopes to this plugin. Nothing lands in the user's repositories.

import type { Plugin } from "@opencode/plugin";
import { EMPTY_ARTIFACT, type Artifact } from "./artifact.js";

type Storage = Plugin.Context["storage"];

const key = (sessionID: string) => `session/${sessionID}`;

function isArtifact(value: unknown): value is Artifact {
  const artifact = value as Artifact | undefined;
  return typeof artifact?.revision === "number" && typeof artifact.content === "string" && Array.isArray(artifact.comments);
}

export function createStore(storage: Storage) {
  // Writes to one session run one after another: the agent's tool calls and
  // the user's comments must not read the same revision and overwrite each other.
  const queues = new Map<string, Promise<unknown>>();

  const read = async (sessionID: string): Promise<Artifact> => {
    const value = await storage.get(key(sessionID));
    return isArtifact(value) ? { ...EMPTY_ARTIFACT, ...(value as Artifact) } : EMPTY_ARTIFACT;
  };

  return {
    read,
    /** Applies `change` to the stored artifact and saves the result when it differs. */
    update(sessionID: string, change: (artifact: Artifact) => Artifact): Promise<{ before: Artifact; after: Artifact }> {
      const run = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const before = await read(sessionID);
        const after = change(before);
        if (after !== before) {
          await storage.set(key(sessionID), after as unknown as Parameters<Storage["set"]>[1]);
        }
        return { before, after };
      });
      queues.set(sessionID, run);
      return run;
    },
    /** Removes the session's artifact, after the writes already queued. Returns what was removed. */
    remove(sessionID: string): Promise<Artifact> {
      const run = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const before = await read(sessionID);
        await storage.remove(key(sessionID));
        return before;
      });
      queues.set(sessionID, run);
      return run;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
