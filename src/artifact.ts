// The artifacts of a session: Markdown documents the agent writes and the
// user reviews, each with its revisions and the comments the user left on it
// since the last review was sent. Pure logic, shared by the server plugin and
// the TUI.
//
// The revisions of an artifact form a line with a cursor, like an editor's
// undo history: undo and redo move the cursor and keep every revision; the
// next change starts from the revision under the cursor and replaces the ones
// after it.

export interface Comment {
  id: string;
  /** The passage the comment is about, as the user selected it. */
  quote: string;
  note: string;
  createdAt: number;
}

export type Author = "agent" | "user";
export type RevisionKind = "write" | "edit" | "append" | "save";

export interface RevisionInfo {
  revision: number;
  title: string;
  by: Author;
  kind: RevisionKind;
  at: number;
  lines: number;
}

export interface Artifact {
  /** The artifact's identifier in its session, chosen by the agent: `lot-1`, `decisions-m2`. */
  id: string;
  /** The revision under the cursor, the one shown and read. 0 while the artifact does not exist. */
  revision: number;
  /** The last revision kept for redo. */
  latest: number;
  /** A label of the artifact, like its identifier: switching revisions keeps it. */
  title: string;
  content: string;
  /** The revisions kept, oldest first. Their text is stored apart. */
  history: RevisionInfo[];
  /** Counts every change, comments included: the panel reloads on it. */
  seq: number;
  /** An agent's `append` extends the current revision instead of making a new one. */
  appendable: boolean;
  createdAt: number;
  updatedAt: number;
  updatedBy: Author;
  comments: Comment[];
}

/** The text of a revision. `title` is kept for reference: the artifact's title does not follow undo. */
export interface Snapshot {
  title: string;
  content: string;
}

/** The new state, the revision texts to store and to remove, and what to tell the agent. */
export interface Change {
  artifact: Artifact;
  put?: { revision: number; snapshot: Snapshot };
  drop: number[];
  /** A change the agent must be told about, for the session's instruction entry. */
  event?: string;
}

/** A change to one of the session's artifacts the agent did not make with its own writes. */
export interface SessionEvent {
  artifact: string;
  at: number;
  text: string;
}

/** What a session keeps besides its artifacts: the changes to tell the agent about. */
export interface SessionMeta {
  /** Counts the changes to `events` and `shown`: the TUI updates the instruction entry when it moves. */
  seq: number;
  events: SessionEvent[];
  /** The artifact the user has open in the panel, the last one shown when the panel is closed. */
  shown?: string;
}

export const EMPTY_META: SessionMeta = { seq: 0, events: [] };

export const EMPTY_ARTIFACT: Artifact = {
  id: "",
  revision: 0,
  latest: 0,
  title: "",
  content: "",
  history: [],
  seq: 0,
  appendable: false,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: "agent",
  comments: [],
};

export const DEFAULT_MAX_REVISIONS = 30;
export const MAX_EVENTS = 8;

export const exists = (artifact: Artifact) => artifact.revision > 0;

const newId = () => Math.random().toString(36).slice(2, 10);
const lineCount = (content: string) => (content ? content.split("\n").length : 0);
const unchanged = (artifact: Artifact): Change => ({ artifact, drop: [] });

/** "4" or "4–6". */
export const span = (from: number, to: number) => (from === to ? `${from}` : `${from}–${to}`);
const revisions = (from: number, to: number) => `${from === to ? "Revision" : "Revisions"} ${span(from, to)}`;

/** An identifier: lowercase letters, digits, `-`, `_` and `.`, from a letter or digit, 48 at most. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

export function checkId(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `"${id}" is not a valid artifact identifier: use lowercase letters, digits, "-", "_" or ".", like "lot-1" (48 characters at most).`,
    );
  }
  return id;
}

/** An identifier from a title: "Spec — Suivi des soldes" gives "spec-suivi-des-soldes". */
export function slugify(title: string): string {
  const words = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 32) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, 32) || "artifact";
}

/** `base`, or `base-2`, `base-3`… when it is taken. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base.slice(0, 44)}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A stored artifact, from this version or an earlier one: the first one had no
 * revision list and counted comments as revisions, the second one had no
 * identifier and kept its events with it. `legacy`: its current text has no
 * stored revision yet.
 */
