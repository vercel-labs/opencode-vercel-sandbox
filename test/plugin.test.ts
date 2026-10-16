import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Sandbox } from "@vercel/sandbox";
import plugin from "../src/index.js";
import { optionsSchema, remoteEnvironment, sandboxCredentials } from "../src/config.js";
import { sandboxName, passwordFor } from "../src/state.js";
import { checkedCommand, exportBranch, git, sourceBundle } from "../src/git.js";
import { createAdapter } from "../src/workspace.js";

const execute = promisify(execFile);
const workspace = { id: "wrk_example", projectID: "project", type: "vercel-sandbox", name: "Example", branch: null, directory: null, extra: null };

test("modern server export registers one native workspace without replacing tools", async () => {
  const entries: string[] = [];
  const hooks = await plugin.server({ directory: "/tmp", experimental_workspace: { register(type: string) { entries.push(type); } } } as never);
  assert.deepEqual(entries, ["vercel-sandbox"]);
  assert.deepEqual(hooks, {});
});

test("configuration rejects control-plane credentials and invalid resource options", () => {
  for (const name of ["VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "PATH", "NODE_OPTIONS", "OPENCODE_SERVER_PASSWORD", "GIT_SSH_COMMAND"]) {
    assert.throws(() => optionsSchema.parse({ forwardEnv: [name] }));
  }
  for (const options of [{ timeoutMs: 0 }, { vcpus: 3 }, { previewPorts: [4096] }, { misspelledOption: true }]) {
    assert.throws(() => optionsSchema.parse(options));
  }
});

test("remote environment contains only placeholder Gateway credentials", () => {
  const options = optionsSchema.parse({ remoteConfig: { model: "vercel/openai/gpt-5.4-mini" } });
  const env = remoteEnvironment(options, "wrk_example");
  assert.equal("AI_GATEWAY_API_KEY" in env, false);
  assert.equal(JSON.parse(env.OPENCODE_AUTH_CONTENT).vercel.key, "vercel-sandbox-broker-placeholder");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal("VERCEL_TOKEN" in env, false);
  assert.equal("UNRELATED" in env, false);
  assert.throws(() => optionsSchema.parse({ forwardEnv: [] }));
  assert.throws(() => optionsSchema.parse({ remoteConfig: { provider: {} } }));
  assert.throws(() => remoteEnvironment(optionsSchema.parse({}), "wrk_example"), /remoteConfig.model/);
});

test("access token requires complete scope and OIDC takes precedence", () => {
  assert.throws(() => sandboxCredentials({ VERCEL_TOKEN: "token" }), /Set VERCEL_OIDC_TOKEN/);
  assert.deepEqual(sandboxCredentials({ VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" }), { token: "token", teamId: "team", projectId: "project" });
  assert.deepEqual(sandboxCredentials({ VERCEL_OIDC_TOKEN: "oidc" }), {});
});

test("workspace names are isolated across projects and local keys survive concurrent initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-keys-"));
  try {
    const name = sandboxName("project-a", "workspace");
    assert.notEqual(name, sandboxName("project-b", "workspace"));
    assert.notEqual(sandboxName("a:b", "c"), sandboxName("a", "b:c"));
    const passwords = await Promise.all(Array.from({ length: 8 }, () => passwordFor(name, true, directory)));
    assert.equal(new Set(passwords).size, 1);
    assert.equal((await stat(join(directory, `${name}.key`))).mode & 0o777, 0o600);
    assert.equal(await passwordFor(name, false, directory), passwords[0]);
    await assert.rejects(passwordFor(sandboxName("missing", "workspace"), false, directory), /Missing local credential/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("public workspace metadata contains no credentials and ignores supplied sandbox identity", async () => {
  const adapter = createAdapter({ directory: "/tmp" });
  const configured = await adapter.configure({ ...workspace, extra: { sandboxName: "someone-else", password: "bad" } });
  assert.deepEqual(configured.extra, { sandboxName: sandboxName(workspace.projectID, workspace.id) });
  assert.equal(configured.directory, "/vercel/sandbox/project");
  await assert.rejects(adapter.create(workspace, {}, workspace), /Forking existing workspaces/);
});

test("failed commands surface exit status without echoing potentially secret output", async () => {
  const sandbox = { name: "fixture", runCommand: async () => ({ exitCode: 7, stderr: async () => "credential-value" }) } as unknown as Sandbox;
  await assert.rejects(checkedCommand(sandbox, "npm", ["install"]), (error: Error) => error.message.includes("exit 7") && !error.message.includes("credential-value"));
});

test("Git transfer exports tracked, deleted, binary and untracked files without changing local HEAD or index", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-git-"));
  const local = join(root, "local");
  const remote = join(root, "remote");
  try {
    await execute("git", ["init", local]);
    await git(local, ["config", "user.email", "test@localhost"]);
    await git(local, ["config", "user.name", "Fixture"]);
    await writeFile(join(local, "tracked.txt"), "initial\n");
    await writeFile(join(local, "deleted.txt"), "delete me\n");
    await writeFile(join(local, ".gitignore"), "ignored.txt\n");
    await git(local, ["add", "."]);
    await git(local, ["commit", "-m", "fixture"]);
    await writeFile(join(local, "tracked.txt"), "local staged change\n");
    await git(local, ["add", "tracked.txt"]);
    await writeFile(join(local, "tracked.txt"), "local unstaged change\n");
    const localStatus = await git(local, ["status", "--porcelain"]);
    const localIndex = await git(local, ["diff", "--cached"]);
    const source = await sourceBundle(local);
    const bundle = join(root, "source.bundle");
    await writeFile(bundle, source.content);
    await execute("git", ["clone", bundle, remote]);
    assert.equal(await readFile(join(remote, "tracked.txt"), "utf8"), "initial\n");
    await writeFile(join(remote, "tracked.txt"), "remote edit\n");
    await writeFile(join(remote, "new.txt"), "new file\n");
    await writeFile(join(remote, "binary.dat"), Buffer.from([0, 255, 42]));
    await writeFile(join(remote, "ignored.txt"), "excluded\n");
    await rm(join(remote, "deleted.txt"));
    const sandbox = {
      name: sandboxName("fixture", "workspace"),
      async runCommand({ cmd, args }: { cmd: string; args: string[] }) {
        const result = await execute(cmd, args, { cwd: remote });
        return { exitCode: 0, stdout: async () => result.stdout };
      },
      async readFileToBuffer({ path }: { path: string }) {
        return path === "/vercel/sandbox/source-head" ? Buffer.from(source.head) : readFile(path);
      },
    } as unknown as Sandbox;
    const branch = await exportBranch(sandbox, local);
    assert.equal(await git(local, ["rev-parse", "HEAD"]), source.head);
    assert.equal(await git(local, ["status", "--porcelain"]), localStatus);
    assert.equal(await git(local, ["diff", "--cached"]), localIndex);
    assert.equal(await git(local, ["show", `${branch}:tracked.txt`]), "remote edit");
    assert.equal(await git(local, ["show", `${branch}:new.txt`]), "new file");
    const files = await git(local, ["ls-tree", "--name-only", branch]);
    assert.ok(files.includes("binary.dat"));
    assert.ok(!files.includes("deleted.txt"));
    assert.ok(!files.includes("ignored.txt"));
    assert.equal(await git(remote, ["rev-parse", "HEAD"]), source.head);
    assert.equal(await git(remote, ["diff", "--cached"]), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
