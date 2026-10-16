import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Sandbox } from "@vercel/sandbox";
import { WORKSPACE } from "../config.js";
import type { SessionRecord } from "./state.js";

const execute = promisify(execFile);
export async function safeGit(directory: string, args: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.fsckObjects=true", "-C", directory, ...args], {
    maxBuffer: 4 * 1024 * 1024, timeout: 30_000, signal,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  })).stdout.trim();
}

export async function bundleSource(directory: string, signal?: AbortSignal) {
  const head = await safeGit(directory, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  const temporary = await mkdtemp(join(tmpdir(), "opencode-auto-source-"));
  try {
    const path = join(temporary, "source.bundle");
    await safeGit(directory, ["bundle", "create", path, "HEAD"], signal);
    if (await safeGit(directory, ["rev-parse", "HEAD"], signal) !== head) throw new Error("HEAD changed during source capture; retry.");
    const content = await readFile(path);
    if (content.length > 64 * 1024 * 1024) throw new Error("Source bundle exceeds the automatic-mode 64 MiB limit.");
    return { head, content };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function assertReturnBranch(directory: string, record: SessionRecord, signal?: AbortSignal) {
  const full = `refs/heads/${record.branch}`;
  const worktrees = await safeGit(directory, ["worktree", "list", "--porcelain"], signal);
  if (worktrees.split("\n").includes(`branch ${full}`)) throw new Error(`Return branch ${record.branch} is checked out. Switch away before syncing.`);
  const current = await safeGit(directory, ["for-each-ref", "--format=%(objectname)", full], signal);
  if (current !== (record.returned ?? "")) throw new Error(`Return branch ${record.branch} changed outside this session. Preserve it and resolve the conflict before syncing.`);
}

export async function returnBundle(directory: string, record: SessionRecord, bytes: Buffer, remoteRef: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Return bundle exceeds 64 MiB; sandbox preserved.");
  const temporary = await mkdtemp(join(tmpdir(), "opencode-auto-return-"));
  try {
    const bundle = join(temporary, "return.bundle");
    await writeFile(bundle, bytes, { mode: 0o600 });
    await safeGit(directory, ["bundle", "verify", bundle], signal);
    const references = await safeGit(directory, ["bundle", "list-heads", bundle], signal);
    const lines = references.split("\n");
    if (lines.length !== 1 || !lines[0]?.endsWith(` ${remoteRef}`)) throw new Error("Unexpected return bundle references");
    const commit = lines[0].split(" ")[0]!;
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid returned commit");
    await assertReturnBranch(directory, record, signal);
    await safeGit(directory, ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", bundle, remoteRef], signal);
    await safeGit(directory, ["merge-base", "--is-ancestor", record.base, commit], signal);
    await assertReturnBranch(directory, record, signal);
    await safeGit(directory, ["update-ref", `refs/heads/${record.branch}`, commit, record.returned ?? "0".repeat(commit.length)], signal);
    return commit;
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}

export async function synchronize(sandbox: Sandbox, directory: string, record: SessionRecord, signal?: AbortSignal) {
  await assertReturnBranch(directory, record, signal);
  const suffix = randomUUID();
  const remoteRef = `refs/opencode-return/${suffix}`;
  const bundle = `/tmp/opencode-return-${suffix}.bundle`;
  const index = `/tmp/opencode-return-${suffix}.index`;
  const script = [
    "set -eu", 'export GIT_INDEX_FILE="$1"', 'trap \'rm -f "$GIT_INDEX_FILE"\' EXIT',
    'git -c core.hooksPath=/dev/null read-tree HEAD', 'git -c core.hooksPath=/dev/null add -A',
    'tree=$(git write-tree)',
    'commit=$(printf "Sandbox automatic return\\n" | git -c user.name="Sandbox" -c user.email="sandbox@localhost" commit-tree "$tree" -p "$4")',
    'git update-ref "$2" "$commit"', 'git bundle create "$3" "$2"', 'git update-ref -d "$2"',
    'test "$(stat -c %s "$3")" -le 67108864',
  ].join("\n");
  const result = await sandbox.runCommand({ cmd: "timeout", args: ["60s", "bash", "-c", script, "return", index, remoteRef, bundle, record.base], cwd: WORKSPACE, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  if (result.exitCode !== 0) throw new Error(`Remote Git return failed (${result.exitCode}); sandbox preserved.`);
  signal?.throwIfAborted();
  const bytes = await sandbox.readFileToBuffer({ path: bundle }, { signal });
  if (!bytes) throw new Error("Return bundle missing; sandbox preserved.");
  const commit = await returnBundle(directory, record, bytes, remoteRef, signal);
  await sandbox.runCommand({ cmd: "rm", args: ["-f", bundle], signal: AbortSignal.timeout(10_000) }).catch(() => {});
  return commit;
}
