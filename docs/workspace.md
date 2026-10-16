# Remote workspace mode

This mode runs the OpenCode server and agent inside a persistent Vercel Sandbox. Select it explicitly with `/warp`. It is separate from [automatic tools](../README.md), where OpenCode and model authentication stay local.

Workspace mode supports **AI Gateway API keys only**. The plugin keeps the real provider key outside the VM and gives it to the Sandbox firewall, which adds it to matching Gateway model requests. The remote OpenCode configuration contains a non-secret placeholder. Automatic mode keeps model authentication local as before.

Code in the VM can still make billable requests through the broker. This protects the key, not your model budget. The separate OpenCode server password and any secrets you commit to Git are outside this provider-key boundary.

This unreleased preview supports OpenCode **1.18.32** and Sandbox SDK **3.5.0**.

## Install once

Requires Node.js 22+, Git, Vercel CLI, and the pinned OpenCode CLI. If OpenCode is already installed, use its version-specific upgrade command:

```sh
export OPENCODE_DISABLE_AUTOUPDATE=true
opencode upgrade 1.18.32
opencode --version
```

Keep `OPENCODE_DISABLE_AUTOUPDATE=true` in the environment that launches OpenCode while using this version-pinned prototype. Otherwise its automatic patch updates can replace the tested CLI. Add the export to your shell profile for future shells.

Confirm the output is exactly `1.18.32` before continuing. If `/warp` is missing, check the workspace flag below. If `/warp` opens but Vercel Sandbox is missing, check the CLI version and global plugin entry, then restart OpenCode. An incompatible local plugin can fail to load without a visible error.

From this package directory, build and register the local package using OpenCode's own installer:

```sh
npm ci
npm run check
npm run build
opencode plugin --global "$PWD"
```

Keep this package directory in place. OpenCode records its path in your global configuration at `~/.config/opencode/opencode.json` or an existing `opencode.jsonc` (under `$XDG_CONFIG_HOME` if configured). You do not need an `opencode.json` in each project. To install for one project instead, run `opencode plugin /absolute/path/to/this/package` from that project without `--global`.

Enable the experimental workspace selector in the shell that starts OpenCode:

```sh
export OPENCODE_EXPERIMENTAL_WORKSPACES=true
```

Add that export to your shell profile if you want it enabled in future terminal windows. Registering the plugin makes a workspace option available; it does not create a Sandbox merely because you start OpenCode.

Existing shells and app-launched panes may not inherit a newly added export. If `/warp` is absent, exit OpenCode and run these commands in the terminal that launches it:

```sh
export OPENCODE_EXPERIMENTAL_WORKSPACES=true
export OPENCODE_DISABLE_AUTOUPDATE=true
opencode
```

## Connect Vercel and your model

Sign in with the official Vercel CLI once:

```sh
vercel login
```

From the root of the Git repository you want to work on, select the team-owned Vercel project that should own and pay for the Sandbox:

```sh
vercel link
```

The plugin uses your existing Vercel CLI login and the repository's `.vercel/project.json`. Expired login tokens are refreshed through the official CLI. If login or project linking is missing, it gives instructions instead of opening an interactive login inside OpenCode or choosing a billing project for you. Keep `.vercel/` out of Git.

In your local OpenCode profile, use `/connect` to save a Vercel AI Gateway API key. Alternatively, set `AI_GATEWAY_API_KEY` in the shell that launches OpenCode. Keep the same source available when reconnecting. If both sources contain API keys, their keys must match. An explicit host API key works alongside a saved non-API login, which is ignored. The plugin doesn't execute Keychain lookup commands from provider configuration; use one of these two sources.

Choose one Gateway model in the plugin options, keeping the actual local package path:

```json
{
  "plugin": [
    [
      "/absolute/path/to/opencode-vercel-sandbox",
      { "remoteConfig": { "model": "vercel/openai/gpt-5.4-mini" } }
    ]
  ]
}
```

Do not put keys in that file. `forwardEnv`, arbitrary provider configuration, OAuth, and subscription logins are not supported in workspace mode. Other saved provider credentials are ignored. The remote provider list contains only Vercel AI Gateway, and the firewall authenticates requests for the configured model only. A different model requires a new workspace. Vercel Sandbox management credentials stay on your laptop.

