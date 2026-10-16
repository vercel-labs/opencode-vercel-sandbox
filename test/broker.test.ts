import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import { gatewayKey, gatewayPolicy, GATEWAY_PLACEHOLDER, brokerScope } from "../src/broker.js";
import { createAdapter } from "../src/workspace.js";
import { brokerState, sandboxName, withWorkspaceLock } from "../src/state.js";
import { optionsSchema } from "../src/config.js";

const model = "vercel/openai/gpt-5.4-mini";
const secret = "synthetic-gateway-key-one";
const workspace = { id: "wrk_broker", projectID: "project", type: "vercel-sandbox", name: "Example", branch: null, directory: null, extra: null };
const emptyAuth = async () => "{}";

test("host resolves only a Gateway API key and ignores other saved providers", async () => {
  const inherited = { OPENCODE_AUTH_CONTENT: JSON.stringify({ vercel: { type: "api", key: secret }, anthropic: { type: "oauth", access: "unrelated-key" } }) };
  assert.equal(await gatewayKey(inherited, {}, emptyAuth), secret);
  assert.equal(await gatewayKey(undefined, { AI_GATEWAY_API_KEY: secret }, emptyAuth), secret);
  assert.equal(await gatewayKey(undefined, {}, async () => inherited.OPENCODE_AUTH_CONTENT), secret);
  assert.equal(await gatewayKey(undefined, { OPENCODE_AUTH_CONTENT: inherited.OPENCODE_AUTH_CONTENT }, emptyAuth), secret);
});

test("an explicit host API key works alongside saved non-API Gateway auth", async () => {
  const content = JSON.stringify({ vercel: { type: "oauth", access: "unrelated-subscription-token" } });
  assert.equal(await gatewayKey({ OPENCODE_AUTH_CONTENT: content }, { AI_GATEWAY_API_KEY: secret }, emptyAuth), secret);
  assert.equal(await gatewayKey(undefined, { AI_GATEWAY_API_KEY: secret }, async () => content), secret);
  await assert.rejects(gatewayKey({ OPENCODE_AUTH_CONTENT: content }, {}, emptyAuth), /AI_GATEWAY_API_KEY/);
  await assert.rejects(gatewayKey({ OPENCODE_AUTH_CONTENT: content }, { AI_GATEWAY_API_KEY: "" }, emptyAuth), /AI_GATEWAY_API_KEY/);
});

test("missing, conflicting, malformed, OAuth, and placeholder keys fail without echoing input", async () => {
  const cases: Array<[Record<string, string> | undefined, NodeJS.ProcessEnv]> = [
    [undefined, {}],
    [{ OPENCODE_AUTH_CONTENT: secret }, {}],
    [{ OPENCODE_AUTH_CONTENT: "null" }, {}],
    [{ OPENCODE_AUTH_CONTENT: JSON.stringify({ vercel: { type: "oauth", access: secret } }) }, {}],
    [{ OPENCODE_AUTH_CONTENT: JSON.stringify({ vercel: { type: "api", key: secret } }) }, { AI_GATEWAY_API_KEY: "different-key" }],
    [undefined, { AI_GATEWAY_API_KEY: `bad\n${secret}` }],
    [undefined, { AI_GATEWAY_API_KEY: GATEWAY_PLACEHOLDER }],
  ];
  for (const [inherited, host] of cases) {
    await assert.rejects(gatewayKey(inherited, host, emptyAuth), error => error instanceof Error && !String(error).includes(secret));
  }
  await assert.rejects(gatewayKey(undefined, {}, async () => { throw new Error(secret); }), error => !String(error).includes(secret));
});

test("policy injects only on the selected Gateway model inference route", () => {
  const policy = gatewayPolicy(secret, model) as { allow: Record<string, Array<{ match?: unknown; transform?: unknown }>> };
  assert.deepEqual(Object.keys(policy.allow).sort(), ["*", "ai-gateway.vercel.sh"]);
  assert.deepEqual(policy.allow["*"], []);
  assert.deepEqual(policy.allow["ai-gateway.vercel.sh"], [{
    match: { path: { exact: "/v3/ai/language-model" }, method: ["POST"], headers: [{ key: { exact: "ai-language-model-id" }, value: { exact: "openai/gpt-5.4-mini" } }] },
    transform: [{ headers: { Authorization: `Bearer ${secret}`, Host: "ai-gateway.vercel.sh" } }],
  }]);
});

