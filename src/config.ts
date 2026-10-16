import { z } from "zod";
import { GATEWAY_PLACEHOLDER, gatewayModel } from "./broker.js";

export const OPENCODE_VERSION = "1.18.32";
export const WORKSPACE = "/vercel/sandbox/project";
export const SERVER_PORT = 4096;
export const SERVER_BINARY = "/vercel/sandbox/opencode/node_modules/.bin/opencode";

export const projectSchema = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
}).strict();

export const optionsSchema = z.object({
  project: projectSchema.optional(),
  image: z.string().min(1).default("vercel/sandbox/node:24"),
  region: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(60_000).max(2_700_000).default(1_800_000),
  vcpus: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(2),
  previewPorts: z.array(z.number().int().min(1024).max(65535).refine((port) => port !== SERVER_PORT)).max(14).default([]),
  remoteConfig: z.object({
    model: z.string().regex(/^vercel\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/).max(200).optional(),
  }).strict().default({}),
}).strict();

export type Options = z.infer<typeof optionsSchema>;

export function remoteEnvironment(options: Options, workspaceID: string) {
  const model = gatewayModel(options.remoteConfig.model);
  return {
    OPENCODE_WORKSPACE_ID: workspaceID,
    OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
    OPENCODE_AUTH_CONTENT: JSON.stringify({ vercel: { type: "api", key: GATEWAY_PLACEHOLDER } }),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model, small_model: model, enabled_providers: ["vercel"],
      provider: { vercel: { options: { apiKey: GATEWAY_PLACEHOLDER, baseURL: "https://ai-gateway.vercel.sh/v3/ai" } } },
    }),
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
