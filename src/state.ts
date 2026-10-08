import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";

export function sandboxName(projectID: string, workspaceID: string) {
  return `oc-${createHash("sha256").update(JSON.stringify([projectID, workspaceID])).digest("hex").slice(0, 32)}`;
}

export function stateDirectory() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "vercel-sandbox");
}

export async function passwordFor(name: string, create: boolean, directory = stateDirectory()): Promise<string> {
  if (!/^oc-[a-f0-9]{32}$/.test(name)) throw new Error("Invalid workspace sandbox name");
  const path = join(directory, `${name}.key`);
  try {
    const password = await readFile(path, "utf8");
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid workspace credential file");
    return password;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) throw new Error(`Missing local credential for ${name}; restore the original workspace credential file.`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.key`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(randomBytes(32).toString("hex"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
  return passwordFor(name, false, directory);
}
