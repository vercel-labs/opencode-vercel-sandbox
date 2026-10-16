import { realpath } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { projectSchema, WORKSPACE } from "../config.js";
import { resolveCredentials, type ResolvedCredentials } from "../auth.js";
import { bundleSource, safeGit, synchronize } from "./git.js";
import { Store, identity, type SessionRecord } from "./state.js";

export const automaticSchema = z.object({
  mode: z.literal("automatic"),
  project: projectSchema.optional(),
  image: z.string().min(1).default("vercel/sandbox/universal"),
  region: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(60_000).max(2_700_000).default(1_800_000),
  vcpus: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(2),
  previewPorts: z.array(z.number().int().min(1024).max(65535)).max(15).default([]),
}).strict();
export type AutomaticOptions = z.infer<typeof automaticSchema>;
export function credentialScope(credentials: ResolvedCredentials, env: NodeJS.ProcessEnv = process.env) {
  if ("teamId" in credentials) return JSON.stringify([credentials.teamId, credentials.projectId]);
  const payload = env.VERCEL_OIDC_TOKEN?.split(".")[1];
  if (!payload) throw new Error("Vercel OIDC scope is unavailable; no Sandbox will be allocated.");
  const scope = z.object({ owner_id: z.string().min(1), project_id: z.string().min(1) }).parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  return JSON.stringify([scope.owner_id, scope.project_id]);
}
export type Dependencies = {
  service?: Pick<typeof Sandbox, "create" | "get">;
  store?: Store;
  credentials?: typeof resolveCredentials;
  source?: typeof bundleSource;
  synchronize?: typeof synchronize;
  notify?: (message: string, error?: boolean) => Promise<void>;
};

export class Sessions {
  readonly store: Store;
  private pending = new Map<string, Promise<unknown>>();
  private touched = new Set<string>();
  private closed = false;
  constructor(readonly projectID: string, readonly worktree: string, readonly options: AutomaticOptions, private dependencies: Dependencies = {}) {
    this.store = dependencies.store ?? new Store();
  }

  async notify(message: string, error = false) {
    void Promise.resolve().then(() => this.dependencies.notify?.(message, error)).catch(() => {});
  }

