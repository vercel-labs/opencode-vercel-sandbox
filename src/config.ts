import { z } from "zod";

export const OPENCODE_VERSION = "1.18.32";
export const WORKSPACE = "/vercel/sandbox/project";
export const SERVER_PORT = 4096;
export const SERVER_BINARY = "/vercel/sandbox/opencode/node_modules/.bin/opencode";

export const projectSchema = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
}).strict();

const forwardedName = z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine(
  (name) => !/^(VERCEL_|OPENCODE_|NODE_|BUN_|LD_|DYLD_|GIT_|XDG_)/.test(name) &&
    !["PATH", "HOME", "SHELL", "ENV", "BASH_ENV"].includes(name),
  "Only model-provider environment variables may be forwarded",
);

export const optionsSchema = z.object({
  project: projectSchema.optional(),
  image: z.string().min(1).default("vercel/sandbox/node:24"),
  region: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(60_000).max(2_700_000).default(1_800_000),
  vcpus: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(2),
  previewPorts: z.array(z.number().int().min(1024).max(65535).refine((port) => port !== SERVER_PORT)).max(14).default([]),
  forwardEnv: z.array(forwardedName).default([]),
  remoteConfig: z.object({
    model: z.string().optional(),
    provider: z.record(z.string(), z.unknown()).optional(),
  }).strict().default({}),
}).strict();

export type Options = z.infer<typeof optionsSchema>;

export function remoteEnvironment(options: Options, inherited: Record<string, string | undefined>, host: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {};
  for (const key of ["OPENCODE_AUTH_CONTENT", "OPENCODE_WORKSPACE_ID", "OPENCODE_EXPERIMENTAL_WORKSPACES"]) {
    if (inherited[key]) env[key] = inherited[key];
  }
  for (const key of options.forwardEnv) {
    if (!host[key]) throw new Error(`Missing model environment variable: ${key}`);
    env[key] = host[key];
  }
  return {
    ...env,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.remoteConfig),
    OPENCODE_SERVER_USERNAME: "opencode",
  };
}

export function sandboxCredentials(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_OIDC_TOKEN) return {};
  if (env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID) {
    return { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID };
  }
  throw new Error("Set VERCEL_OIDC_TOKEN, or VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID in the host environment.");
}
