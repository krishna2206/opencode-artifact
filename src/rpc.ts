// The RPC domain between the server plugin, which owns the artifacts, and the
// TUI panel. The event only says "this artifact changed": the TUI then pulls
// it, so the event never has to carry a document.

import { Rpc } from "@opencode/plugin/rpc";

const session = { sessionID: { type: "string" } } as const;
const target = { ...session, artifact: { type: "string" } } as const;

const artifactSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    revision: { type: "number" },
    latest: { type: "number" },
    title: { type: "string" },
    content: { type: "string" },
    history: {
      type: "array",
      items: {
        type: "object",
        properties: {
          revision: { type: "number" },
          title: { type: "string" },
          by: { type: "string", enum: ["agent", "user"] },
          kind: { type: "string", enum: ["write", "edit", "append", "save"] },
          at: { type: "number" },
          lines: { type: "number" },
        },
        required: ["revision", "title", "by", "kind", "at", "lines"],
      },
    },
    seq: { type: "number" },
    appendable: { type: "boolean" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    updatedBy: { type: "string", enum: ["agent", "user"] },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          quote: { type: "string" },
          note: { type: "string" },
          createdAt: { type: "number" },
        },
        required: ["id", "quote", "note", "createdAt"],
      },
    },
  },
  required: ["id", "revision", "latest", "title", "content", "history", "seq", "appendable", "createdAt", "updatedAt", "updatedBy", "comments"],
} as const;

const summarySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    revision: { type: "number" },
    latest: { type: "number" },
    lines: { type: "number" },
    bytes: { type: "number" },
    comments: { type: "number" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "title", "revision", "latest", "lines", "bytes", "comments", "createdAt", "updatedAt"],
} as const;

const targetInput = { type: "object", properties: target, required: ["sessionID", "artifact"] } as const;

export const ArtifactRpc = Rpc.define({
  id: "opencode-artifact",
  methods: {
    /**
     * The session's artifacts, in the order they were created, and the text of
     * its instruction entry (empty: none).
     */
    list: {
      input: { type: "object", properties: session, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { artifacts: { type: "array", items: summarySchema }, instruction: { type: "string" } },
        required: ["artifacts", "instruction"],
      },
    },
    get: { input: targetInput, output: artifactSchema },
    /** The artifact the panel shows: the agent is told which one the user has open. */
    focus: {
      input: targetInput,
      output: { type: "object", properties: { notice: { type: "number" } }, required: ["notice"] },
    },
    // `base`: the text the user started editing from. The save is refused when
    // the agent changed the document since, rather than overwrite its revision.
    save: {
      input: {
        type: "object",
        properties: { ...target, content: { type: "string" }, base: { type: "string" } },
        required: ["sessionID", "artifact", "content", "base"],
      },
      output: {
        type: "object",
        properties: { saved: { type: "boolean" }, artifact: artifactSchema },
        required: ["saved", "artifact"],
      },
    },
    /** Undo, redo or a jump in the history: moves to another kept revision. */
    switch: {
      input: {
        type: "object",
        properties: { ...target, revision: { type: "number" } },
        required: ["sessionID", "artifact", "revision"],
      },
      output: artifactSchema,
    },
    /** A new identifier, title, or both; empty strings keep them. */
    rename: {
      input: {
        type: "object",
        properties: { ...target, id: { type: "string" }, title: { type: "string" } },
        required: ["sessionID", "artifact", "id", "title"],
      },
      output: artifactSchema,
    },
    comment: {
      input: {
        type: "object",
        properties: { ...target, quote: { type: "string" }, note: { type: "string" } },
        required: ["sessionID", "artifact", "quote", "note"],
      },
      output: artifactSchema,
    },
    uncomment: {
      input: {
        type: "object",
        properties: { ...target, commentID: { type: "string" } },
        required: ["sessionID", "artifact", "commentID"],
      },
      output: artifactSchema,
    },
    // Returns the review message and clears the comments; the TUI sends the
    // message to the session. Empty text: nothing to review.
    submit: {
      input: targetInput,
      output: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  events: {
    // `by`: "agent" for the agent's tools, "user" for the panel, "deleted" once removed,
    // "focus" when the panel shows another artifact (nothing to reload).
    // `previous`: the artifact's former identifier after a rename, else empty.
    // `notice`: counts the changes the agent is told about, for the instruction entry.
    changed: {
      schema: {
        type: "object",
        properties: {
          ...target,
          previous: { type: "string" },
          revision: { type: "number" },
          seq: { type: "number" },
          by: { type: "string" },
          notice: { type: "number" },
        },
        required: ["sessionID", "artifact", "previous", "revision", "seq", "by", "notice"],
      },
    },
  },
} as const);
