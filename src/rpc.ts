// The RPC domain between the server plugin, which owns the artifacts, and the
// TUI panel. The event only says "this session's artifact changed": the TUI
// then pulls it, so the event never has to carry the document.

import { Rpc } from "@opencode/plugin/rpc";

const session = { sessionID: { type: "string" } } as const;

const artifactSchema = {
  type: "object",
  properties: {
    revision: { type: "number" },
    title: { type: "string" },
    content: { type: "string" },
    updatedAt: { type: "number" },
    updatedBy: { type: "string", enum: ["agent", "user"] },
    editedByUser: { type: "boolean" },
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
  required: ["revision", "title", "content", "updatedAt", "updatedBy", "editedByUser", "comments"],
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
    changed: {
      schema: {
        type: "object",
        properties: { ...session, revision: { type: "number" }, by: { type: "string" } },
        required: ["sessionID", "revision", "by"],
      },
    },
  },
} as const);
