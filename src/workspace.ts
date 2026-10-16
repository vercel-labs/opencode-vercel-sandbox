import { Sandbox } from "@vercel/sandbox";
import type { PluginInput, WorkspaceAdapter, WorkspaceInfo, WorkspaceTarget } from "@opencode-ai/plugin";
import { setTimeout as sleep } from "node:timers/promises";
import { OPENCODE_VERSION, SERVER_BINARY, SERVER_PORT, WORKSPACE, optionsSchema, remoteEnvironment } from "./config.js";
import { checkedCommand, sourceBundle } from "./git.js";
import { resolveCredentials } from "./auth.js";
import { brokerScope, gatewayKey, gatewayModel, gatewayPolicy } from "./broker.js";
import { brokerState, passwordFor, sandboxName, stateDirectory, withWorkspaceLock } from "./state.js";

export function authorization(password: string) {
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

export async function healthy(url: string, password: string) {
  try {
    const response = await fetch(`${url}/global/health`, { headers: authorization(password), redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (response.status === 401 || response.status === 403) throw new Error("Workspace authentication rejected");
    if (!response.ok) return false;
    const health = await response.json() as { healthy?: boolean; version?: string };
    if (health.version !== OPENCODE_VERSION) throw new Error(`Expected OpenCode ${OPENCODE_VERSION}; received ${health.version}`);
    return health.healthy === true;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) return false;
    throw error;
  }
}

export async function ensureServer(sandbox: Sandbox, password: string) {
  const url = sandbox.domain(SERVER_PORT);
  if (await healthy(url, password)) return url;
  await sandbox.runCommand({
    cmd: "flock",
    args: ["-n", "/tmp/opencode-server.lock", SERVER_BINARY, "serve", "--hostname", "0.0.0.0", "--port", String(SERVER_PORT)],
    cwd: WORKSPACE,
    detached: true,
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy(sandbox.domain(SERVER_PORT), password)) return sandbox.domain(SERVER_PORT);
    await sleep(500);
  }
  throw new Error(`OpenCode did not become healthy in ${sandbox.name}; the sandbox and logs are preserved.`);
}

export type WorkspaceDependencies = {
  host?: NodeJS.ProcessEnv;
  readAuth?: () => Promise<string>;
  credentials?: typeof resolveCredentials;
  source?: typeof sourceBundle;
  ready?: typeof ensureServer;
  stateDirectory?: string;
};

export function createAdapter(context: Pick<PluginInput, "directory">, rawOptions: unknown = {}, service: Pick<typeof Sandbox, "create" | "get"> = Sandbox, dependencies: WorkspaceDependencies = {}): WorkspaceAdapter {
  const options = optionsSchema.parse(rawOptions);
  const host = dependencies.host ?? process.env;
  const directory = dependencies.stateDirectory ?? stateDirectory();
  const credentialsFor = () => (dependencies.credentials ?? resolveCredentials)(context.directory, options.project);
  const ready = dependencies.ready ?? ensureServer;
  const pending = new Map<string, Promise<WorkspaceTarget>>();
  const nameFor = (config: WorkspaceInfo) => sandboxName(config.projectID, config.id);

  return {
    name: "Vercel Sandbox",
    description: "Run OpenCode in a persistent Vercel Sandbox",
    configure(config) {
      return { ...config, name: config.name || "Vercel Sandbox", directory: WORKSPACE, extra: { sandboxName: nameFor(config) } };
    },
    async create(config, inherited, from) {
      if (from) throw new Error("Forking existing workspaces is not supported; create a new workspace from local HEAD.");
      const model = gatewayModel(options.remoteConfig.model);
      const key = await gatewayKey(inherited, host, dependencies.readAuth);
      const source = await (dependencies.source ?? sourceBundle)(context.directory);
      const credentials = await credentialsFor();
      const scope = brokerScope(credentials, host);
      const name = nameFor(config);
      await withWorkspaceLock(name, directory, async () => {
      const password = await passwordFor(name, true, directory);
      const env = remoteEnvironment(options, config.id);
      let sandbox: Sandbox;
      try { sandbox = await service.create({
        ...credentials, name, image: options.image, region: options.region,
        persistent: true, timeout: options.timeoutMs, resources: { vcpus: options.vcpus },
        snapshotExpiration: 0, keepLastSnapshots: { count: 1 },
        ports: [SERVER_PORT, ...new Set(options.previewPorts)],
        networkPolicy: gatewayPolicy(key, model),
        env: { ...env, OPENCODE_SERVER_PASSWORD: password },
      }); } catch { throw new Error("Brokered workspace creation failed. Inspect the Sandbox dashboard before retrying; credentials are omitted from this error."); }
      await sandbox.writeFiles([
        { path: "/vercel/sandbox/source.bundle", content: source.content },
        { path: "/vercel/sandbox/source-head", content: Buffer.from(source.head) },
      ]);
      await checkedCommand(sandbox, "git", ["clone", "/vercel/sandbox/source.bundle", WORKSPACE], "/vercel/sandbox");
      await checkedCommand(sandbox, "git", ["checkout", "-B", "workspace", source.head]);
      await checkedCommand(sandbox, "git", ["remote", "remove", "origin"]);
      await checkedCommand(sandbox, "npm", ["install", "--prefix", "/vercel/sandbox/opencode", "--no-audit", "--no-fund", `opencode-ai@${OPENCODE_VERSION}`], "/vercel/sandbox");
      await ready(sandbox, password);
      await brokerState(name, model, scope, true, directory);
      });
    },
    async remove(config) {
      const credentials = await credentialsFor();
      const sandbox = await service.get({ ...credentials, name: nameFor(config), resume: false });
      await sandbox.stop();
    },
    async target(config) {
      const name = nameFor(config);
      const existing = pending.get(name);
      if (existing) return existing;
      const operation = withWorkspaceLock(name, directory, async (): Promise<WorkspaceTarget> => {
        const model = gatewayModel(options.remoteConfig.model);
        const credentials = await credentialsFor();
        await brokerState(name, model, brokerScope(credentials, host), false, directory);
        const key = await gatewayKey(undefined, host, dependencies.readAuth);
        const password = await passwordFor(name, false, directory);
        let sandbox: Sandbox;
        try {
          sandbox = await service.get({ ...credentials, name, resume: false });
          await sandbox.update({ networkPolicy: gatewayPolicy(key, model) });
          sandbox = await service.get({ ...credentials, name, resume: true });
        } catch { throw new Error("Workspace policy refresh or resume failed. No connection was returned; inspect the Sandbox before retrying."); }
        const url = await ready(sandbox, password);
        return { type: "remote", url, headers: authorization(password) };
      });
      pending.set(name, operation);
      try { return await operation; }
      finally { pending.delete(name); }
    },
  };
}
