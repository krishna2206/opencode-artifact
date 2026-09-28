// opencode-artifact: server side.
//
// Gives the agent a Markdown document per session, the artifact, that the user
// reviews in a side panel of the TUI instead of scrolling back through the
// chat. The agent writes it with tools and keeps its chat replies short; the
// user edits or comments it and sends the review back as one message. Each
// change is a revision: the user and the agent can undo and redo them.

import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import {
  addComment,
  agentEdit,
  agentWrite,
  checkBase,
  clearReview,
  DEFAULT_MAX_REVISIONS,
  exists,
  hasReview,
  removeComment,
  renderForModel,
  replacedRedo,
  reviewMessage,
  switchProblem,
  switchResult,
  switchTo,
  userSave,
  type Artifact,
} from "./artifact.js";
import { ArtifactRpc } from "./rpc.js";
import { createStore } from "./store.js";
import { isNotFound, sweepOrphans } from "./sweep.js";

const TOOLS = ["artifact_write", "artifact_edit", "artifact_read", "artifact_switch", "artifact_delete"];

const REVISIONS = [
  "Each change is a revision the user can undo and redo, and so can you with artifact_switch.",
  "A write or edit starts from the current revision and replaces the revisions after it, kept for redo.",
].join(" ");

const BASE_REVISION = "The revision you last read or wrote. The change is refused if the artifact is on another revision now (the user undid, redid or edited it)";

const WRITE_DESCRIPTION = [
  "Write the session's artifact: a Markdown document the user reads, edits and comments in a panel next to the chat.",
  "Use it for long structured content the user should review and iterate on (a plan, a spec, a design, a report),",
  "instead of putting that content in your reply: once written, reply in one or two sentences and let the user review it.",
  "Replaces the whole document. For a targeted change, use artifact_edit. For a long document, write it in parts:",
  'the first with mode "replace", the next ones with mode "append", which adds to the end of the text.',
  REVISIONS,
  "Images show in the panel when written as their own paragraph, ![caption](source), with a path relative to the project,",
  "an absolute path or an http(s) URL (PNG, JPEG, WebP or GIF).",
].join(" ");

const EDIT_DESCRIPTION = [
  "Replace one passage of the session's artifact. edit.old_string must match the current text exactly and appear once,",
  "unless replace_all is set. Read the artifact first if the user may have edited it.",
  REVISIONS,
].join(" ");

const READ_DESCRIPTION = [
  "Read the session's artifact as it is now, including the user's own edits, or another of its revisions.",
  "A long revision comes a page at a time: continue with the offset given at the end.",
].join(" ");

const SWITCH_DESCRIPTION = [
  "Move the session's artifact to another of its revisions, to undo or redo changes, when the user asks for an earlier",
  "or later version. Nothing is changed or lost: the revisions after the one you move to stay available for redo",
  "until the next write or edit, which starts from it and replaces them.",
].join(" ");

// Deletion cannot be undone and takes the user's unsent comments with it: the
// description restricts it to an explicit request, and the tool makes the
// agent quote that request, which the chat shows next to the call.
const DELETE_DESCRIPTION = [
  "Delete the session's artifact for good, with its revisions and the comments the user has not sent yet. It cannot be undone.",
  "Only call it when the user explicitly asks to delete or discard the artifact, in their latest message.",
  "Never call it on your own initiative: not to start over, not to write a different document, not to clean up",
  "at the end of a task. To replace the content, use artifact_write; to change part of it, use artifact_edit;",
  "to come back to an earlier version, use artifact_switch.",
].join(" ");

// Plain numbers and strings, checked in the tools: a refined schema (Int,
// Literals) fails inside the host, which decodes with its own copy of effect.
const Revision = Schema.Number;

/** A whole number from 1, or undefined when the field is left out. */
function positive(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a whole number from 1.`);
  return value;
}

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
  mode: Schema.optional(
    Schema.String.annotate({
      description: 'replace (default): the whole document. append: add to the end of the current text',
    }),
  ),
  base_revision: Schema.optional(Revision.annotate({ description: BASE_REVISION })),
  document: Schema.Struct({
    content: Schema.String.annotate({ description: "The Markdown document, or the part to append" }),
  }),
});

const EditInput = Schema.Struct({
  base_revision: Schema.optional(Revision.annotate({ description: BASE_REVISION })),
  edit: Schema.Struct({
    old_string: Schema.String.annotate({ description: "The exact text to replace" }),
    new_string: Schema.String.annotate({ description: "The replacement text" }),
  }),
  replace_all: Schema.optional(Schema.Boolean.annotate({ description: "Replace every occurrence" })),
});

const ReadInput = Schema.Struct({
  revision: Schema.optional(Revision.annotate({ description: "Another revision to read, without moving to it. Default: the current one" })),
  offset: Schema.optional(Revision.annotate({ description: "The line to start from, counting from 1" })),
  limit: Schema.optional(Revision.annotate({ description: "The most lines to read" })),
});

const SwitchInput = Schema.Struct({
  revision: Revision.annotate({ description: "The revision to move to" }),
});

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

const numberOf = (input: unknown, field: string): number => {
  const value = (input as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${field} is required`);
  return value;
};

