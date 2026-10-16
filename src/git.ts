import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Sandbox } from "@vercel/sandbox";
import { WORKSPACE } from "./config.js";

const execute = promisify(execFile);

export async function git(directory: string, args: string[]) {
  return (await execute("git", ["-C", directory, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

export async function sourceBundle(directory: string) {
  const head = await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const root = await git(directory, ["rev-parse", "--show-toplevel"]);
  const temporary = await mkdtemp(join(tmpdir(), "opencode-source-"));
  try {
    const bundle = join(temporary, "source.bundle");
    await git(root, ["bundle", "create", bundle, "HEAD"]);
    if (await git(root, ["rev-parse", "HEAD"]) !== head) throw new Error("HEAD changed during workspace creation; retry after finishing the local edit.");
    return { content: await readFile(bundle), head };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function checkedCommand(sandbox: Sandbox, cmd: string, args: string[], cwd = WORKSPACE) {
  const result = await sandbox.runCommand({ cmd, args, cwd, signal: AbortSignal.timeout(180_000) });
  if (result.exitCode !== 0) throw new Error(`${cmd} failed with exit ${result.exitCode} in ${sandbox.name}; inspect the Sandbox command logs.`);
  return result;
}

export async function exportBranch(sandbox: Sandbox, directory: string) {
  const base = (await sandbox.readFileToBuffer({ path: "/vercel/sandbox/source-head" }))?.toString("utf8").trim();
  if (!base || !/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Workspace source revision is missing");
  await git(directory, ["cat-file", "-e", `${base}^{commit}`]);
  const suffix = randomUUID();
  const remoteRef = `refs/opencode-export/${suffix}`;
  const remoteBundle = `/tmp/opencode-export-${suffix}.bundle`;
  const remoteIndex = `/tmp/opencode-export-${suffix}.index`;
  const script = [
    'set -eu',
    'export GIT_INDEX_FILE="$1"',
    'git read-tree HEAD',
    'git add -A',
    'tree=$(git write-tree)',
    'commit=$(printf "Export Sandbox workspace\\n" | git -c user.name="Sandbox workspace" -c user.email="sandbox@localhost" commit-tree "$tree" -p HEAD)',
    'git update-ref "$2" "$commit"',
    'git bundle create "$3" "$2"',
    'git update-ref -d "$2"',
    'rm -f "$1"',
  ].join("\n");
  await checkedCommand(sandbox, "bash", ["-c", script, "export", remoteIndex, remoteRef, remoteBundle]);
  const bytes = await sandbox.readFileToBuffer({ path: remoteBundle });
  if (!bytes) throw new Error("Sandbox export bundle is missing");
  const temporary = await mkdtemp(join(tmpdir(), "opencode-export-"));
  const branch = `vercel-sandbox/${sandbox.name}/${suffix}`;
  try {
    const bundle = join(temporary, "export.bundle");
    await writeFile(bundle, bytes);
    await git(directory, ["bundle", "verify", bundle]);
    const references = await git(directory, ["bundle", "list-heads", bundle, remoteRef]);
    const commit = references.split(" ")[0];
    if (!commit || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid exported revision");
    await git(directory, ["fetch", "--no-tags", "--no-write-fetch-head", bundle, remoteRef]);
    await git(directory, ["branch", branch, commit]);
    return branch;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
