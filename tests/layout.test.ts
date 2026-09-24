import { describe, expect, it } from "bun:test";
import type { Comment } from "../src/artifact";
import { layout, splitBlocks } from "../src/layout";

const source = "# Plan\n\nFirst paragraph.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n";
const comment = (quote: string, id = quote): Comment => ({ id, quote, note: "n", createdAt: 0 });

describe("splitBlocks", () => {
  it("keeps the top-level blocks with their source offsets", () => {
    const blocks = splitBlocks(source);
    expect(blocks.map((block) => block.raw.trim())).toEqual([
      "# Plan",
      "First paragraph.",
      "- one\n- two",
      "```ts\nconst x = 1;\n```",
    ]);
    for (const block of blocks) expect(source.slice(block.start, block.end)).toBe(block.raw);
  });
});

describe("layout", () => {
  it("puts each comment under the block where its passage ends", () => {
    const { blocks, trailing } = layout(source, [
      comment("paragraph"),
      comment("two"),
      comment("First paragraph. one", "across"),
      comment("", "general"),
      comment("gone", "missing"),
    ]);
    expect(blocks[1]!.comments.map((c) => c.id)).toEqual(["paragraph"]);
    expect(blocks[2]!.comments.map((c) => c.id)).toEqual(["two", "across"]);
    expect(trailing.map((c) => c.id)).toEqual(["general", "missing"]);
  });
});

describe("images", () => {
  it("pulls the images out of a paragraph, and drops its text when it has none", () => {
    const blocks = splitBlocks("![Diagram](docs/a.png)\n\nSee ![one](x.png) and [![two](y.png)](https://z)\n");
    expect(blocks[0]!.text).toBe(false);
    expect(blocks[0]!.images).toEqual([{ src: "docs/a.png", alt: "Diagram" }]);
    expect(blocks[1]!.text).toBe(true);
    expect(blocks[1]!.images.map((image) => image.src)).toEqual(["x.png", "y.png"]);
  });

  it("keeps several images on their own as an image-only block", () => {
    const [block] = splitBlocks("![a](a.png)\n![b](b.png)\n");
    expect(block!.text).toBe(false);
    expect(block!.images).toHaveLength(2);
  });
});
