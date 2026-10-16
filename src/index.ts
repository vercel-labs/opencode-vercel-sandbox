import type { PluginModule } from "@opencode-ai/plugin";
import { createAdapter } from "./workspace.js";
import { automatic } from "./automatic.js";

export default {
  id: "opencode-vercel-sandbox",
  async server(context, options) {
    if (options?.mode === "automatic") return automatic(context, options);
    if (!context.experimental_workspace?.register) throw new Error("Vercel Sandbox requires the OpenCode 1.18.32 workspace API.");
    context.experimental_workspace.register("vercel-sandbox", createAdapter(context, options));
    return {};
  },
} satisfies PluginModule;
