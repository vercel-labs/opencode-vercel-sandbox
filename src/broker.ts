import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NetworkPolicy } from "@vercel/sandbox";
import type { ResolvedCredentials } from "./auth.js";

export const GATEWAY_PLACEHOLDER = "vercel-sandbox-broker-placeholder";
export const BROKER_VERSION = 1;

export function gatewayModel(model?: string) {
  if (!model || !/^vercel\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(model)) {
    throw new Error("Configure remoteConfig.model with a vercel/<provider>/<model> model. Workspace mode supports AI Gateway API keys only.");
  }
  return model;
}

export async function gatewayKey(
  inherited: Record<string, string | undefined> | undefined,
  host: NodeJS.ProcessEnv = process.env,
  readAuth: () => Promise<string> = () => readFile(join(host.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json"), "utf8"),
) {
  let content = inherited?.OPENCODE_AUTH_CONTENT ?? host.OPENCODE_AUTH_CONTENT;
  if (content === undefined) {
    try { content = await readAuth(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to read local OpenCode authentication. No workspace was activated.");
    }
  }
  let saved: unknown;
  if (content !== undefined) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      saved = (parsed as Record<string, unknown>).vercel;
    } catch { throw new Error("Invalid local OpenCode authentication. No workspace was activated."); }
  }
  const envKey = host.AI_GATEWAY_API_KEY;
  let savedKey: unknown;
  if (saved !== undefined) {
    if (!saved || typeof saved !== "object") throw new Error("Invalid saved AI Gateway authentication.");
    if ((saved as { type?: unknown }).type === "api") {
      savedKey = (saved as { key?: unknown }).key;
      if (typeof savedKey !== "string" || !savedKey) throw new Error("Invalid saved AI Gateway API key.");
    } else if (envKey === undefined) {
      throw new Error("Set AI_GATEWAY_API_KEY on the host. OAuth and subscription credentials cannot authenticate a workspace.");
    }
  }
  if (envKey !== undefined && savedKey !== undefined && envKey !== savedKey) {
    throw new Error("Conflicting AI Gateway API keys. Use one matching host credential source.");
  }
  const key = envKey ?? savedKey;
  if (typeof key !== "string" || !key || /[\s\x00-\x1f\x7f]/.test(key) || key === GATEWAY_PLACEHOLDER) {
    throw new Error("Set AI_GATEWAY_API_KEY on the host or connect Vercel AI Gateway locally before creating or reconnecting a workspace.");
  }
  return key;
}

export function gatewayPolicy(key: string, model: string): NetworkPolicy {
  return { allow: {
    "ai-gateway.vercel.sh": [{
      match: {
        path: { exact: "/v3/ai/language-model" }, method: ["POST"],
        headers: [{ key: { exact: "ai-language-model-id" }, value: { exact: gatewayModel(model).slice("vercel/".length) } }],
      },
      transform: [{ headers: { Authorization: `Bearer ${key}`, Host: "ai-gateway.vercel.sh" } }],
    }],
    "*": [],
  } };
}

export function brokerScope(credentials: ResolvedCredentials, host: NodeJS.ProcessEnv) {
  if ("teamId" in credentials) return JSON.stringify([credentials.teamId, credentials.projectId]);
  try {
    const payload = host.VERCEL_OIDC_TOKEN?.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    if (typeof claims.owner_id !== "string" || !claims.owner_id || typeof claims.project_id !== "string" || !claims.project_id) throw new Error();
    return JSON.stringify([claims.owner_id, claims.project_id]);
  } catch { throw new Error("Unable to establish the workspace billing scope."); }
}
