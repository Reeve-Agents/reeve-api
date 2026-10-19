// Puts reeve-runtime into runtime/ when the git submodule is not checked out (e.g. a CreateOS build,
// which has neither git nor curl). Uses only Node: the GitHub tree API plus raw file downloads.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime");
if (existsSync(join(root, "reeve_runtime", "job.py"))) process.exit(0);

const repo = "Reeve-Agents/reeve-runtime";
const tree = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, { headers: { accept: "application/vnd.github+json" } });
if (!tree.ok) throw new Error(`GitHub tree for ${repo}: HTTP ${tree.status}`);
const files = (await tree.json()).tree.filter((e) => e.type === "blob");
for (const f of files) {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/${f.path}`);
  if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
  const out = join(root, f.path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}
console.log(`runtime: fetched ${files.length} files from ${repo}`);
