// opencode-artifact: server side.
//
// Gives the agent Markdown documents per session, the artifacts, that the
// user reviews in a side panel of the TUI instead of scrolling back through
// the chat. The agent writes them with tools and keeps its chat replies short;
// the user edits or comments them and sends the review back as one message.
// Each change is a revision: the user and the agent can undo and redo them.

import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import {
  addComment,
  agentEdit,
  agentWrite,
  byCreation,
  checkBase,
  checkId,
  clearReview,
  DEFAULT_MAX_REVISIONS,
  exists,
  hasReview,
  instructionText,
  listText,
  removeComment,
  renderForModel,
  replacedRedo,
  retitle,
  reviewMessage,
  slugify,
  summarize,
  switchProblem,
  switchResult,
  switchTo,
  uniqueId,
  userSave,
  type Artifact,
  type Edit,
} from "./artifact.js";
import { ArtifactRpc } from "./rpc.js";
import { createStore, SESSION_PREFIXES } from "./store.js";
import { isNotFound, sweepOrphans } from "./sweep.js";

const TOOLS = [
  "artifact_write",
  "artifact_edit",
  "artifact_read",
  "artifact_list",
  "artifact_switch",
  "artifact_rename",
  "artifact_delete",
];

const REVISIONS = [
  "Each change is a revision the user can undo and redo, and so can you with artifact_switch.",
  "A write or edit starts from the current revision and replaces the revisions after it, kept for redo.",
].join(" ");

const ARTIFACT =
  "The artifact's identifier, like lot-1 (lowercase letters, digits, - _ .). Required when the session has several artifacts; artifact_list lists them";

const BASE_REVISION =
  "The revision you last read or wrote. The change is refused if the artifact is on another revision now (the user undid, redid or edited it)";

const WRITE_DESCRIPTION = [
  "Write one of the session's artifacts: Markdown documents the user reads, edits and comments in a panel next to the chat.",
  "Use them for long structured content the user should review and iterate on (a plan, a spec, a design, a report, a decision log),",
  "instead of putting that content in your reply: once written, reply in one or two sentences and let the user review it.",
  "A session can hold several artifacts, one per subject: a new identifier in `artifact` creates one.",
  "Replaces the whole document. For targeted changes, use artifact_edit. For a long document, write it in parts:",
  'the first with mode "replace", the next ones with mode "append", which adds to the end of the text.',
  REVISIONS,
  "Images show in the panel when written as their own paragraph, ![caption](source), with a path relative to the project,",
  "an absolute path or an http(s) URL (PNG, JPEG, WebP or GIF).",
].join(" ");

const EDIT_DESCRIPTION = [
  "Replace passages of one of the session's artifacts. Put every change of one revision in a single call: the edits",
  "apply in order, each one to the text the edits before it left, and together make one revision, all or none.",
  "Each old_string must match the text exactly and appear once, unless replace_all is set.",
  "Read the artifact first if the user may have edited it.",
  REVISIONS,
].join(" ");

const READ_DESCRIPTION = [
  "Read one of the session's artifacts as it is now, including the user's own edits, or another of its revisions.",
  "A long revision comes a page at a time: continue with the offset given at the end.",
].join(" ");

const LIST_DESCRIPTION =
  "List the session's artifacts: identifier, title, revision, size, unsent comments and last change. Their text is not included.";

const SWITCH_DESCRIPTION = [
  "Move one of the session's artifacts to another of its revisions, to undo or redo changes, when the user asks for an",
  "earlier or later version. Nothing is changed or lost: the revisions after the one you move to stay available for redo",
  "until the next write or edit, which starts from it and replaces them.",
].join(" ");

const RENAME_DESCRIPTION = [
  "Give one of the session's artifacts a new identifier, a new title, or both, without changing its text.",
  "It makes no revision: undo and redo keep the new names.",
].join(" ");

