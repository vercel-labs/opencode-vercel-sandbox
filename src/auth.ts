import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAuth } from "@vercel/sandbox/dist/auth/index.js";
import { z } from "zod";
import { projectSchema, sandboxCredentials } from "./config.js";

const execute = promisify(execFile);
const refreshTimeoutMs = 15_000;
const linkedProjectSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
});

export type StoredAuth = {
  token?: string;
  refreshToken?: string;
  expiresAt?: Date;
};

export type ResolvedCredentials =
  | { token: string; teamId: string; projectId: string }
  | Record<never, never>;

export type ResolveCredentialsDependencies = {
  env?: Record<string, string | undefined>;
  getAuth?: () => StoredAuth | null;
  refreshLogin?: (teamId: string) => Promise<void>;
  gitRoot?: (directory: string) => Promise<string | null>;
  readFile?: (path: string) => Promise<string>;
};

const defaultRefreshLogin = async (teamId: string) => {
  try {
    await execute("vercel", ["whoami", "--format", "json", "--scope", teamId], {
      timeout: refreshTimeoutMs,
      windowsHide: true,
    });
  } catch {
    throw new Error("Vercel login refresh failed. Run vercel login in a terminal, then retry.");
  }
};

const defaultGitRoot = async (directory: string) => {
  try {
    return (await execute("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      timeout: 5_000,
      windowsHide: true,
    })).stdout.trim() || null;
  } catch {
    return null;
  }
};

function isExpired(auth: StoredAuth) {
  return auth.expiresAt !== undefined && auth.expiresAt.getTime() <= Date.now();
}

async function resolveToken(dependencies: ResolveCredentialsDependencies, teamId: string) {
  const getLogin = dependencies.getAuth ?? getAuth;
  const auth = await getLogin();
  if (!auth?.token) {
    throw new Error("No Vercel login found. Run vercel login in a terminal, then retry.");
  }
  if (!isExpired(auth)) return auth.token;

  try {
    await (dependencies.refreshLogin ?? defaultRefreshLogin)(teamId);
  } catch {
    throw new Error("Vercel login refresh failed. Run vercel login in a terminal, then retry.");
  }
  const refreshed = await getLogin();
  if (!refreshed?.token) {
    throw new Error("Vercel login is still missing after refresh. Run vercel login in a terminal, then retry.");
  }
  if (isExpired(refreshed)) {
    throw new Error("Vercel login is still expired. Run vercel login in a terminal, then retry.");
  }
  return refreshed.token;
}

async function resolveLinkedProject(
  directory: string,
  dependencies: ResolveCredentialsDependencies,
) {
  const root = await (dependencies.gitRoot ?? defaultGitRoot)(directory);
  if (!root) return null;
  const path = join(root, ".vercel", "project.json");
  try {
    const content = await (dependencies.readFile ?? ((path: string) => readFile(path, "utf8")))(path);
    let metadata: unknown;
    try {
      metadata = JSON.parse(content);
    } catch {
      throw new Error("Invalid .vercel/project.json. Run vercel link or configure the plugin project option.");
    }
    const parsed = linkedProjectSchema.safeParse(metadata);
    if (!parsed.success) {
      throw new Error("Invalid .vercel/project.json. Run vercel link or configure the plugin project option.");
    }
    return { teamId: parsed.data.orgId, projectId: parsed.data.projectId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message.startsWith("Invalid .vercel/project.json")) throw error;
    throw new Error("Unable to read .vercel/project.json. Run vercel link or configure the plugin project option.");
  }
}

export async function resolveCredentials(
  directory: string,
  configuredProject?: { teamId: string; projectId: string },
  dependencies: ResolveCredentialsDependencies = {},
): Promise<ResolvedCredentials> {
  const env = dependencies.env ?? process.env;
  if (env.VERCEL_OIDC_TOKEN) return {};
  if (env.VERCEL_TOKEN || env.VERCEL_TEAM_ID || env.VERCEL_PROJECT_ID) {
    return sandboxCredentials(env);
  }

  let project: { teamId: string; projectId: string } | null;
  if (configuredProject) {
    const parsed = projectSchema.safeParse(configuredProject);
    if (!parsed.success) {
      throw new Error("Invalid project option. Configure both teamId and projectId.");
    }
    project = parsed.data;
  } else {
    project = await resolveLinkedProject(directory, dependencies);
  }
  if (!project) {
    throw new Error("No explicit Sandbox project. Configure the plugin project option or run vercel link in the repository.");
  }
  return { token: await resolveToken(dependencies, project.teamId), ...project };
}
