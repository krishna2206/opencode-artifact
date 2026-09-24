// The artifact of a session: one Markdown document the agent writes and the
// user reviews, plus the comments the user left on it since the last review
// was sent. Pure logic, shared by the server plugin and the TUI.

export interface Comment {
  id: string;
  /** The passage the comment is about, as the user selected it. */
  quote: string;
  note: string;
  createdAt: number;
}

export interface Artifact {
  /** 0 while the session has no artifact. */
  revision: number;
  title: string;
  content: string;
  updatedAt: number;
  updatedBy: "agent" | "user";
  /** The user changed the text since the last review was sent. */
  editedByUser: boolean;
  comments: Comment[];
}

export const EMPTY_ARTIFACT: Artifact = {
  revision: 0,
  title: "",
  content: "",
  updatedAt: 0,
  updatedBy: "agent",
  editedByUser: false,
  comments: [],
};

export const exists = (artifact: Artifact) => artifact.revision > 0;

const newId = () => Math.random().toString(36).slice(2, 10);

/** The agent writes the whole document. Comments stay: the user has not sent them yet. */
export function agentWrite(previous: Artifact, title: string | undefined, content: string, now: number): Artifact {
  const nextTitle = title?.trim() || previous.title || "Artifact";
  return { ...previous, revision: previous.revision + 1, title: nextTitle, content, updatedAt: now, updatedBy: "agent" };
}

/**
 * The agent replaces one passage. The passage must appear exactly once unless
 * `all` is set, so an edit never lands on the wrong occurrence.
 */
export function agentEdit(previous: Artifact, oldText: string, newText: string, all: boolean, now: number): Artifact {
  if (!exists(previous)) throw new Error("This session has no artifact yet: create it with artifact_write.");
  if (!oldText) throw new Error("old_string is empty.");
  const count = previous.content.split(oldText).length - 1;
  if (count === 0) throw new Error("old_string was not found in the artifact. Read it again with artifact_read.");
  if (count > 1 && !all) {
    throw new Error(`old_string appears ${count} times: add surrounding text to make it unique, or set replace_all.`);
  }
  const content = all ? previous.content.split(oldText).join(newText) : previous.content.replace(oldText, () => newText);
  return agentWrite(previous, undefined, content, now);
}

export function userSave(previous: Artifact, content: string, now: number): Artifact {
  if (content === previous.content) return previous;
  return { ...previous, revision: previous.revision + 1, content, updatedAt: now, updatedBy: "user", editedByUser: true };
}

export function addComment(previous: Artifact, quote: string, note: string, now: number): Artifact {
  const cleanQuote = quote.trim();
  const cleanNote = note.trim();
  if (!cleanNote) throw new Error("The comment is empty.");
  const comment: Comment = { id: newId(), quote: cleanQuote, note: cleanNote, createdAt: now };
  return { ...previous, revision: previous.revision + 1, comments: [...previous.comments, comment] };
}

export function removeComment(previous: Artifact, commentID: string): Artifact {
  const comments = previous.comments.filter((comment) => comment.id !== commentID);
  if (comments.length === previous.comments.length) return previous;
  return { ...previous, revision: previous.revision + 1, comments };
}

/** Whether there is anything to send to the agent. */
export const hasReview = (artifact: Artifact) => artifact.comments.length > 0 || artifact.editedByUser;

/** Once sent, the comments leave the document: the agent has them in the message. */
export function clearReview(previous: Artifact): Artifact {
  return { ...previous, revision: previous.revision + 1, comments: [], editedByUser: false };
}

const QUOTE_MAX = 200;

function shortQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
}

/**
 * The message sent to the agent when the user validates a review. Kept short:
 * it shows in the chat, and the document itself stays out of it (the agent
 * reads it with artifact_read when the user edited it).
 */
export function reviewMessage(artifact: Artifact): string {
  const lines = [`Review of the artifact "${artifact.title}":`];
  if (artifact.editedByUser) lines.push("", "I edited the text directly. Read it with artifact_read before revising.");
  if (artifact.comments.length > 0) {
    lines.push("", "Comments:");
    artifact.comments.forEach((comment, index) => {
      const on = comment.quote ? `On "${shortQuote(comment.quote)}": ` : "";
      lines.push(`${index + 1}. ${on}${comment.note}`);
    });
  }
  lines.push("", "Revise the artifact accordingly with artifact_edit or artifact_write, then reply briefly.");
  return lines.join("\n");
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

/** The document as the agent reads it. */
export function renderForModel(artifact: Artifact): string {
  if (!exists(artifact)) return "This session has no artifact yet.";
  return `# ${artifact.title} (revision ${artifact.revision})\n\n${artifact.content}`;
}
