import { Sandbox } from "@vercel/sandbox";
import type { PluginInput, WorkspaceAdapter, WorkspaceInfo, WorkspaceTarget } from "@opencode-ai/plugin";
import { setTimeout as sleep } from "node:timers/promises";
import { OPENCODE_VERSION, SERVER_BINARY, SERVER_PORT, WORKSPACE, optionsSchema, remoteEnvironment } from "./config.js";
import { checkedCommand, sourceBundle } from "./git.js";
import { resolveCredentials } from "./auth.js";
import { passwordFor, sandboxName } from "./state.js";

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

export function createAdapter(context: Pick<PluginInput, "directory">, rawOptions: unknown = {}, service = Sandbox): WorkspaceAdapter {
  const options = optionsSchema.parse(rawOptions);
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
      const source = await sourceBundle(context.directory);
      const credentials = await resolveCredentials(context.directory, options.project);
      const name = nameFor(config);
      const password = await passwordFor(name, true);
      const env = remoteEnvironment(options, inherited, process.env);
      const sandbox = await service.create({
        ...credentials, name, image: options.image, region: options.region,
        persistent: true, timeout: options.timeoutMs, resources: { vcpus: options.vcpus },
        snapshotExpiration: 0, keepLastSnapshots: { count: 1 },
        ports: [SERVER_PORT, ...new Set(options.previewPorts)],
        env: { ...env, OPENCODE_SERVER_PASSWORD: password },
      });
      await sandbox.writeFiles([
        { path: "/vercel/sandbox/source.bundle", content: source.content },
        { path: "/vercel/sandbox/source-head", content: Buffer.from(source.head) },
      ]);
      await checkedCommand(sandbox, "git", ["clone", "/vercel/sandbox/source.bundle", WORKSPACE], "/vercel/sandbox");
      await checkedCommand(sandbox, "git", ["checkout", "-B", "workspace", source.head]);
      await checkedCommand(sandbox, "git", ["remote", "remove", "origin"]);
      await checkedCommand(sandbox, "npm", ["install", "--prefix", "/vercel/sandbox/opencode", "--no-audit", "--no-fund", `opencode-ai@${OPENCODE_VERSION}`], "/vercel/sandbox");
      await ensureServer(sandbox, password);
    },
    async remove(config) {
      const credentials = await resolveCredentials(context.directory, options.project);
      const sandbox = await service.get({ ...credentials, name: nameFor(config), resume: false });
      await sandbox.stop();
    },
    async target(config) {
      const name = nameFor(config);
      const existing = pending.get(name);
      if (existing) return existing;
      const operation = (async (): Promise<WorkspaceTarget> => {
        const password = await passwordFor(name, false);
        const credentials = await resolveCredentials(context.directory, options.project);
        const sandbox = await service.get({ ...credentials, name });
        const url = await ensureServer(sandbox, password);
        return { type: "remote", url, headers: authorization(password) };
      })();
      pending.set(name, operation);
      try { return await operation; }
      finally { pending.delete(name); }
    },
  };
}
