import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { stateDirectory } from "../state.js";

export const recordSchema = z.object({
  version: z.literal(1),
  sessionID: z.string(),
  worktree: z.string(),
  scope: z.string(),
  name: z.string().regex(/^oc-auto-[a-f0-9]{32}$/),
  phase: z.enum(["initializing", "ready"]),
  base: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string().regex(/^vercel-sandbox\/[a-f0-9]{32}$/),
  returned: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  sync: z.enum(["pending", "synced", "failed"]),
  error: z.string().optional(),
}).strict();
export type SessionRecord = z.infer<typeof recordSchema>;

export function identity(projectID: string, worktree: string, sessionID: string, scope: string) {
  const key = createHash("sha256").update(JSON.stringify([scope, projectID, worktree, sessionID])).digest("hex").slice(0, 32);
  return { key, name: `oc-auto-${key}`, branch: `vercel-sandbox/${key}` };
}

export class Store {
  constructor(readonly directory = join(stateDirectory(), "automatic")) {}

  path(key: string) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("Invalid session key");
    return join(this.directory, `${key}.json`);
  }

  async read(key: string) {
    try { return recordSchema.parse(JSON.parse(await readFile(this.path(key), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(key: string, record: SessionRecord) {
    recordSchema.parse(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path(key)}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, this.path(key)); }
    finally { await rm(temporary, { force: true }); }
  }

  async locked<Result>(key: string, action: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${this.path(key)}.lock`;
    const deadline = Date.now() + 20_000;
    for (;;) {
      signal?.throwIfAborted();
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error(`Session locked: ${lock}. Another process may be active; inspect before removing a stale lock.`);
        await sleep(100, undefined, { signal });
      }
    }
    try { return await action(); }
    finally { await rm(lock, { recursive: true }); }
  }
}
