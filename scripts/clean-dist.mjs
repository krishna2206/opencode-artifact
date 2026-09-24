import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "..", "dist");

// Empties dist instead of deleting it: opencode watches this directory to hot
// reload the plugin, and on macOS a watcher left on a deleted directory stays
// silent, so every later build would go unnoticed until opencode restarts.
await mkdir(dist, { recursive: true });
for (const entry of await readdir(dist)) {
  await rm(resolve(dist, entry), { recursive: true, force: true });
}
