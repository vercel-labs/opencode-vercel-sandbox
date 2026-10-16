import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { WORKSPACE } from "./config.js";
import { automaticSchema, openSessions, type Dependencies, type Sessions } from "./automatic/session.js";
import { createTools } from "./automatic/tools.js";

export async function automatic(context: PluginInput, rawOptions: unknown, dependencies: Dependencies = {}): Promise<Hooks> {
  let sessions: Sessions | undefined;
  let failure: string | undefined;
  const notify = dependencies.notify ?? (async (message: string, error?: boolean) => { await context.client.tui.showToast({ body: { title: "Vercel Sandbox", message, variant: error ? "error" : "info", duration: error ? 12_000 : 5_000 }, signal: AbortSignal.timeout(1_000) }); });
  try {
    const options = automaticSchema.parse(rawOptions);
    sessions = await openSessions(context.project.id, context.worktree, options, {
      notify,
      ...dependencies,
    });
  } catch (error) {
    failure = `Check automatic options and start OpenCode from a Git project. ${error instanceof Error ? error.message : String(error)}`;
  }
  const guard = () => {
    if (!failure) return;
    const message = `Automatic mode is blocked: ${failure} Fix the setup and restart OpenCode. No local tool fallback is allowed.`;
    void Promise.resolve().then(() => notify(message, true)).catch(() => {});
    throw new Error(message);
  };
  const tools = sessions ? createTools(sessions) : {};
  const allowed = new Set([...Object.keys(tools), "question", "todowrite", "webfetch", "websearch"]);
  return {
    tool: tools,
    async config(config) {
      config.lsp = false;
      config.mcp = {};
      const previous = typeof config.permission === "string" ? { "*": config.permission } : config.permission;
      Object.assign(config, { permission: { ...previous, task: "deny", lsp: "deny", execute: "deny", skill: "deny" } });
      if ((config.plugin?.length ?? 0) > 1) failure = "Use a dedicated OpenCode profile with no additional user plugins.";
    },
    async "chat.message"() { guard(); },
    async "tool.execute.before"({ tool: name }) {
      guard();
      if (!allowed.has(name)) throw new Error(`Tool ${name} is unavailable in Vercel Sandbox automatic mode. Use the remote bash/file tools.`);
    },
    async "shell.env"() { guard(); throw new Error("Direct local shell is disabled in automatic mode. Ask the agent to use its Vercel Sandbox bash tool."); },
    async "experimental.chat.system.transform"(_input, output) {
      guard();
      output.system.push(`You are using Vercel Sandbox automatic tools. Shell and file tools operate in ${WORKSPACE}, not on the laptop. Model authentication remains local. Initial source includes committed HEAD/history only, not dirty or untracked files. Changes return automatically to a separate local branch; gitSync waits for completion and reports it. Do not start background processes that mutate files while syncing. apply_patch, subagents, LSP, skills and other plugins/MCP tools are unavailable; use remote bash to edit when write/edit are not offered. No silent local fallback is allowed. sandboxStop syncs and stops the VM without deleting it.`);
    },
    async event({ event }) {
      if (!failure && event.type === "session.idle") await sessions?.idle(event.properties.sessionID);
    },
    async dispose() { await sessions?.dispose(); },
  };
}