export function fromStored(
  value: unknown,
  id = "",
): { artifact: Artifact; legacy: boolean; events: { at: number; text: string }[] } | undefined {
  const stored = value as (Partial<Artifact> & { events?: unknown }) | undefined;
  if (typeof stored?.revision !== "number" || typeof stored.content !== "string" || !Array.isArray(stored.comments)) {
    return undefined;
  }
  const events = Array.isArray(stored.events)
    ? (stored.events as { at: number; text: string }[]).filter((event) => typeof event?.text === "string")
    : [];
  if (Array.isArray(stored.history)) {
    const { events: _events, ...rest } = stored;
    const artifact = { ...EMPTY_ARTIFACT, ...rest, id: stored.id || id } as Artifact;
    if (!artifact.createdAt) artifact.createdAt = artifact.history[0]?.at ?? artifact.updatedAt;
    return { artifact, legacy: false, events };
  }
  const artifact: Artifact = {
    ...EMPTY_ARTIFACT,
    id,
    revision: stored.revision,
    latest: stored.revision,
    title: stored.title ?? "Artifact",
    content: stored.content,
    seq: stored.revision,
    createdAt: stored.updatedAt ?? 0,
    updatedAt: stored.updatedAt ?? 0,
    updatedBy: stored.updatedBy === "user" ? "user" : "agent",
    comments: stored.comments,
  };
  if (stored.revision > 0) {
    artifact.history = [
      { revision: stored.revision, title: artifact.title, by: artifact.updatedBy, kind: "write", at: artifact.updatedAt, lines: lineCount(stored.content) },
    ];
  }
  return { artifact, legacy: stored.revision > 0, events };
}

interface Commit {
  title: string;
  content: string;
  by: Author;
  kind: RevisionKind;
  now: number;
  maxRevisions: number;
  appendable?: boolean;
}

/**
 * A new revision after the current one. The revisions kept for redo go: the
 * user went back because they no longer mattered. Beyond `maxRevisions`, the
 * oldest go too.
 */
function commit(previous: Artifact, next: Commit): Change {
  const revision = previous.revision + 1;
  const kept = previous.history.filter((info) => info.revision < revision);
  // The replaced revision with the new one's number is overwritten, not dropped.
  const drop = previous.history.filter((info) => info.revision > revision).map((info) => info.revision);
  const history = [
    ...kept,
    { revision, title: next.title, by: next.by, kind: next.kind, at: next.now, lines: lineCount(next.content) },
  ];
  while (history.length > Math.max(1, next.maxRevisions)) drop.push(history.shift()!.revision);
  return {
    artifact: {
      ...previous,
      revision,
      latest: revision,
      title: next.title,
      content: next.content,
      history,
      seq: previous.seq + 1,
      appendable: next.appendable ?? false,
      createdAt: previous.createdAt || next.now,
      updatedAt: next.now,
      updatedBy: next.by,
    },
    put: { revision, snapshot: { title: next.title, content: next.content } },
    drop,
  };
}

/** What a change after the current revision replaced, for the agent's tool result. */
export function replacedRedo(previous: Artifact): string {
  if (previous.revision >= previous.latest) return "";
  return ` ${revisions(previous.revision + 1, previous.latest)}, kept for redo, ${previous.revision + 1 === previous.latest ? "was" : "were"} replaced.`;
}

export interface WriteOptions {
  append?: boolean;
  maxRevisions?: number;
}

/**
 * The agent writes the whole document, or adds to its end with `append`.
 * Appends right after the agent's own write extend that revision: a long
 * document written in parts is one revision. Comments stay: the user has not
 * sent them yet.
 */
export function agentWrite(previous: Artifact, title: string | undefined, content: string, now: number, options: WriteOptions = {}): Change {
  const nextTitle = title?.trim() || previous.title || "Artifact";
  const maxRevisions = options.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  if (!options.append || !exists(previous)) {
    return commit(previous, { title: nextTitle, content, by: "agent", kind: "write", now, maxRevisions, appendable: true });
  }
  const joined = previous.content + content;
  if (!previous.appendable || previous.revision !== previous.latest) {
    return commit(previous, { title: nextTitle, content: joined, by: "agent", kind: "append", now, maxRevisions, appendable: true });
  }
  const history = previous.history.map((info) =>
    info.revision === previous.revision ? { ...info, title: nextTitle, at: now, lines: lineCount(joined) } : info,
  );
  return {
    artifact: { ...previous, title: nextTitle, content: joined, history, seq: previous.seq + 1, updatedAt: now, updatedBy: "agent" },
    put: { revision: previous.revision, snapshot: { title: nextTitle, content: joined } },
    drop: [],
  };
}

export interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** One replacement. The passage must appear exactly once unless `all` is set. */
function applyEdit(content: string, edit: Edit): string {
  if (!edit.old_string) throw new Error("old_string is empty.");
  const count = content.split(edit.old_string).length - 1;
  if (count === 0) throw new Error("old_string was not found in the artifact. Read it again with artifact_read.");
  if (count > 1 && !edit.replace_all) {
    throw new Error(`old_string appears ${count} times: add surrounding text to make it unique, or set replace_all.`);
  }
  return edit.replace_all
    ? content.split(edit.old_string).join(edit.new_string)
    : content.replace(edit.old_string, () => edit.new_string);
}

/**
 * The agent replaces passages, one after another: each one is looked for in
 * the text the edits before it left. All of them or none: one that fails
 * leaves the artifact as it was. Together they make one revision.
 */
export function agentEdit(previous: Artifact, edits: readonly Edit[], now: number, maxRevisions = DEFAULT_MAX_REVISIONS): Change {
  if (!exists(previous)) throw new Error("This artifact does not exist yet: create it with artifact_write.");
  if (edits.length === 0) throw new Error("edits is empty: give at least one replacement.");
  let content = previous.content;
  edits.forEach((edit, index) => {
    try {
      content = applyEdit(content, edit);
    } catch (error) {
      if (edits.length === 1) throw error;
      const after = index > 0 ? " (looked for in the text the edits before it left)" : "";
      throw new Error(`Edit ${index + 1} of ${edits.length}${after}: ${(error as Error).message} No edit was applied.`);
    }
  });
  if (content === previous.content) return unchanged(previous);
  return commit(previous, { title: previous.title, content, by: "agent", kind: "edit", now, maxRevisions });
}

/** The user saves their own edits: a revision like the agent's, which the agent is told about. */
export function userSave(previous: Artifact, content: string, now: number, maxRevisions = DEFAULT_MAX_REVISIONS): Change {
  if (content === previous.content) return unchanged(previous);
  const change = commit(previous, { title: previous.title, content, by: "user", kind: "save", now, maxRevisions });
  change.event = `the user saved their own edits as revision ${change.artifact.revision}.${replacedRedo(previous)}`;
  return change;
}

/** Why the cursor cannot go to `target`, or undefined when it can. */
export function switchProblem(artifact: Artifact, target: number): string | undefined {
  if (!exists(artifact)) return "This artifact does not exist yet.";
  if (target === artifact.revision) return `The artifact is already on revision ${target}.`;
  if (!artifact.history.some((info) => info.revision === target)) {
    const first = artifact.history[0]?.revision ?? artifact.revision;
    return `Revision ${target} is not kept: the revisions available are ${span(first, artifact.latest)}.`;
  }
  return undefined;
}

/**
 * Moves the cursor to another kept revision, without changing any. The
 * revisions after it stay for redo until the next change, which replaces them.
 */
export function switchTo(previous: Artifact, target: number, snapshot: Snapshot, by: Author, now: number): Change {
  const problem = switchProblem(previous, target);
  if (problem) throw new Error(problem);
  const who = by === "user" ? "the user" : "you (the agent)";
  const direction = target < previous.revision ? "went back" : "moved forward";
  const step = target === previous.revision - 1 ? " (undo)" : target === previous.revision + 1 ? " (redo)" : "";
  const kept =
    target < previous.latest
      ? ` ${revisions(target + 1, previous.latest)} ${target + 1 === previous.latest ? "was" : "were"} kept for redo until the next write or edit, which becomes the new revision ${target + 1}.`
      : "";
  return {
    artifact: {
      ...previous,
      revision: target,
      content: snapshot.content,
      seq: previous.seq + 1,
      appendable: false,
      updatedAt: now,
      updatedBy: by,
    },
    drop: [],
    event: `${who} ${direction} from revision ${previous.revision} to revision ${target}${step}.${kept}`,
  };
}

/** The tool result of the agent's own switch. */
export function switchResult(artifact: Artifact): string {
  const redo =
    artifact.revision < artifact.latest
      ? ` ${revisions(artifact.revision + 1, artifact.latest)} ${artifact.revision + 1 === artifact.latest ? "stays" : "stay"} available (redo) until the next write or edit, which becomes the new revision ${artifact.revision + 1}.`
      : "";
  return `The artifact ${artifact.id} ("${artifact.title}") is now on revision ${artifact.revision} of ${artifact.latest}.${redo}`;
}

/** A new title: a label, not a revision. */
export function retitle(previous: Artifact, title: string): Artifact {
  const clean = title.trim();
  if (!clean) throw new Error("The title is empty.");
  if (clean === previous.title) return previous;
  return { ...previous, title: clean, seq: previous.seq + 1 };
}

/**
 * The agent's write or edit refused when the artifact is no longer on the
 * revision it read: the user moved or changed it since. `last`: the last
 * change the agent was told about.
 */
