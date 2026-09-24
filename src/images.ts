// Where an image of the document comes from, for the read view. The image
// component loads files, file:, http(s): and data: URLs itself; this only
// decides what it gets, so a relative path is read from the session's
// directory rather than from wherever opencode was started.

import { isAbsolute, join } from "node:path";

export interface ImageRef {
  /** As written in the Markdown. */
  src: string;
  alt: string;
}

export type ResolvedImage =
  | { kind: "file" | "remote" | "data"; source: string }
  | { kind: "blocked"; reason: string };

export interface ResolveOptions {
  /** The session's directory, for relative paths. */
  directory: string | undefined;
  home: string;
  /** Whether http(s) images may be fetched. */
  remote: boolean;
}

export function resolveImage(src: string, options: ResolveOptions): ResolvedImage {
  const value = src.trim();
  if (!value) return { kind: "blocked", reason: "empty image source" };
  if (/^https?:\/\//i.test(value)) {
    return options.remote ? { kind: "remote", source: value } : { kind: "blocked", reason: "remote images are off" };
  }
  if (/^data:/i.test(value)) return { kind: "data", source: value };
  if (/^file:\/\//i.test(value)) return { kind: "file", source: value };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: "blocked", reason: `unsupported source ${value.split(":")[0]}:` };
  // Markdown paths may be URL-encoded (spaces as %20).
  let path = value;
  try {
    path = decodeURI(value);
  } catch {
    // Not valid percent-encoding: take the path as written.
  }
  if (path === "~" || path.startsWith("~/")) return { kind: "file", source: join(options.home, path.slice(1)) };
  if (isAbsolute(path)) return { kind: "file", source: path };
  if (!options.directory) return { kind: "blocked", reason: "no session directory for a relative path" };
  return { kind: "file", source: join(options.directory, path) };
}
