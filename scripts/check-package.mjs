import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "opencode-package-"));
const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
  cwd: project, encoding: "utf8", maxBuffer: 1024 * 1024,
}));
assert.equal(packed.name, manifest.name);
assert.equal(packed.version, manifest.version);
for (const file of packed.files) {
  assert.ok(file.path.startsWith("dist/") || ["package.json", "README.md", "CONTRIBUTING.md", "LICENSE", "docs/spec.md", "docs/workspace.md", "docs/terminal.md", "docs/releasing.md"].includes(file.path), `Unexpected packed file: ${file.path}`);
}
const consumer = join(root, "consumer");
mkdirSync(consumer);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], {
  cwd: consumer, stdio: "pipe", timeout: 120_000,
});
const installed = join(consumer, "node_modules", manifest.name);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let matched = 0;
function verify(relative) {
  for (const entry of readdirSync(join(project, relative), { withFileTypes: true })) {
    const filename = join(relative, entry.name);
    if (entry.isDirectory()) verify(filename);
    else {
      assert.equal(digest(readFileSync(join(installed, filename))), digest(readFileSync(join(project, filename))), filename);
      matched++;
    }
  }
}
verify("dist");
execFileSync(process.execPath, ["--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import plugin from 'opencode-vercel-sandbox';
  import server from 'opencode-vercel-sandbox/server';
  assert.equal(plugin.id, 'opencode-vercel-sandbox');
  assert.equal(typeof plugin.server, 'function');
  assert.equal(server, plugin);
`], { cwd: consumer, stdio: "pipe" });
assert.match(execFileSync(process.execPath, [join(installed, "dist/cli.js"), "--help"], { encoding: "utf8" }), /export\|stop\|status/);
for (const filename of ["README.md", "CONTRIBUTING.md", "docs/workspace.md", "docs/terminal.md", "docs/spec.md", "docs/releasing.md"]) {
  const markdown = readFileSync(join(installed, filename), "utf8");
  assert.equal(markdown, readFileSync(join(project, filename), "utf8"));
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    readFileSync(join(dirname(join(installed, filename)), match[1].split("#")[0]));
  }
}
console.log(`Package check passed: ${matched} built files match; public imports, CLI and documentation links work.`);
