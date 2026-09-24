// opencode-artifact: server side.
//
// Gives the agent a Markdown document per session, the artifact, that the user
// reviews in a side panel of the TUI instead of scrolling back through the
// chat. The agent writes it with tools and keeps its chat replies short; the
// user edits or comments it and sends the review back as one message.

import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import {
  addComment,
  agentEdit,
  agentWrite,
  clearReview,
  exists,
  hasReview,
  removeComment,
  renderForModel,
  reviewMessage,
  userSave,
  type Artifact,
} from "./artifact.js";
import { ArtifactRpc } from "./rpc.js";
import { createStore } from "./store.js";
import { isNotFound, sweepOrphans } from "./sweep.js";

const TOOLS = ["artifact_write", "artifact_edit", "artifact_read", "artifact_delete"];

const WRITE_DESCRIPTION = [
  "Write the session's artifact: a Markdown document the user reads, edits and comments in a panel next to the chat.",
  "Use it for long structured content the user should review and iterate on (a plan, a spec, a design, a report),",
  "instead of putting that content in your reply: once written, reply in one or two sentences and let the user review it.",
  "Replaces the whole document. For a targeted change, use artifact_edit.",
  "Images show in the panel when written as their own paragraph, ![caption](source), with a path relative to the project,",
  "an absolute path or an http(s) URL (PNG, JPEG, WebP or GIF).",
].join(" ");

const EDIT_DESCRIPTION = [
  "Replace one passage of the session's artifact. edit.old_string must match the current text exactly and appear once,",
  "unless replace_all is set. Read the artifact first if the user may have edited it.",
].join(" ");

const READ_DESCRIPTION = "Read the session's artifact as it is now, including the user's own edits.";

// Deletion cannot be undone and takes the user's unsent comments with it: the
// description restricts it to an explicit request, and the tool makes the
// agent quote that request, which the chat shows next to the call.
const DELETE_DESCRIPTION = [
  "Delete the session's artifact for good, with the comments the user has not sent yet. It cannot be undone.",
  "Only call it when the user explicitly asks to delete or discard the artifact, in their latest message.",
  "Never call it on your own initiative: not to start over, not to write a different document, not to clean up",
  "at the end of a task. To replace the content, use artifact_write; to change part of it, use artifact_edit.",
].join(" ");

const DeleteInput = Schema.Struct({
  request: Schema.String.annotate({
    description: "The user's words asking for the deletion, quoted from their message",
  }),
});

// The text goes in a nested object: the TUI's summary of a tool call shows
// only top-level plain values, so the chat shows `artifact_write [title=…]`
// instead of the whole document the panel already shows.
const WriteInput = Schema.Struct({
  title: Schema.optional(Schema.String.annotate({ description: "Short title, kept from the previous write when omitted" })),
  document: Schema.Struct({
    content: Schema.String.annotate({ description: "The complete Markdown document" }),
  }),
});

const EditInput = Schema.Struct({
  edit: Schema.Struct({
    old_string: Schema.String.annotate({ description: "The exact text to replace" }),
    new_string: Schema.String.annotate({ description: "The replacement text" }),
  }),
  replace_all: Schema.optional(Schema.Boolean.annotate({ description: "Replace every occurrence" })),
});

// Schema.Struct({}) emits { anyOf: [{type:"object"},{type:"array"}] }, which has
// no top-level `type` and Anthropic rejects outright ("input_schema.type: Field
// required"). A no-argument tool states its JSON Schema directly.
const ReadInput = { type: "object", properties: {}, additionalProperties: false } as const;

const sessionOf = (input: unknown): string => {
  const sessionID = (input as { sessionID?: unknown } | undefined)?.sessionID;
  if (typeof sessionID !== "string") throw new Error("sessionID is required");
  return sessionID;
};