test("workspace options reject credential forwarding and custom provider endpoints", () => {
  for (const options of [{ forwardEnv: ["AI_GATEWAY_API_KEY"] }, { remoteConfig: { provider: { vercel: { options: { apiKey: secret } } } } }, { remoteConfig: { model: "openai/gpt-5.4-mini" } }]) {
    assert.throws(() => optionsSchema.parse(options));
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "oc-broker-"));
  const calls: string[] = [];
  const vmInputs: unknown[] = [];
  const policies: unknown[] = [];
  const host: NodeJS.ProcessEnv = { AI_GATEWAY_API_KEY: secret };
  let fail = "";
  const sandbox = {
    name: sandboxName(workspace.projectID, workspace.id),
    async writeFiles(files: unknown) { calls.push("files"); vmInputs.push(files); },
    async runCommand(input: unknown) { calls.push("command"); vmInputs.push(input); return { exitCode: 0, stdout: async () => "", stderr: async () => "" }; },
    async update(input: { networkPolicy: unknown }) { calls.push("update"); policies.push(input.networkPolicy); if (fail === "update") throw new Error(secret); },
    async resume() { calls.push("resume"); if (fail === "resume") throw new Error(secret); },
    async stop() { calls.push("stop"); },
  } as unknown as Sandbox;
  const service = {
    async create(input: { env?: unknown; networkPolicy?: unknown }) { calls.push("create"); vmInputs.push(input.env); policies.push(input.networkPolicy); if (fail === "create") throw new Error(secret); return sandbox; },
    async get(input: { resume?: boolean }) { calls.push(input.resume ? "resume" : "get"); if (fail === (input.resume ? "resume" : "get")) throw new Error(secret); return sandbox; },
  } as unknown as Pick<typeof Sandbox, "create" | "get">;
  const dependencies = {
    host, readAuth: emptyAuth, stateDirectory: directory,
    credentials: async () => ({ token: "control-plane-only-key", teamId: "team", projectId: "billing-project" }),
    source: async () => ({ content: Buffer.from("fixture source"), head: "abc123" }),
    ready: async () => { calls.push("ready"); return "https://workspace.example.invalid"; },
  };
  const adapter = createAdapter({ directory }, { remoteConfig: { model } }, service, dependencies);
  return { directory, calls, vmInputs, policies, host, adapter, sandbox, dependencies, service, setFailure: (value: string) => { fail = value; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("create and reconnect keep keys outside the VM and refresh policy before resume", async () => {
  const setup = await fixture();
  try {
    await setup.adapter.create(workspace, { OPENCODE_AUTH_CONTENT: JSON.stringify({ other: { type: "api", key: "unrelated-provider-secret" } }), AI_GATEWAY_API_KEY: "do-not-forward" });
    assert.ok(JSON.stringify(setup.policies).includes(secret));
    assert.ok(!JSON.stringify(setup.vmInputs).includes(secret));
    assert.ok(!JSON.stringify(setup.vmInputs).includes("unrelated-provider-secret"));
    assert.ok(!JSON.stringify(setup.vmInputs).includes("control-plane-only-key"));
    for (const filename of await readdir(setup.directory)) assert.ok(!(await readFile(join(setup.directory, filename), "utf8")).includes(secret));
    setup.calls.length = 0;
    setup.host.AI_GATEWAY_API_KEY = "synthetic-rotated-gateway-key";
    const result = await setup.adapter.target(workspace);
    assert.deepEqual(setup.calls, ["get", "update", "resume", "ready"]);
    assert.ok(JSON.stringify(setup.policies.at(-1)).includes("synthetic-rotated-gateway-key"));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes("synthetic-rotated-gateway-key"));
  } finally { await setup.cleanup(); }
});

test("legacy and model/scope mismatched workspaces are refused before any Sandbox access", async () => {
  const setup = await fixture();
  try {
    await assert.rejects(setup.adapter.target(workspace), /new workspace/);
    assert.deepEqual(setup.calls, []);
    await setup.adapter.create(workspace, {});
    setup.calls.length = 0;
    const other = createAdapter({ directory: setup.directory }, { remoteConfig: { model: "vercel/anthropic/claude-haiku-4.5" } }, setup.service, setup.dependencies);
    await assert.rejects(other.target(workspace), /new workspace/);
    assert.deepEqual(setup.calls, []);
    await assert.rejects(brokerState(setup.sandbox.name, model, "another-project", false, setup.directory), /new workspace/);
  } finally { await setup.cleanup(); }
});

test("missing key blocks allocation and policy errors never return a connection or echo the key", async () => {
  const setup = await fixture();
  try {
    delete setup.host.AI_GATEWAY_API_KEY;
    await assert.rejects(setup.adapter.create(workspace, {}), /AI_GATEWAY_API_KEY/);
    assert.deepEqual(setup.calls, []);
    setup.host.AI_GATEWAY_API_KEY = secret;
    setup.setFailure("create");
    await assert.rejects(setup.adapter.create(workspace, {}), error => !String(error).includes(secret));
    setup.setFailure("");
    await setup.adapter.create(workspace, {});
    for (const failure of ["get", "update", "resume"]) {
      setup.calls.length = 0;
      setup.setFailure(failure);
      await assert.rejects(setup.adapter.target(workspace), error => !String(error).includes(secret));
      assert.ok(!setup.calls.includes("ready"));
      if (failure === "update") assert.ok(!setup.calls.includes("resume"));
    }
  } finally { await setup.cleanup(); }
});

test("concurrent workspace activation is locked without removing another writer's lock", async () => {
  const setup = await fixture();
  try {
    await withWorkspaceLock(setup.sandbox.name, setup.directory, async () => {
      await assert.rejects(withWorkspaceLock(setup.sandbox.name, setup.directory, async () => undefined), /locked/);
      assert.ok((await readdir(setup.directory)).some(filename => filename.endsWith("activation.lock")));
    });
  } finally { await setup.cleanup(); }
});

test("billing scope excludes access tokens and rejects malformed OIDC without echoing it", () => {
  assert.equal(brokerScope({ token: secret, teamId: "team", projectId: "project" }, {}), '["team","project"]');
  assert.throws(() => brokerScope({}, { VERCEL_OIDC_TOKEN: secret }), error => !String(error).includes(secret));
});