For automation, the original environment authentication remains supported: a current `VERCEL_OIDC_TOKEN`, or all three of `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. Explicit environment authentication takes precedence over local login. This plugin does not load `.env.local` automatically.

## Start working

Your repository must have at least one commit. From its folder:

```sh
opencode
```

In OpenCode, enter `/warp`, then select **Vercel Sandbox** under **New workspace**. The plugin creates the VM, uploads your committed `HEAD` and Git history, and starts the pinned OpenCode server. Wait for workspace creation to finish, then ask the agent to work normally.

Files and commands run under `/vercel/sandbox/project`. Your local staged, unstaged and untracked changes are not uploaded or overwritten. Review committed history for sensitive data before creating a workspace. Select the workspace before sending your coding request; starting OpenCode alone is still local.

Each workspace has one persistent Sandbox. Resume the existing OpenCode session to reconnect rather than choosing another **New workspace**. Files and conversation history persist across a VM stop; running processes do not. Reconnection refreshes the firewall policy before resuming the VM and starting the OpenCode server. Missing keys or a failed policy update prevent a connection. Project OpenCode configuration is disabled remotely to prevent recursively loading laptop-only plugins.

Workspaces created before credential brokering are refused. Their files and snapshots may still contain copied credentials. Create a fresh workspace; export anything needed from the old one, then decide whether to revoke its keys and delete its retained data. Upgrading the plugin does not clean old snapshots. Never copy an old snapshot into a new brokered workspace.

## Export and stop

Export when the agent is idle. From your linked repository, list the OpenCode Sandboxes in its Vercel project:

```sh
vercel sandbox list --all --name-prefix oc-
```

Use the actual `oc-` name for your Sandbox below. The host workspace API also returns it in `extra.sandboxName`.

```sh
node /absolute/path/to/this/package/dist/cli.js export \
  --name oc-your-sandbox-name --directory /path/to/your/repository
```

The command prints a new `vercel-sandbox/...` Git branch containing remote tracked changes, deletions and untracked files allowed by `.gitignore`. It does not check out that branch, merge it, or change your local HEAD, index or working tree. Review it with `git diff HEAD..<returned-branch>`. Export is not an editing lock; do not send more agent turns while exporting.

Exit the OpenCode host before stopping, since an active connection can resume the VM:

```sh
node /absolute/path/to/this/package/dist/cli.js stop \
  --name oc-your-sandbox-name --directory /path/to/your/repository
node /absolute/path/to/this/package/dist/cli.js status \
  --name oc-your-sandbox-name --directory /path/to/your/repository
```

Ordinary `/exit` does not itself stop a workspace. The earlier private test launcher did, but that is not the plugin's general behavior. Removing a workspace through OpenCode stops its VM and removes the host registration; use stop, not removal, if you want to reconnect through the same session. The plugin never permanently deletes a Sandbox.

Default session timeout is 30 minutes. This plugin explicitly sets `snapshotExpiration: 0`, so its latest filesystem snapshot has no expiration and retained storage remains billable after the VM stops. This differs from the native terminal flow's 30-day default. Permanently delete unneeded Sandboxes only after exporting anything you need. Ordinary removal keeps snapshots: use `vercel sandbox remove` with `--delete-orphan-snapshots` to also delete snapshots not used by another Sandbox. Shared snapshots remain retained; see the [cleanup notes](terminal.md#3-exit-and-stop-compute).

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `project` | Linked repository | Explicit `{ "teamId": "...", "projectId": "..." }` for a shared global billing project; CLI operations still need a linked repository or explicit environment scope |
| `image` | `vercel/sandbox/node:24` | Image providing Node/npm, Git, Bash and `flock` |
| `region` | Project default | Sandbox region |
| `timeoutMs` | `1800000` | Session duration, from 1 to 45 minutes |
| `vcpus` | `2` | 1, 2 or 4 vCPUs, subject to plan limits |
| `previewPorts` | `[]` | Additional exposed ports; 4096 is reserved for authenticated OpenCode |
| `remoteConfig.model` | Required before activation | One `vercel/<provider>/<model>` model; other remote provider settings are rejected |

Network egress remains open for developer tools. A firewall rule adds the Gateway key only to `POST /v3/ai/language-model` on `ai-gateway.vercel.sh` for the configured model and pins its `Host` header. Other requests receive no injected key; they are not blocked by this rule. TLS verification remains enabled. See [credential brokering](https://vercel.com/docs/sandbox/concepts/firewall#credentials-brokering).

Additional preview ports are public; protect any application you expose. OpenCode's server requires a generated password. Private connection keys and non-secret broker records live in `$XDG_DATA_HOME/opencode/vercel-sandbox`, defaulting to `~/.local/share/opencode/vercel-sandbox`. Preserve them for reconnection; never share or commit them. Missing records fail closed instead of replacing the VM. An activation lock serializes workspace operations; inspect stale locks rather than deleting them blindly.

## HTTP clients

Start `opencode serve` with the same global configuration and workspace flag. `GET /experimental/workspace/adapter` lists adapters; `POST /experimental/workspace` with `{"type":"vercel-sandbox","branch":null}` creates a workspace. After starting or restarting the host, call `POST /sync/start` and wait for `GET /experimental/workspace/status` to report `connected`. Route requests with `?workspace=<workspace-id>`. Do not attach a client directly to the VM for a host-owned workspace; connect through its local host so workspace routing and registration remain available.

## Workspace-mode scope

No automatic branch sync, live-process recovery, workspace forking, local dirty-file upload or OpenCode 2.x promise. Package publication is separate from local installation. See [the specification](spec.md).

Sources: [OpenCode plugins](https://opencode.ai/docs/plugins/), [pinned global installer](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/plug.ts), [workspace selector](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/tui/src/component/dialog-workspace-create.tsx), [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference), [Sandbox authentication](https://vercel.com/docs/sandbox/concepts/authentication).