// Deletion cannot be undone and takes the user's unsent comments with it: the
// description restricts it to an explicit request, and the tool makes the
// agent quote that request, which the chat shows next to the call.
const DELETE_DESCRIPTION = [
  "Delete one of the session's artifacts for good, with its revisions and the comments the user has not sent yet.",
  "It cannot be undone. Only call it when the user explicitly asks to delete or discard that artifact, in their latest message.",
  "Never call it on your own initiative: not to start over, not to write a different document, not to clean up",
  "at the end of a task. To replace the content, use artifact_write; to change part of it, use artifact_edit;",
  "to come back to an earlier version, use artifact_switch; to rename it, use artifact_rename.",
].join(" ");

// Plain numbers and strings, checked in the tools: a refined schema (Int,
// Literals) fails inside the host, which decodes with its own copy of effect.
const Revision = Schema.Number;
const ArtifactId = Schema.optional(Schema.String.annotate({ description: ARTIFACT }));

/** A whole number from 1, or undefined when the field is left out. */
function positive(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a whole number from 1.`);
  return value;
}

const DeleteInput = Schema.Struct({
  artifact: ArtifactId,
  request: Schema.String.annotate({
    description: "The user's words asking for the deletion, quoted from their message",
  }),
});

// The text goes in a nested object or a list: the TUI's summary of a tool
// call shows only top-level plain values, so the chat shows
// `artifact_write [artifact=…, title=…]` instead of the document the panel
// already shows.
const WriteInput = Schema.Struct({
  artifact: ArtifactId,
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
  artifact: ArtifactId,
  base_revision: Schema.optional(Revision.annotate({ description: BASE_REVISION })),
  edits: Schema.Array(
    Schema.Struct({
      old_string: Schema.String.annotate({ description: "The exact text to replace" }),
      new_string: Schema.String.annotate({ description: "The replacement text" }),
      replace_all: Schema.optional(Schema.Boolean.annotate({ description: "Replace every occurrence" })),
    }),
  ).annotate({ description: "The replacements, applied in order. All of them make one revision" }),
});

const ReadInput = Schema.Struct({
  artifact: ArtifactId,
  revision: Schema.optional(Revision.annotate({ description: "Another revision to read, without moving to it. Default: the current one" })),
  offset: Schema.optional(Revision.annotate({ description: "The line to start from, counting from 1" })),
  limit: Schema.optional(Revision.annotate({ description: "The most lines to read" })),
});

// Schema.Struct({}) emits { anyOf: [{type:"object"},{type:"array"}] }, which has
// no top-level `type` and Anthropic rejects outright ("input_schema.type: Field
// required"). A no-argument tool states its JSON Schema directly.
const ListInput = { type: "object", properties: {}, additionalProperties: false } as const;

const SwitchInput = Schema.Struct({
  artifact: ArtifactId,
  revision: Revision.annotate({ description: "The revision to move to" }),
});

const RenameInput = Schema.Struct({
  artifact: ArtifactId,
  id: Schema.optional(Schema.String.annotate({ description: "The new identifier" })),
  title: Schema.optional(Schema.String.annotate({ description: "The new title" })),
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

type By = "agent" | "user" | "deleted" | "focus";

export default Plugin.define({
  id: "opencode-artifact",
  setup: async (ctx) => {
    const store = createStore(ctx.storage);
    const configured = ctx.options.maxRevisions;
    const maxRevisions = typeof configured === "number" && configured >= 2 ? Math.floor(configured) : DEFAULT_MAX_REVISIONS;
    // `deleted`: the panel moves to another artifact, without opening itself as for an agent's write.
    let emit: (sessionID: string, artifact: Artifact, by: By, previous?: string) => Promise<void> = async () => {};

    const available = (artifacts: readonly Artifact[], shown?: string) => {
      if (artifacts.length === 0) return "This session has no artifact yet: create one with artifact_write.";
      const ids = artifacts.map(summarize).sort(byCreation).map((summary) => summary.id).join(", ");
      const open = shown && artifacts.some((artifact) => artifact.id === shown) ? ` The user has ${shown} open in the artifact panel.` : "";
      return `The artifacts of this session: ${ids}.${open}`;
    };

    /**
     * The artifact a tool call is about. Left out, it is the only one; with
     * several, the agent must say which. `create`: a new identifier is fine
     * (artifact_write), and one comes from the title when it is left out.
     */
    const resolve = async (sessionID: string, requested: string | undefined, create?: { title?: string }) => {
      const artifacts = await store.list(sessionID);
      if (requested !== undefined && requested.trim() !== "") {
        const id = checkId(requested.trim());
        if (create || artifacts.some((artifact) => artifact.id === id)) return id;
        throw new Error(`There is no artifact ${id} in this session. ${available(artifacts)}`);
      }
      if (artifacts.length === 1) return artifacts[0]!.id;
      if (artifacts.length === 0) {
        if (create) return uniqueId(slugify(create.title ?? "artifact"), new Set());
        throw new Error(available(artifacts));
      }
      const { shown } = await store.meta(sessionID);
      throw new Error(`This session has ${artifacts.length} artifacts: say which one in \`artifact\`. ${available(artifacts, shown)}`);
    };

    /** A new identifier and title from the panel or the agent; the agent is told when the user did it. */
    const rename = async (sessionID: string, from: string, id: string, title: string, by: "agent" | "user") => {
      const to = id.trim() ? checkId(id.trim()) : from;
      let artifact = await store.read(sessionID, from);
      if (!exists(artifact)) throw new Error(`There is no artifact ${from} in this session.`);
      const told: string[] = [];
      if (to !== from) {
        artifact = await store.rename(sessionID, from, to, by === "user" ? `the user renamed the artifact ${from} to ${to}.` : undefined);
        told.push(`renamed to ${to}`);
      }
      if (title.trim() && title.trim() !== artifact.title) {
        const newTitle = title.trim();
        const { after } = await store.update(sessionID, to, (current) => ({
          artifact: retitle(current, newTitle),
          drop: [],
          event: by === "user" ? `the user retitled the artifact "${newTitle}".` : undefined,
        }));
        artifact = after;
        told.push(`retitled "${newTitle}"`);
      }
      if (told.length > 0) await emit(sessionID, artifact, by, from);
      return { artifact, told };
    };

    const rpc = await ctx.rpc.register(ArtifactRpc, {
      // The host types RPC input as unknown: check it rather than trust it.
      list: async (input) => {
        const sessionID = sessionOf(input);
        const all = await store.list(sessionID);
        const meta = await store.meta(sessionID);
        const shown = all.find((artifact) => artifact.id === meta.shown);
        return { artifacts: all.map(summarize).sort(byCreation), instruction: instructionText(meta, shown) ?? "" };
      },
      focus: async (input) => {
        const sessionID = sessionOf(input);
        const before = (await store.meta(sessionID)).seq;
        const meta = await store.show(sessionID, stringOf(input, "artifact"));
        if (meta.seq !== before) {
          const artifact = await store.read(sessionID, stringOf(input, "artifact"));
          await emit(sessionID, artifact, "focus");
        }
        return { notice: meta.seq };
      },
      get: async (input) => store.read(sessionOf(input), stringOf(input, "artifact")),
      save: async (input) => {
        const sessionID = sessionOf(input);
        const content = stringOf(input, "content");
        const base = stringOf(input, "base");
        let saved = false;
        const { before, after } = await store.update(sessionID, stringOf(input, "artifact"), (artifact) => {
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
        const { before, after } = await store.update(sessionID, stringOf(input, "artifact"), async (artifact, context) => {
          if (switchProblem(artifact, revision)) return artifact;
          return switchTo(artifact, revision, await context.revision(revision), "user", Date.now());
        });
        if (after !== before) await emit(sessionID, after, "user");
        return after;
      },
      rename: async (input) => {
        const sessionID = sessionOf(input);
        const result = await rename(sessionID, stringOf(input, "artifact"), stringOf(input, "id"), stringOf(input, "title"), "user");
        return result.artifact;
      },
      comment: async (input) => {
        const sessionID = sessionOf(input);
        const { after } = await store.update(sessionID, stringOf(input, "artifact"), (artifact) =>
          addComment(artifact, stringOf(input, "quote"), stringOf(input, "note"), Date.now()),
        );
        await emit(sessionID, after, "user");
        return after;
      },
      uncomment: async (input) => {
        const sessionID = sessionOf(input);
        const { before, after } = await store.update(sessionID, stringOf(input, "artifact"), (artifact) =>
          removeComment(artifact, stringOf(input, "commentID")),
        );
        if (after !== before) await emit(sessionID, after, "user");
        return after;
      },
      submit: async (input) => {
        const sessionID = sessionOf(input);
        let text = "";
        const { before, after } = await store.update(sessionID, stringOf(input, "artifact"), (artifact) => {
          if (!hasReview(artifact)) return artifact;
          text = reviewMessage(artifact);
          return clearReview(artifact);
        });
        if (after !== before) await emit(sessionID, after, "user");
        return { text };
      },
    });

    emit = async (sessionID, artifact, by, previous = "") => {
      const notice = (await store.meta(sessionID)).seq;
      await rpc.events.emit("changed", {
        sessionID,
        artifact: artifact.id,
        previous: previous === artifact.id ? "" : previous,
        revision: artifact.revision,
        seq: artifact.seq,
        by,
        notice,
      });
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
          const id = await resolve(context.sessionID, input.artifact, { title: input.title });
          const { before, after } = await store.update(context.sessionID, id, (artifact, { lastEvent }) => {
            checkBase(artifact, base, lastEvent);
            return agentWrite(artifact, input.title, input.document.content, Date.now(), { append, maxRevisions });
          });
          if (after !== before) await emit(context.sessionID, after, "agent");
          const replaced = after.revision !== before.revision ? replacedRedo(before) : "";
          const lines = after.content.split("\n").length;
          const what = !exists(before) ? "created as" : append && after.revision === before.revision ? "appended to" : append ? "appended as" : "written as";
          return {
            content: `Artifact ${id} ("${after.title}") ${what} revision ${after.revision} (${lines} lines). The user sees it in the artifact panel.${replaced}`,
            metadata: { artifact: id, revision: after.revision },
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
          const id = await resolve(context.sessionID, input.artifact);
          const edits: Edit[] = input.edits.map((edit) => ({ ...edit }));
          const { before, after } = await store.update(context.sessionID, id, (artifact, { lastEvent }) => {
            checkBase(artifact, base, lastEvent);
            return agentEdit(artifact, edits, Date.now(), maxRevisions);
          });
          if (after !== before) await emit(context.sessionID, after, "agent");
          const count = edits.length;
          const result =
            after === before
              ? `Artifact ${id} unchanged: the ${count === 1 ? "edit leaves" : `${count} edits leave`} the text as it was (revision ${after.revision}).`
              : `Artifact ${id} edited (${count} replacement${count > 1 ? "s" : ""}): revision ${after.revision}.${replacedRedo(before)}`;
          return { content: result, metadata: { artifact: id, revision: after.revision } };
        },
      });
      tools.add({
        name: "artifact_read",
        options: { codemode: false },
        description: READ_DESCRIPTION,
        input: ReadInput,
        execute: async (input, context) => {
          const id = await resolve(context.sessionID, input.artifact);
          const artifact = await store.read(context.sessionID, id);
          const revision = positive(input.revision, "revision") ?? artifact.revision;
          if (revision !== artifact.revision) {
            const problem = switchProblem(artifact, revision);
            if (problem) throw new Error(problem);
          }
          const { content } = await store.revision(context.sessionID, id, revision);
          return {
            content: renderForModel(artifact, { content, revision }, {
              offset: positive(input.offset, "offset"),
              limit: positive(input.limit, "limit"),
            }),
            // Paged here, below opencode's own limits: its truncation would hide the rest of the page count.
            metadata: { artifact: id, revision: artifact.revision, truncated: false },
          };
        },
      });
      tools.add({
        name: "artifact_list",
        options: { codemode: false },
        description: LIST_DESCRIPTION,
        input: ListInput,
        execute: async (_input, context) => {
          const summaries = (await store.list(context.sessionID)).map(summarize).sort(byCreation);
          return { content: listText(summaries), metadata: { count: summaries.length } };
        },
      });
      tools.add({
        name: "artifact_switch",
        options: { codemode: false },
        description: SWITCH_DESCRIPTION,
        input: SwitchInput,
        execute: async (input, context) => {
          const target = positive(input.revision, "revision")!;
          const id = await resolve(context.sessionID, input.artifact);
          const { before, after } = await store.update(context.sessionID, id, async (artifact, { revision }) => {
            const problem = switchProblem(artifact, target);
            if (problem) throw new Error(problem);
            return switchTo(artifact, target, await revision(target), "agent", Date.now());
          });
          if (after !== before) await emit(context.sessionID, after, "agent");
          return { content: switchResult(after), metadata: { artifact: id, revision: after.revision } };
        },
      });
      tools.add({
        name: "artifact_rename",
        options: { codemode: false },
        description: RENAME_DESCRIPTION,
        input: RenameInput,
        execute: async (input, context) => {
          if (!input.id?.trim() && !input.title?.trim()) throw new Error("Give a new id, a new title, or both.");
          const from = await resolve(context.sessionID, input.artifact);
          const { artifact, told } = await rename(context.sessionID, from, input.id ?? "", input.title ?? "", "agent");
          const done = told.length > 0 ? told.join(" and ") : "unchanged: it already has these names";
          return { content: `Artifact ${from} ${done}.`, metadata: { artifact: artifact.id } };
        },
      });
      tools.add({
        name: "artifact_delete",
        options: { codemode: false },
        description: DELETE_DESCRIPTION,
        input: DeleteInput,
        execute: async (input, context) => {
          if (!input.request.trim()) throw new Error("Quote the user's request to delete the artifact in `request`.");
          const id = await resolve(context.sessionID, input.artifact);
          const removed = await store.remove(context.sessionID, id);
          if (!exists(removed)) return { content: `There is no artifact ${id}: nothing to delete.`, metadata: {} };
          await emit(context.sessionID, { ...removed, revision: 0, seq: removed.seq + 1 }, "deleted");
          const unsent = removed.comments.length;
          return {
            content: `Artifact ${id} ("${removed.title}") deleted with its revisions${unsent > 0 ? ` and ${unsent} unsent comment${unsent > 1 ? "s" : ""}` : ""}.`,
            metadata: { artifact: id },
          };
        },
      });
    });

    // After a compaction the agent may no longer know the session has
    // artifacts. A short reminder then, and only then, so the system prompt
    // stays stable from turn to turn while the tool calls are in context.
    await ctx.session.hook("context", async (event) => {
      const seen = event.messages.some((message) =>
        message.content.some((part) => part.type === "tool-call" && TOOLS.includes(part.name)),
      );
      if (seen) return;
      const artifacts = (await store.list(event.sessionID)).map(summarize).sort(byCreation);
      if (artifacts.length === 0) return;
      const { shown } = await store.meta(event.sessionID);
      const open = artifacts.some((artifact) => artifact.id === shown) ? `\nThe user has ${shown} open in the artifact panel.` : "";
      event.system.push({
        type: "text",
        text: `# Session artifacts\n${listText(artifacts)}${open}\nRead one with artifact_read before changing it.`,
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
    void sweepOrphans(ctx.storage, SESSION_PREFIXES, sessionExists, (sessionID) => store.removeSession(sessionID), Date.now()).catch(
      () => {},
    );

    // A deleted session's artifacts go with it.
    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          if (event.type === "session.deleted") await store.removeSession(event.data.sessionID).catch(() => {});
        }
      } catch {
        // Aborted on cleanup, or the stream ended.
      }
    })();

    return () => stop.abort();
  },
});
