import { describe, expect, it } from "bun:test";
import { resolveImage } from "../src/images";

const options = { directory: "/work/project", home: "/home/me", remote: true };

describe("resolveImage", () => {
  it("reads relative paths from the session directory", () => {
    expect(resolveImage("docs/a.png", options)).toEqual({ kind: "file", source: "/work/project/docs/a.png" });
    expect(resolveImage("my%20shot.png", options)).toEqual({ kind: "file", source: "/work/project/my shot.png" });
    expect(resolveImage("docs/a.png", { ...options, directory: undefined }).kind).toBe("blocked");
  });

  it("expands ~ and keeps absolute paths and file URLs", () => {
    expect(resolveImage("~/Pictures/b.png", options)).toEqual({ kind: "file", source: "/home/me/Pictures/b.png" });
    expect(resolveImage("/tmp/c.png", options)).toEqual({ kind: "file", source: "/tmp/c.png" });
    expect(resolveImage("file:///tmp/c.png", options)).toEqual({ kind: "file", source: "file:///tmp/c.png" });
  });

  it("fetches remote images only when allowed, and refuses other schemes", () => {
    expect(resolveImage("https://x.y/i.png", options)).toEqual({ kind: "remote", source: "https://x.y/i.png" });
    expect(resolveImage("https://x.y/i.png", { ...options, remote: false })).toEqual({
      kind: "blocked",
      reason: "remote images are off",
    });
    expect(resolveImage("data:image/png;base64,AAA", options).kind).toBe("data");
    expect(resolveImage("ftp://x/i.png", options).kind).toBe("blocked");
  });
});
