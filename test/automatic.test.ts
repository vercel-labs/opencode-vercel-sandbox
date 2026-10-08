import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Sandbox } from "@vercel/sandbox";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { execFileSync } from "node:child_process";
import { automatic } from "../src/automatic.js";
import { Sessions, automaticSchema, credentialScope } from "../src/automatic/session.js";
import { Store, identity } from "../src/automatic/state.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-auto-test-"));
  const store = new Store(root);
  const calls = { creates: 0, gets: 0, stop: 0, init: 0, sync: 0, env: {} as unknown };
  const sandbox = { name: "fixture", writeFiles: async () => {}, runCommand: async () => { calls.init++; return { exitCode: 0 }; }, stop: async () => { calls.stop++; } } as unknown as Sandbox;
  const dependencies = {
    store,
    credentials: async () => ({ token: "management-only", teamId: "team", projectId: "project" }),
    source: async () => ({ head: "a".repeat(40), content: Buffer.from("bundle") }),
    service: {
      create: async (options: unknown) => { calls.creates++; calls.env = (options as { env: unknown }).env; await sleep(10); return sandbox; },
      get: async () => { calls.gets++; return sandbox; },
    } as unknown as Pick<typeof Sandbox, "create" | "get">,
    synchronize: async () => { calls.sync++; return "b".repeat(40); },
  };
  const options = automaticSchema.parse({ mode: "automatic" });
  const sessions = new Sessions("project", root, options, dependencies);
  return { root, store, calls, sandbox, dependencies, options, sessions, key: identity("project", root, "one", JSON.stringify(["team", "project"])).key };
}

test("automatic configuration is opt-in and rejects credential forwarding and workspace-only options", () => {
  assert.throws(() => automaticSchema.parse({}));
  for (const option of [{ forwardEnv: ["AI_GATEWAY_API_KEY"] }, { remoteConfig: {} }, { typo: true }, { timeoutMs: 1 }, { vcpus: 3 }]) assert.throws(() => automaticSchema.parse({ mode: "automatic", ...option }));
  assert.equal(automaticSchema.parse({ mode: "automatic" }).image, "vercel/sandbox/universal");
});

test("concurrent calls and independent managers share one allocation and private atomic state", async () => {
  const setup = await fixture();
  const other = new Sessions("project", setup.root, setup.options, setup.dependencies);
  const results = await Promise.all([setup.sessions.run("one", async () => "first"), other.run("one", async () => "second"), setup.sessions.run("one", async () => "third")]);
  assert.deepEqual(results, ["first", "second", "third"]);
  assert.equal(setup.calls.creates, 1);
  assert.deepEqual(setup.calls.env, {});
  assert.equal((await stat(setup.store.path(setup.key))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(setup.store.path(setup.key), "utf8")).includes("management-only"));
  assert.equal((await setup.store.read(setup.key))?.phase, "ready");
});

test("restart reconnects, session identity isolates worktrees and projects", async () => {
  const setup = await fixture();
  await setup.sessions.run("one", async () => {});
  await new Sessions("project", setup.root, setup.options, setup.dependencies).run("one", async () => {});
  assert.equal(setup.calls.creates, 1);
  assert.equal(setup.calls.gets, 1);
  const scope = JSON.stringify(["team", "project"]);
  assert.notEqual(identity("other", setup.root, "one", scope).key, setup.key);
  assert.notEqual(identity("project", `${setup.root}/other`, "one", scope).key, setup.key);
  assert.notEqual(identity("project", setup.root, "two", scope).key, setup.key);
});

test("missing credentials and cancelled requests allocate nothing", async () => {
  const setup = await fixture();
  const failed = new Sessions("project", setup.root, setup.options, { ...setup.dependencies, credentials: async () => { throw new Error("missing credentials"); } });
  await assert.rejects(failed.run("one", async () => { throw new Error("action executed"); }), /missing credentials/);
  await assert.rejects(setup.sessions.run("one", async () => { throw new Error("action executed"); }, AbortSignal.abort()), /abort/i);
  assert.equal(setup.calls.creates, 0);
});