  private serial<Result>(sessionID: string, action: (key: string, credentials: ResolvedCredentials, scope: string) => Promise<Result>, signal?: AbortSignal, draining = false) {
    if (this.closed && !draining) return Promise.reject(new Error("Automatic session is closing; retry after reopening OpenCode."));
    const previous = this.pending.get(sessionID) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const credentials = await (this.dependencies.credentials ?? resolveCredentials)(this.worktree, this.options.project);
      signal?.throwIfAborted();
      const scope = credentialScope(credentials);
      const { key } = identity(this.projectID, this.worktree, sessionID, scope);
      return this.store.locked(key, () => action(key, credentials, scope), signal);
    });
    this.pending.set(sessionID, operation);
    operation.finally(() => { if (this.pending.get(sessionID) === operation) this.pending.delete(sessionID); }).catch(() => {});
    return operation;
  }

  private async ready(sessionID: string, key: string, credentials: ResolvedCredentials, scope: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const service = this.dependencies.service ?? Sandbox;
    let record = await this.store.read(key);
    if (record) {
      if (record.worktree !== this.worktree || record.sessionID !== sessionID || record.scope !== scope) throw new Error("Session state does not match this worktree or Vercel project.");
      if (record.phase !== "ready") throw new Error(`Incomplete setup for ${record.name}; inspect the preserved sandbox and session state before recovery. No tools were run.`);
      const sandbox = await service.get({ ...credentials, name: record.name, signal });
      if (!this.touched.has(sessionID)) await this.notify(`Reconnected to Vercel Sandbox ${record.name}`);
      this.touched.add(sessionID);
      return { sandbox, record };
    }
    const source = await (this.dependencies.source ?? bundleSource)(this.worktree, signal);
    signal?.throwIfAborted();
    const names = identity(this.projectID, this.worktree, sessionID, scope);
    record = { version: 1, sessionID, worktree: this.worktree, scope, name: names.name, phase: "initializing", base: source.head, branch: names.branch, returned: null, sync: "pending" };
    await this.store.write(key, record);
    await this.notify(`Creating Vercel Sandbox ${record.name} from committed HEAD`);
    signal?.throwIfAborted();
    const sandbox = await service.create({ ...credentials, name: record.name, image: this.options.image, region: this.options.region, persistent: true, timeout: this.options.timeoutMs, resources: { vcpus: this.options.vcpus }, ports: [...new Set(this.options.previewPorts)], snapshotExpiration: 0, keepLastSnapshots: { count: 1 }, env: {}, signal });
    signal?.throwIfAborted();
    await sandbox.writeFiles([{ path: "/vercel/sandbox/source.bundle", content: source.content }, { path: "/vercel/sandbox/source-head", content: Buffer.from(source.head) }], { signal });
    for (const [cmd, args, cwd] of [
      ["git", ["clone", "--no-checkout", "/vercel/sandbox/source.bundle", WORKSPACE], "/vercel/sandbox"],
      ["git", ["checkout", "-B", "workspace", source.head], WORKSPACE],
      ["git", ["remote", "remove", "origin"], WORKSPACE],
      ["bash", ["-c", "command -v node >/dev/null && command -v rg >/dev/null && command -v timeout >/dev/null"], WORKSPACE],
    ] as const) {
      signal?.throwIfAborted();
      const command = await sandbox.runCommand({ cmd, args: [...args], cwd, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
      if (command.exitCode !== 0) throw new Error(`Initialization failed (${cmd}, exit ${command.exitCode}); ${record.name} is preserved.`);
    }
    record.phase = "ready";
    await this.store.write(key, record);
    this.touched.add(sessionID);
    await this.notify(`Vercel Sandbox ready: ${record.name}; edits return to ${record.branch}`);
    return { sandbox, record };
  }

  async run<Result>(sessionID: string, action: (sandbox: Sandbox) => Promise<Result>, signal?: AbortSignal) {
    return this.serial(sessionID, async (key, credentials, scope) => {
      signal?.throwIfAborted();
      const { sandbox, record } = await this.ready(sessionID, key, credentials, scope, signal);
      signal?.throwIfAborted();
      record.sync = "pending";
      delete record.error;
      await this.store.write(key, record);
      return action(sandbox);
    }, signal);
  }

  async sync(sessionID: string, stop = false, signal?: AbortSignal, draining = false) {
    return this.serial(sessionID, async (key, credentials, scope) => {
      signal?.throwIfAborted();
      const existing = await this.store.read(key);
      if (!existing) return "No Sandbox has been created for this session.";
      if (existing.sync === "synced" && !stop) return `Synced ${existing.branch} at ${existing.returned}`;
      let record = existing;
      try {
        const ready = await this.ready(sessionID, key, credentials, scope, signal);
        record = ready.record;
        const commit = await (this.dependencies.synchronize ?? synchronize)(ready.sandbox, this.worktree, record, signal);
        record.returned = commit;
        record.sync = "synced";
        delete record.error;
        await this.store.write(key, record);
        if (stop) { signal?.throwIfAborted(); await ready.sandbox.stop({ signal }); this.touched.delete(sessionID); }
        const message = `${stop ? "Stopped; files retained. " : ""}Synced ${record.branch} at ${commit}`;
        await this.notify(message);
        return message;
      } catch (error) {
        record.sync = "failed";
        record.error = "Git return failed; sandbox retained. Run gitSync to inspect and retry.";
        await this.store.write(key, record);
        await this.notify(`Sync failed for ${record.name}; sandbox retained. Run gitSync to retry.`, true);
        throw error;
      }
    }, signal, draining);
  }

  async idle(sessionID: string) {
    if (!this.touched.has(sessionID)) return;
    await this.sync(sessionID).catch(() => {});
  }

  async dispose(timeoutMs = 60_000) {
    this.closed = true;
    const drain = (async () => {
      await Promise.allSettled([...this.pending.values()]);
      const results = await Promise.allSettled([...this.touched].map((sessionID) => this.sync(sessionID, false, undefined, true)));
      return results.every((result) => result.status === "fulfilled");
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const complete = await Promise.race([
        drain,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
      if (!complete) await this.notify("Sandbox sync did not finish before exit. Remote files are retained; reopen and run gitSync.", true);
      return complete;
    } finally { clearTimeout(timer); }
  }
}

export async function openSessions(projectID: string, worktree: string, options: AutomaticOptions, dependencies: Dependencies = {}) {
  const root = await realpath(await safeGit(worktree, ["rev-parse", "--show-toplevel"]));
  return new Sessions(projectID, root, options, dependencies);
}
