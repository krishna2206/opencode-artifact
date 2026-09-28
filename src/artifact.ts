// The artifact of a session: one Markdown document the agent writes and the
// user reviews, its revisions, and the comments the user left on it since the
// last review was sent. Pure logic, shared by the server plugin and the TUI.
//
// The revisions form a line with a cursor, like an editor's undo history:
// undo and redo move the cursor and keep every revision; the next change
// starts from the revision under the cursor and replaces the ones after it.

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

/** A change the agent did not make with its own writes: what the session's instruction entry tells it. */
export interface ArtifactEvent {
  at: number;
  text: string;
}

export interface Artifact {
  /** The revision under the cursor, the one shown and read. 0 while the session has no artifact. */
  revision: number;
  /** The last revision kept for redo. */
  latest: number;
  title: string;
  content: string;
  /** The revisions kept, oldest first. Their text is stored apart. */
  history: RevisionInfo[];
  /** Counts every change, comments included: the panel reloads on it. */
  seq: number;
  /** An agent's `append` extends the current revision instead of making a new one. */
  appendable: boolean;
  updatedAt: number;
  updatedBy: Author;
  comments: Comment[];
  events: ArtifactEvent[];
}

export interface Snapshot {
  title: string;
  content: string;
}

/** The new state, and the revision texts to store and to remove. */
export interface Change {
  artifact: Artifact;
  put?: { revision: number; snapshot: Snapshot };
  drop: number[];
}

export const EMPTY_ARTIFACT: Artifact = {
  revision: 0,
  latest: 0,
  title: "",
  content: "",
  history: [],
  seq: 0,
  appendable: false,
  updatedAt: 0,
  updatedBy: "agent",
  comments: [],
  events: [],
};

export const DEFAULT_MAX_REVISIONS = 50;
const MAX_EVENTS = 5;

export const exists = (artifact: Artifact) => artifact.revision > 0;

const newId = () => Math.random().toString(36).slice(2, 10);
const lineCount = (content: string) => (content ? content.split("\n").length : 0);
const unchanged = (artifact: Artifact): Change => ({ artifact, drop: [] });

/** "4" or "4–6". */
export const span = (from: number, to: number) => (from === to ? `${from}` : `${from}–${to}`);
const revisions = (from: number, to: number) => `${from === to ? "Revision" : "Revisions"} ${span(from, to)}`;

/**
 * A stored artifact, from this version or the first one (no revision list,
 * comments counted as revisions). `legacy`: its current text has no stored
 * revision yet.
 */
export function fromStored(value: unknown): { artifact: Artifact; legacy: boolean } | undefined {
  const stored = value as Partial<Artifact> | undefined;
  if (typeof stored?.revision !== "number" || typeof stored.content !== "string" || !Array.isArray(stored.comments)) {
    return undefined;
  }
  if (Array.isArray(stored.history)) return { artifact: { ...EMPTY_ARTIFACT, ...stored } as Artifact, legacy: false };
  const artifact: Artifact = {
    ...EMPTY_ARTIFACT,
    revision: stored.revision,
    latest: stored.revision,
    title: stored.title ?? "Artifact",
    content: stored.content,
    seq: stored.revision,
    updatedAt: stored.updatedAt ?? 0,
    updatedBy: stored.updatedBy === "user" ? "user" : "agent",
    comments: stored.comments,
  };
  if (stored.revision > 0) {
    artifact.history = [
      { revision: stored.revision, title: artifact.title, by: artifact.updatedBy, kind: "write", at: artifact.updatedAt, lines: lineCount(stored.content) },
    ];
  }
  return { artifact, legacy: stored.revision > 0 };
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

/**
 * The agent replaces one passage. The passage must appear exactly once unless
 * `all` is set, so an edit never lands on the wrong occurrence.
 */
export function agentEdit(
  previous: Artifact,
  oldText: string,
  newText: string,
  all: boolean,
  now: number,
  maxRevisions = DEFAULT_MAX_REVISIONS,
): Change {
  if (!exists(previous)) throw new Error("This session has no artifact yet: create it with artifact_write.");
  if (!oldText) throw new Error("old_string is empty.");
  const count = previous.content.split(oldText).length - 1;
  if (count === 0) throw new Error("old_string was not found in the artifact. Read it again with artifact_read.");
  if (count > 1 && !all) {
    throw new Error(`old_string appears ${count} times: add surrounding text to make it unique, or set replace_all.`);
  }
  const content = all ? previous.content.split(oldText).join(newText) : previous.content.replace(oldText, () => newText);
  if (content === previous.content) return unchanged(previous);
  return commit(previous, { title: previous.title, content, by: "agent", kind: "edit", now, maxRevisions });
}

function withEvent(artifact: Artifact, at: number, text: string): Artifact {
  return { ...artifact, events: [...artifact.events, { at, text }].slice(-MAX_EVENTS) };
}

/** The user saves their own edits: a revision like the agent's, which the agent is told about. */
export function userSave(previous: Artifact, content: string, now: number, maxRevisions = DEFAULT_MAX_REVISIONS): Change {
  if (content === previous.content) return unchanged(previous);
  const change = commit(previous, { title: previous.title, content, by: "user", kind: "save", now, maxRevisions });
  const replaced = replacedRedo(previous);
  change.artifact = withEvent(change.artifact, now, `the user saved their own edits as revision ${change.artifact.revision}.${replaced}`);
  return change;
}

/** Why the cursor cannot go to `target`, or undefined when it can. */
export function switchProblem(artifact: Artifact, target: number): string | undefined {
  if (!exists(artifact)) return "This session has no artifact yet.";
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
  const artifact: Artifact = {
    ...previous,
    revision: target,
    title: snapshot.title,
    content: snapshot.content,
    seq: previous.seq + 1,
    appendable: false,
    updatedAt: now,
    updatedBy: by,
  };
  const text = `${who} ${direction} from revision ${previous.revision} to revision ${target}${step}.${kept}`;
  return { artifact: withEvent(artifact, now, text), drop: [] };
}

/** The tool result of the agent's own switch. */
export function switchResult(artifact: Artifact): string {
  const redo =
    artifact.revision < artifact.latest
      ? ` ${revisions(artifact.revision + 1, artifact.latest)} ${artifact.revision + 1 === artifact.latest ? "stays" : "stay"} available (redo) until the next write or edit, which becomes the new revision ${artifact.revision + 1}.`
      : "";
  return `The artifact "${artifact.title}" is now on revision ${artifact.revision} of ${artifact.latest}.${redo}`;
}

/**
 * The agent's write or edit refused when the artifact is no longer on the
 * revision it read: the user moved or changed it since.
 */
export function checkBase(artifact: Artifact, base: number | undefined): void {
  if (base === undefined || !exists(artifact) || base === artifact.revision) return;
  const last = artifact.events.at(-1)?.text;
  throw new Error(
    `The artifact is on revision ${artifact.revision} of ${artifact.latest}, not revision ${base}${last ? `: ${last}` : "."} Read it with artifact_read first.`,
  );
}

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
  const lines = [`Review of the artifact "${artifact.title}" (revision ${artifact.revision}):`, "", "Comments:"];
  artifact.comments.forEach((comment, index) => {
    const on = comment.quote ? `On "${shortQuote(comment.quote)}": ` : "";
    lines.push(`${index + 1}. ${on}${comment.note}`);
  });
  lines.push("", "Revise the artifact accordingly with artifact_edit or artifact_write, then reply briefly.");
  return lines.join("\n");
}