test("partial setup preserves state and refuses to reset or reallocate", async () => {
  const setup = await fixture();
  const failed = new Sessions("project", setup.root, setup.options, { ...setup.dependencies, service: { ...setup.dependencies.service, create: async () => { setup.calls.creates++; throw new Error("transport failed"); } } });
  await assert.rejects(failed.run("one", async () => {}), /transport failed/);
  await assert.rejects(setup.sessions.run("one", async () => {}), /Incomplete setup/);
  assert.equal(setup.calls.creates, 1);
  assert.equal((await setup.store.read(setup.key))?.phase, "initializing");
});

test("idle sync allocates nothing for unused sessions and serializes after mutations", async () => {
  const setup = await fixture();
  await setup.sessions.idle("one");
  assert.equal(setup.calls.creates, 0);
  let complete = false;
  const mutation = setup.sessions.run("one", async () => { await sleep(40); complete = true; });
  await mutation;
  setup.dependencies.synchronize = async () => { assert.equal(complete, true); return "b".repeat(40); };
  await setup.sessions.idle("one");
  assert.equal((await setup.store.read(setup.key))?.sync, "synced");
  assert.equal((await setup.store.read(setup.key))?.returned, "b".repeat(40));
});

test("sync failure survives restart and refuses stop; explicit retry awaits success", async () => {
  const setup = await fixture();
  await setup.sessions.run("one", async () => {});
  setup.dependencies.synchronize = async () => { throw new Error("return conflict"); };
  await assert.rejects(setup.sessions.sync("one", true), /return conflict/);
  assert.equal(setup.calls.stop, 0);
  const restartedStore = new Store(setup.root);
  assert.equal((await restartedStore.read(setup.key))?.sync, "failed");
  assert.match((await restartedStore.read(setup.key))?.error ?? "", /Git return failed/);
  const restarted = new Sessions("project", setup.root, setup.options, { ...setup.dependencies, store: restartedStore, synchronize: async () => { await sleep(20); return "c".repeat(40); } });
  assert.match(await restarted.sync("one", true), /Stopped; files retained/);
  assert.equal(setup.calls.creates, 1);
  assert.equal(setup.calls.stop, 1);
  assert.equal((await setup.store.read(setup.key))?.returned, "c".repeat(40));
  const gets = setup.calls.gets;
  await restarted.idle("one");
  await restarted.dispose();
  assert.equal(setup.calls.gets, gets, "idle/dispose must not resume a stopped Sandbox");
});

test("pending sync survives restart and returns edits without another allocation", async () => {
  const setup = await fixture();
  await setup.sessions.run("one", async () => {});
  const restartedStore = new Store(setup.root);
  assert.equal((await restartedStore.read(setup.key))?.sync, "pending");
  const restarted = new Sessions("project", setup.root, setup.options, { ...setup.dependencies, store: restartedStore });
  assert.match(await restarted.sync("one"), /Synced/);
  assert.equal((await restartedStore.read(setup.key))?.sync, "synced");
  assert.equal((await restartedStore.read(setup.key))?.returned, "b".repeat(40));
  assert.equal(setup.calls.creates, 1);
  assert.equal(setup.calls.gets, 1);
  await restarted.dispose();
});

test("disposal drains bounded work and refuses new tools", async () => {
  const setup = await fixture();
  await setup.sessions.run("one", async () => {});
  setup.dependencies.synchronize = async () => { await sleep(100); return "c".repeat(40); };
  assert.equal(await setup.sessions.dispose(5), false);
  await assert.rejects(setup.sessions.run("one", async () => {}), /closing/);
  await sleep(150);
});

test("disposal during first initialization waits and returns the first tool's edits", async () => {
  const setup = await fixture();
  let edited = false;
  setup.dependencies.synchronize = async () => { assert.equal(edited, true); return "d".repeat(40); };
  const first = setup.sessions.run("one", async () => { edited = true; });
  assert.equal(await setup.sessions.dispose(), true);
  await first;
  assert.equal((await setup.store.read(setup.key))?.returned, "d".repeat(40));
  assert.equal((await setup.store.read(setup.key))?.sync, "synced");
});