export function checkBase(artifact: Artifact, base: number | undefined, last?: string): void {
  if (base === undefined || !exists(artifact) || base === artifact.revision) return;
  throw new Error(
    `The artifact ${artifact.id} is on revision ${artifact.revision} of ${artifact.latest}, not revision ${base}${last ? `: ${last}` : "."} Read it with artifact_read first.`,
  );
}

/** Adds an event for the agent, the last ones only. */
export function withEvent(meta: SessionMeta, event: SessionEvent): SessionMeta {
  return { ...meta, seq: meta.seq + 1, events: [...meta.events, event].slice(-MAX_EVENTS) };
}

/** The last event about one artifact, for a refused write. */
export const lastEvent = (meta: SessionMeta, id: string) =>
  meta.events.filter((event) => event.artifact === id).at(-1)?.text;

export function addComment(previous: Artifact, quote: string, note: string, now: number): Artifact {
  const cleanQuote = quote.trim();
  const cleanNote = note.trim();
  if (!cleanNote) throw new Error("The comment is empty.");
  const comment: Comment = { id: newId(), quote: cleanQuote, note: cleanNote, createdAt: now };
  return { ...previous, seq: previous.seq + 1, comments: [...previous.comments, comment] };
}

export function removeComment(previous: Artifact, commentID: string): Artifact {
  const comments = previous.comments.filter((comment) => comment.id !== commentID);
  if (comments.length === previous.comments.length) return previous;
  return { ...previous, seq: previous.seq + 1, comments };
}

/** Whether there is anything to send to the agent. */
export const hasReview = (artifact: Artifact) => artifact.comments.length > 0;

/** Once sent, the comments leave the document: the agent has them in the message. */
export function clearReview(previous: Artifact): Artifact {
  return { ...previous, seq: previous.seq + 1, comments: [] };
}

const QUOTE_MAX = 200;

function shortQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
}

/**
 * The message sent to the agent when the user validates a review. Kept short:
 * it shows in the chat, and the document itself stays out of it. The user's
 * own edits reach the agent through the session's instruction entry.
 */
export function reviewMessage(artifact: Artifact): string {
  const lines = [`Review of the artifact ${artifact.id}, "${artifact.title}" (revision ${artifact.revision}):`, "", "Comments:"];
  artifact.comments.forEach((comment, index) => {
    const on = comment.quote ? `On "${shortQuote(comment.quote)}": ` : "";
    lines.push(`${index + 1}. ${on}${comment.note}`);
  });
  // A comment may be a question as well as a change request: the agent tells
  // them apart, and only the requests change the document.
  lines.push(
    "",
    "Answer the comments that are questions in the chat, without changing the artifact for them.",
    `Change the artifact ${artifact.id} only for the comments that ask for a change, with one artifact_edit call holding all the replacements (or artifact_write).`,
    "Then reply briefly.",
  );
  return lines.join("\n");
}

/** The key of the session's instruction entry: opencode shows it as `<context key="artifact">`. */
export const INSTRUCTION_KEY = "artifact";

