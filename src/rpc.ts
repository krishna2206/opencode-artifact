// The RPC domain between the server plugin, which owns the artifacts, and the
// TUI panel. The event only says "this session's artifact changed": the TUI
// then pulls it, so the event never has to carry the document.

import { Rpc } from "@opencode/plugin/rpc";

const session = { sessionID: { type: "string" } } as const;

const artifactSchema = {
  type: "object",
  properties: {
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
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { at: { type: "number" }, text: { type: "string" } },
        required: ["at", "text"],
      },
    },
  },
  required: ["revision", "latest", "title", "content", "history", "seq", "appendable", "updatedAt", "updatedBy", "comments", "events"],
} as const;

export const ArtifactRpc = Rpc.define({
  id: "opencode-artifact",
  methods: {
    get: {
      input: { type: "object", properties: session, required: ["sessionID"] },
      output: artifactSchema,
    },
    // `base`: the text the user started editing from. The save is refused when
    // the agent changed the document since, rather than overwrite its revision.
    save: {
      input: {
        type: "object",
        properties: { ...session, content: { type: "string" }, base: { type: "string" } },
        required: ["sessionID", "content", "base"],
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
        properties: { ...session, revision: { type: "number" } },
        required: ["sessionID", "revision"],
      },
      output: artifactSchema,
    },
    comment: {
      input: {
        type: "object",
        properties: { ...session, quote: { type: "string" }, note: { type: "string" } },
        required: ["sessionID", "quote", "note"],
      },
      output: artifactSchema,
    },
    uncomment: {
      input: {
        type: "object",
        properties: { ...session, commentID: { type: "string" } },
        required: ["sessionID", "commentID"],
      },
      output: artifactSchema,
    },
    // Returns the review message and clears the comments; the TUI sends the
    // message to the session. Empty text: nothing to review.
    submit: {
      input: { type: "object", properties: session, required: ["sessionID"] },
      output: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  events: {
    // `by`: "agent" for the agent's tools, "user" for the panel, "deleted" once removed.
    // `notice`: when the last change the agent must be told about happened, 0 for none.
    changed: {
      schema: {
        type: "object",
        properties: {
          ...session,
          revision: { type: "number" },
          seq: { type: "number" },
          by: { type: "string" },
          notice: { type: "number" },
        },
        required: ["sessionID", "revision", "seq", "by", "notice"],
      },
    },
  },
} as const);
