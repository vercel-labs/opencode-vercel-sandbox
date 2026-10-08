#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { exportBranch } from "./git.js";
import { resolveCredentials } from "./auth.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" }, directory: { type: "string", default: process.cwd() }, help: { type: "boolean" } },
});
const command = positionals[0];
if (values.help || !command) {
  console.log("opencode-vercel-sandbox <export|stop|status> --name <sandbox-name> [--directory <local-repository>]");
} else {
  try {
    if (!values.name || !/^oc-[a-f0-9]{32}$/.test(values.name)) throw new Error("--name must identify an OpenCode workspace sandbox (oc- followed by 32 hexadecimal characters)");
    if (!["export", "stop", "status"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const credentials = await resolveCredentials(values.directory!, undefined);
    const sandbox = await Sandbox.get({ ...credentials, name: values.name, resume: command === "export" });
    if (command === "export") console.log(await exportBranch(sandbox, values.directory!));
    if (command === "stop") { await sandbox.stop(); console.log(`Stopped ${sandbox.name}; files retained.`); }
    if (command === "status") console.log(JSON.stringify({ name: sandbox.name, status: sandbox.status, region: sandbox.region }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Workspace command failed");
    process.exitCode = 1;
  }
}