/** "14:02", in the local time. */
export const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** "14:02" today, "2026-09-30 14:02" another day. */
export function when(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) return clock(at);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${day} ${clock(at)}`;
}

/**
 * The session's instruction entry: the changes the agent did not make with
 * its own writes, as dated facts that stay true after later writes. opencode
 * adds it to the conversation whenever it changes. Undefined: nothing to tell.
 */
export function instructionText(
  meta: SessionMeta,
  shown?: Pick<Artifact, "id" | "title" | "revision">,
  time: (at: number) => string = clock,
): string | undefined {
  const lines: string[] = [];
  // What "this document" or "this section" refers to in the user's messages.
  if (shown) lines.push(`The user has the artifact ${shown.id} ("${shown.title}", revision ${shown.revision}) open in the artifact panel.`);
  if (meta.events.length > 0) {
    lines.push(
      "Changes to this session's artifacts not made with artifact_write or artifact_edit, oldest first:",
      ...meta.events.map((event) => `- ${time(event.at)} [${event.artifact}] ${event.text}`),
      "Call artifact_read on an artifact before changing it.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** An artifact as listed: everything but its text, comments and revisions. */
export interface Summary {
  id: string;
  title: string;
  revision: number;
  latest: number;
  lines: number;
  bytes: number;
  comments: number;
  createdAt: number;
  updatedAt: number;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

export function summarize(artifact: Artifact): Summary {
  return {
    id: artifact.id,
    title: artifact.title,
    revision: artifact.revision,
    latest: artifact.latest,
    lines: lineCount(artifact.content),
    bytes: bytes(artifact.content),
    comments: artifact.comments.length,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

/** The artifacts in the order they were created. */
export const byCreation = (a: Summary, b: Summary) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

const size = (count: number) => (count < 1024 ? `${count} B` : `${Math.round(count / 1024)} KB`);

/** The artifacts as the agent lists them. */
export function listText(summaries: readonly Summary[], now = Date.now()): string {
  if (summaries.length === 0) return "This session has no artifact yet. Create one with artifact_write.";
  const lines = summaries.map((summary) => {
    const position =
      summary.revision < summary.latest
        ? `revision ${summary.revision} of ${summary.latest} (${summary.latest - summary.revision} kept for redo)`
        : `revision ${summary.revision}`;
    const comments = summary.comments > 0 ? `, ${summary.comments} unsent comment${summary.comments > 1 ? "s" : ""}` : "";
    return `- ${summary.id} — "${summary.title}" — ${position}, ${summary.lines} lines, ${size(summary.bytes)}${comments}, updated ${when(summary.updatedAt, now)}`;
  });
  const count = summaries.length;
  return [`${count} artifact${count > 1 ? "s" : ""} in this session:`, ...lines].join("\n");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Inline markers the rendered view hides: emphasis, strike, inline code. */
const INLINE = "[*_`~]*";
/** Between two words: markers, whitespace, and the block markers that start a line. */
const JOIN = `${INLINE}\\s+(?:[>#*+-]+\\s+|\\d+[.)]\\s+)*${INLINE}`;

/**
 * Where a comment's quote is in the Markdown source, for placing and
 * highlighting it. A passage selected in the rendered view has lost its
 * markers (`**`, `>`, list bullets) and may wrap differently: the match
 * tolerates both, trying the exact text first.
 */
export function locateQuote(content: string, quote: string): { start: number; end: number } | undefined {
  // The rendered view draws block quotes with a bar that is not in the source.
  const clean = quote.replace(/│/g, " ").trim();
  if (!clean) return undefined;
  const exact = content.indexOf(clean);
  if (exact >= 0) return { start: exact, end: exact + clean.length };
  const words = clean.split(/\s+/).map((word) => [...word].map(escape).join(INLINE));
  const match = new RegExp(words.join(JOIN)).exec(content);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

/** Below opencode's own truncation of tool results (2000 lines, 50 KB), header included. */
export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 48 * 1024;

export interface ReadWindow {
  /** The first line, from 1. */
  offset?: number;
  limit?: number;
}

/**
 * A revision as the agent reads it, a page at a time when it is long: the
 * text is never cut by opencode's generic truncation, which would hide the end
 * of the document from the agent.
 */
export function renderForModel(
  artifact: Artifact,
  snapshot: { content: string; revision: number } = { content: artifact.content, revision: artifact.revision },
  window: ReadWindow = {},
): string {
  if (!exists(artifact)) return "This artifact does not exist yet.";
  const other = snapshot.revision !== artifact.revision ? `, not the current revision ${artifact.revision}` : "";
  const header = `# ${artifact.title} (artifact ${artifact.id}, revision ${snapshot.revision} of ${artifact.latest}${other})`;
  const lines = snapshot.content.split("\n");
  const first = Math.max(1, Math.floor(window.offset ?? 1));
  if (first > lines.length) throw new Error(`offset ${first} is past the end: the revision has ${lines.length} lines.`);
  const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(window.limit ?? READ_MAX_LINES)));
  const shown: string[] = [];
  let used = 0;
  let cut = false;
  for (let index = first - 1; index < lines.length && shown.length < limit; index++) {
    const line = lines[index]!;
    const cost = bytes(line) + 1;
    if (used + cost > READ_MAX_BYTES) {
      if (shown.length === 0) {
        // One line longer than a page: its start, rather than nothing.
        let end = line.length;
        while (end > 0 && bytes(line.slice(0, end)) > READ_MAX_BYTES) end = Math.floor(end * 0.9);
        shown.push(line.slice(0, end));
        cut = true;
      }
      break;
    }
    shown.push(line);
    used += cost;
  }
  const last = first + shown.length - 1;
  const whole = first === 1 && last === lines.length && !cut;
  if (whole) return `${header}\n\n${snapshot.content}`;
  const more = last < lines.length ? ` Read on with offset=${last + 1}.` : "";
  const note = cut ? ` Line ${last} is cut: it is longer than a page.` : "";
  return `${header}\n\n${shown.join("\n")}\n\n[Lines ${first}–${last} of ${lines.length}.${note}${more}]`;
}
