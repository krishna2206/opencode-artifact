// How the read view lays the document out: its top-level Markdown blocks,
// each followed by the comments on it. Comments that cannot be placed (a
// passage no longer in the text) go after the last block. The images of a
// paragraph are pulled out of it: the Markdown component only shows their
// caption, the read view draws them below the paragraph's text.

import { Lexer, type Token } from "marked";
import { locateQuote, type Comment } from "./artifact.js";
import type { ImageRef } from "./images.js";

export interface Block {
  /** The block's Markdown source. */
  raw: string;
  start: number;
  end: number;
  /** Whether the block has text to render: false for a paragraph made only of images. */
  text: boolean;
  images: ImageRef[];
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
    const inline = token.type === "paragraph" ? (token.tokens ?? []) : [];
    const images = paragraphImages(inline);
    const text = images.length === 0 || !onlyImages(inline);
    blocks.push({ raw: token.raw, start: at, end: offset, text, images });
  }
  return blocks;
}

/** The images of a paragraph, including one wrapped in a link. */
function paragraphImages(tokens: readonly Token[]): ImageRef[] {
  return tokens.flatMap((token): ImageRef[] => {
    if (token.type === "image") return [{ src: token.href, alt: token.text }];
    if ("tokens" in token && Array.isArray(token.tokens)) return paragraphImages(token.tokens);
    return [];
  });
}

/** A paragraph with nothing but images and blank space between them. */
function onlyImages(tokens: readonly Token[]): boolean {
  return tokens.every(
    (token) =>
      token.type === "image" ||
      token.type === "br" ||
      (token.type === "text" && !token.raw.trim()) ||
      (token.type === "link" && Array.isArray(token.tokens) && onlyImages(token.tokens)),
  );
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
