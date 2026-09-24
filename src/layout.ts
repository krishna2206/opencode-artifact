// How the read view lays the document out: its top-level Markdown blocks,
// each followed by the comments on it. Comments that cannot be placed (a
// general comment, or a passage no longer in the text) go after the last block.

import { Lexer } from "marked";
import { locateQuote, type Comment } from "./artifact.js";

export interface Block {
  /** The block's Markdown source. */
  raw: string;
  start: number;
  end: number;
  comments: Comment[];
}

export interface Layout {
  blocks: Block[];
  trailing: Comment[];
}

/** The top-level blocks, blank lines left out, with their offsets in the source. */
export function splitBlocks(content: string): Omit<Block, "comments">[] {
  const blocks: Omit<Block, "comments">[] = [];
  let offset = 0;
  for (const token of Lexer.lex(content)) {
    const start = content.indexOf(token.raw, offset);
    // The lexer normalises some sources (tabs, line endings): fall back on the running offset.
    const at = start >= 0 ? start : offset;
    offset = at + token.raw.length;
    if (token.type === "space" || !token.raw.trim()) continue;
    blocks.push({ raw: token.raw, start: at, end: offset });
  }
  return blocks;
}

/** Each comment goes under the block where its passage ends. */
export function layout(content: string, comments: readonly Comment[]): Layout {
  const blocks: Block[] = splitBlocks(content).map((block) => ({ ...block, comments: [] }));
  const trailing: Comment[] = [];
  for (const comment of comments) {
    const range = locateQuote(content, comment.quote);
    const block = range && blocks.find((candidate) => range.end > candidate.start && range.end <= candidate.end);
    if (block) block.comments.push(comment);
    else trailing.push(comment);
  }
  return { blocks, trailing };
}