export default Plugin.define({
  id: "opencode-artifact",
  setup: async (ctx) => {
    const store = createStore(ctx.storage);
    const configured = ctx.options.maxRevisions;
    const maxRevisions = typeof configured === "number" && configured >= 2 ? Math.floor(configured) : DEFAULT_MAX_REVISIONS;
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
          return userSave(artifact, content, Date.now(), maxRevisions);
        });
        if (after !== before) await emit(sessionID, after, "user");
        return { saved, artifact: after };
      },
      switch: async (input) => {
        const sessionID = sessionOf(input);
        const revision = numberOf(input, "revision");
        const { before, after } = await store.update(sessionID, async (artifact, revisions) => {
          if (switchProblem(artifact, revision)) return artifact;
          return switchTo(artifact, revision, await revisions.get(revision), "user", Date.now());
        });
        if (after !== before) await emit(sessionID, after, "user");
        return after;
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
      const notice = artifact.events.at(-1)?.at ?? 0;
      await rpc.events.emit("changed", { sessionID, revision: artifact.revision, seq: artifact.seq, by, notice });
    };

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "artifact_write",
        options: { codemode: false },
        description: WRITE_DESCRIPTION,
        input: WriteInput,
        execute: async (input, context) => {
          if (input.mode !== undefined && input.mode !== "replace" && input.mode !== "append") {
            throw new Error('mode must be "replace" or "append".');
          }
          const append = input.mode === "append";
          const base = positive(input.base_revision, "base_revision");
          const { before, after } = await store.update(context.sessionID, (artifact) => {
            checkBase(artifact, base);
            return agentWrite(artifact, input.title, input.document.content, Date.now(), { append, maxRevisions });
          });
          if (after !== before) await emit(context.sessionID, after, "agent");
          const replaced = after.revision !== before.revision ? replacedRedo(before) : "";
          const lines = after.content.split("\n").length;
          const what = append && after.revision === before.revision ? "appended to" : append ? "appended as" : "written as";
          return {
            content: `Artifact "${after.title}" ${what} revision ${after.revision} (${lines} lines). The user sees it in the artifact panel.${replaced}`,
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
          const base = positive(input.base_revision, "base_revision");
          const { before, after } = await store.update(context.sessionID, (artifact) => {
            checkBase(artifact, base);
            return agentEdit(artifact, input.edit.old_string, input.edit.new_string, input.replace_all === true, Date.now(), maxRevisions);
          });
          if (after !== before) await emit(context.sessionID, after, "agent");
          const replaced = after.revision !== before.revision ? replacedRedo(before) : "";
          return {
            content: `Artifact "${after.title}" edited: revision ${after.revision}.${replaced}`,
            metadata: { revision: after.revision },
          };
        },
      });
      tools.add({
        name: "artifact_read",
        options: { codemode: false },
        description: READ_DESCRIPTION,
        input: ReadInput,
        execute: async (input, context) => {
          const artifact = await store.read(context.sessionID);
          const revision = positive(input.revision, "revision") ?? artifact.revision;
          const offset = positive(input.offset, "offset");
          const limit = positive(input.limit, "limit");
          if (exists(artifact) && revision !== artifact.revision) {
            const problem = switchProblem(artifact, revision);
            if (problem) throw new Error(problem);
          }
          const snapshot = exists(artifact) ? { ...(await store.revision(context.sessionID, revision)), revision } : undefined;
          return {
            content: renderForModel(artifact, snapshot, { offset, limit }),
            // Paged here, below opencode's own limits: its truncation would hide the rest of the page count.
            metadata: { revision: artifact.revision, truncated: false },
          };
        },
      });
      tools.add({
        name: "artifact_switch",
        options: { codemode: false },
        description: SWITCH_DESCRIPTION,
        input: SwitchInput,
        execute: async (input, context) => {
          const target = positive(input.revision, "revision")!;
          const { before, after } = await store.update(context.sessionID, async (artifact, revisions) => {
            const problem = switchProblem(artifact, target);
            if (problem) throw new Error(problem);
            return switchTo(artifact, target, await revisions.get(target), "agent", Date.now());
          });
          if (after !== before) await emit(context.sessionID, after, "agent");
          return { content: switchResult(after), metadata: { revision: after.revision } };
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
          await emit(context.sessionID, { ...removed, revision: 0, seq: removed.seq + 1 }, "deleted");
          const unsent = removed.comments.length;
          return {
            content: `Artifact "${removed.title}" deleted with its revisions${unsent > 0 ? ` and ${unsent} unsent comment${unsent > 1 ? "s" : ""}` : ""}.`,
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
        text: `# Session artifact\nThis session has an artifact, "${artifact.title}" (revision ${artifact.revision} of ${artifact.latest}). Read it with artifact_read before changing it.`,
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
    void sweepOrphans(ctx.storage, sessionExists, Date.now(), (sessionID) => store.remove(sessionID)).catch(() => {});

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