test("cancellation after provisioning starts preserves incomplete state and does not initialize or run tools", async () => {
  const setup = await fixture();
  const controller = new AbortController();
  let toolRan = false;
  setup.dependencies.service.create = (async () => { setup.calls.creates++; controller.abort(); return setup.sandbox; }) as typeof setup.dependencies.service.create;
  await assert.rejects(setup.sessions.run("one", async () => { toolRan = true; }, controller.signal), /abort/i);
  assert.equal(toolRan, false);
  assert.equal(setup.calls.init, 0);
  assert.equal((await setup.store.read(setup.key))?.phase, "initializing");
});

test("cancellation during sync reaches the synchronizer and cannot stop the VM", async () => {
  const setup = await fixture();
  await setup.sessions.run("one", async () => {});
  const controller = new AbortController();
  const synchronizer = async (_sandbox: unknown, _directory: string, _record: unknown, signal?: AbortSignal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    signal?.throwIfAborted();
    return "e".repeat(40);
  };
  const manager = new Sessions("project", setup.root, setup.options, { ...setup.dependencies, synchronize: synchronizer });
  await assert.rejects(manager.sync("one", true, controller.signal), /abort/i);
  assert.equal(setup.calls.stop, 0);
  assert.equal((await setup.store.read(setup.key))?.returned, null);
});

test("Vercel scopes isolate identical local sessions and OIDC token rotation preserves identity", async () => {
  const setup = await fixture();
  await setup.sessions.run("one", async () => {});
  const other = new Sessions("project", setup.root, setup.options, { ...setup.dependencies, credentials: async () => ({ token: "other", teamId: "team", projectId: "other-project" }) });
  await other.run("one", async () => {});
  assert.equal(setup.calls.creates, 2);
  const token = (owner: string, project: string, issued: number) => `header.${Buffer.from(JSON.stringify({ owner_id: owner, project_id: project, iat: issued })).toString("base64url")}.signature`;
  const first = credentialScope({}, { VERCEL_OIDC_TOKEN: token("team", "project", 1) });
  assert.equal(first, credentialScope({}, { VERCEL_OIDC_TOKEN: token("team", "project", 2) }));
  assert.notEqual(first, credentialScope({}, { VERCEL_OIDC_TOKEN: token("team", "other", 1) }));
  assert.throws(() => credentialScope({}, {}), /scope is unavailable/);
});

test("a hung notification cannot extend the disposal deadline", async () => {
  const setup = await fixture();
  const manager = new Sessions("project", setup.root, setup.options, {
    ...setup.dependencies,
    notify: async () => new Promise<void>(() => {}),
    synchronize: async () => new Promise<string>(() => {}),
  });
  await manager.run("one", async () => {});
  assert.equal(await Promise.race([manager.dispose(5), sleep(100).then(() => "OUTER_TIMEOUT")]), false);
});

for (const scenario of ["outside-git", "invalid-options", "additional-plugin"]) {
  test(`automatic startup stays blocked for ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-auto-startup-"));
    if (scenario !== "outside-git") execFileSync("git", ["init", "-q", root]);
    const context = { project: { id: "fixture" }, worktree: root } as PluginInput;
    const notifications: string[] = [];
    const hooks = await automatic(context, { mode: "automatic", ...(scenario === "invalid-options" ? { typo: true } : {}) }, { notify: async (message) => { notifications.push(message); } });
    const config: Parameters<NonNullable<Hooks["config"]>>[0] = { plugin: scenario === "additional-plugin" ? ["sandbox", "other"] : ["sandbox"], lsp: {}, mcp: {}, permission: "allow" };
    await hooks.config!(config);
    assert.equal(config.lsp, false);
    assert.deepEqual(config.mcp, {});
    assert.equal(typeof config.permission === "object" && config.permission.task, "deny");
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "fixture", callID: "fixture" }, { args: {} }), /Automatic mode is blocked/);
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "read", sessionID: "fixture", callID: "fixture" }, { args: {} }), /Automatic mode is blocked/);
    await assert.rejects(hooks["shell.env"]!({ cwd: root }, { env: {} }), /Automatic mode is blocked/);
    await assert.rejects(hooks["chat.message"]!({ sessionID: "fixture" }, {} as Parameters<NonNullable<Hooks["chat.message"]>>[1]), /Automatic mode is blocked/);
    await hooks.dispose!();
    assert.ok(notifications.some((message) => message.includes("Fix the setup and restart OpenCode")));
  });
}