/** The key of the session's instruction entry: opencode shows it as `<context key="artifact">`. */
export const INSTRUCTION_KEY = "artifact";

/** "14:02", in the local time. */
export const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/**
 * The session's instruction entry: the changes the agent did not make with
 * its own writes, as dated facts that stay true after later writes. opencode
 * adds it to the conversation whenever it changes. Undefined: nothing to tell.
 */
export function instructionText(artifact: Artifact, time: (at: number) => string = clock): string | undefined {
  if (!exists(artifact) || artifact.events.length === 0) return undefined;
  return [
    `Changes to the session's artifact "${artifact.title}" not made with artifact_write or artifact_edit, oldest first:`,
    ...artifact.events.map((event) => `- ${time(event.at)} ${event.text}`),
    "Call artifact_read before changing the artifact.",
  ].join("\n");
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

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/**
 * A revision as the agent reads it, a page at a time when it is long: the
 * text is never cut by opencode's generic truncation, which would hide the end
 * of the document from the agent.
 */
export function renderForModel(
  artifact: Artifact,
  snapshot: Snapshot & { revision: number } = { title: artifact.title, content: artifact.content, revision: artifact.revision },
  window: ReadWindow = {},
): string {
  if (!exists(artifact)) return "This session has no artifact yet.";
  const other = snapshot.revision !== artifact.revision ? `, not the current revision ${artifact.revision}` : "";
  const header = `# ${snapshot.title} (revision ${snapshot.revision} of ${artifact.latest}${other})`;
  const lines = snapshot.content.split("\n");
  const first = Math.max(1, Math.floor(window.offset ?? 1));
  if (first > lines.length) throw new Error(`offset ${first} is past the end: the revision has ${lines.length} lines.`);
  const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(window.limit ?? READ_MAX_LINES)));
  const shown: string[] = [];
  let size = 0;
  let cut = false;
  for (let index = first - 1; index < lines.length && shown.length < limit; index++) {
    const line = lines[index]!;
    const cost = bytes(line) + 1;
    if (size + cost > READ_MAX_BYTES) {
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
    size += cost;
  }
  const last = first + shown.length - 1;
  const whole = first === 1 && last === lines.length && !cut;
  if (whole) return `${header}\n\n${snapshot.content}`;
  const more = last < lines.length ? ` Read on with offset=${last + 1}.` : "";
  const note = cut ? ` Line ${last} is cut: it is longer than a page.` : "";
  return `${header}\n\n${shown.join("\n")}\n\n[Lines ${first}–${last} of ${lines.length}.${note}${more}]`;
}