const stringOf = (input: unknown, field: string): string => {
  const value = (input as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
};

export default Plugin.define({
  id: "opencode-artifact",
  setup: async (ctx) => {
    const store = createStore(ctx.storage);
    // `deleted`: the panel goes back to its empty state, without opening itself as for an agent's write.
    let emit: (sessionID: string, artifact: Artifact, by: "agent" | "user" | "deleted") => Promise<void> = async () => {};

    const rpc = await ctx.rpc.register(ArtifactRpc, {
      // The host types RPC input as unknown: check it rather than trust it.
      get: async (input) => store.read(sessionOf(input)),
      save: async (input) => {
        const sessionID = sessionOf(input);
        const content = stringOf(input, "content");
        const base = stringOf(input, "base");
        let saved = false;
        const { before, after } = await store.update(sessionID, (artifact) => {
          if (artifact.content !== base) return artifact;
          saved = true;
          return userSave(artifact, content, Date.now());
        });
        if (after !== before) await emit(sessionID, after, "user");
        return { saved, artifact: after };
      },
      comment: async (input) => {
        const sessionID = sessionOf(input);
        const { after } = await store.update(sessionID, (artifact) =>
          addComment(artifact, stringOf(input, "quote"), stringOf(input, "note"), Date.now()),
        );
        await emit(sessionID, after, "user");
        return after;
      },
      uncomment: async (input) => {
        const sessionID = sessionOf(input);
        const { before, after } = await store.update(sessionID, (artifact) =>
          removeComment(artifact, stringOf(input, "commentID")),
        );
        if (after !== before) await emit(sessionID, after, "user");
        return after;
      },
      submit: async (input) => {
        const sessionID = sessionOf(input);
        let text = "";
        const { before, after } = await store.update(sessionID, (artifact) => {
          if (!hasReview(artifact)) return artifact;
          text = reviewMessage(artifact);
          return clearReview(artifact);
        });
        if (after !== before) await emit(sessionID, after, "user");
        return { text };
      },
    });

    emit = async (sessionID, artifact, by) => {
      await rpc.events.emit("changed", { sessionID, revision: artifact.revision, by });
    };

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "artifact_write",
        options: { codemode: false },
        description: WRITE_DESCRIPTION,
        input: WriteInput,
        execute: async (input, context) => {
          const { after } = await store.update(context.sessionID, (artifact) =>
            agentWrite(artifact, input.title, input.document.content, Date.now()),
          );
          await emit(context.sessionID, after, "agent");
          return {
            content: `Artifact "${after.title}" written (revision ${after.revision}). The user sees it in the artifact panel.`,
            metadata: { revision: after.revision },
          };
        },
      });
      tools.add({
        name: "artifact_edit",
        options: { codemode: false },
        description: EDIT_DESCRIPTION,
        input: EditInput,
        execute: async (input, context) => {
          const { after } = await store.update(context.sessionID, (artifact) =>
            agentEdit(artifact, input.edit.old_string, input.edit.new_string, input.replace_all === true, Date.now()),
          );
          await emit(context.sessionID, after, "agent");
          return {
            content: `Artifact "${after.title}" edited (revision ${after.revision}).`,
            metadata: { revision: after.revision },
          };
        },
      });
      tools.add({
        name: "artifact_read",
        options: { codemode: false },
        description: READ_DESCRIPTION,
        input: ReadInput,
        execute: async (_input, context) => {
          const artifact = await store.read(context.sessionID);
          return { content: renderForModel(artifact), metadata: { revision: artifact.revision } };
        },
      });
      tools.add({
        name: "artifact_delete",
        options: { codemode: false },
        description: DELETE_DESCRIPTION,
        input: DeleteInput,
        execute: async (input, context) => {
          if (!input.request.trim()) throw new Error("Quote the user's request to delete the artifact in `request`.");
          const removed = await store.remove(context.sessionID);
          if (!exists(removed)) return { content: "This session has no artifact: nothing to delete.", metadata: {} };
          await emit(context.sessionID, { ...removed, revision: 0 }, "deleted");
          const unsent = removed.comments.length;
          return {
            content: `Artifact "${removed.title}" deleted${unsent > 0 ? `, with ${unsent} unsent comment${unsent > 1 ? "s" : ""}` : ""}.`,
            metadata: { title: removed.title },
          };
        },
      });
    });

    // After a compaction the agent may no longer know the session has an
    // artifact. A one-line reminder then, and only then, so the system prompt
    // stays stable from turn to turn while the tool calls are in context.
    await ctx.session.hook("context", async (event) => {
      const seen = event.messages.some((message) =>
        message.content.some((part) => part.type === "tool-call" && TOOLS.includes(part.name)),
      );
      if (seen) return;
      const artifact = await store.read(event.sessionID);
      if (!exists(artifact)) return;
      event.system.push({
        type: "text",
        text: `# Session artifact\nThis session has an artifact, "${artifact.title}" (revision ${artifact.revision}). Read it with artifact_read before changing it.`,
      });
    });

    // Artifacts left behind by sessions deleted while this plugin was not running.
    const sessionExists = async (sessionID: string) => {
      try {
        await ctx.session.get({ sessionID });
        return true;
      } catch (error) {
        return !isNotFound(error);
      }
    };
    void sweepOrphans(ctx.storage, sessionExists, Date.now()).catch(() => {});

    // A deleted session's artifact goes with it.
    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          if (event.type === "session.deleted") await store.remove(event.data.sessionID).catch(() => {});
        }
      } catch {
        // Aborted on cleanup, or the stream ended.
      }
    })();

    return () => stop.abort();
  },
});
