# Run OpenCode in a Sandbox terminal

Create a Vercel Sandbox with OpenCode already installed, connect to its terminal, then run OpenCode there. Your laptop displays the terminal; OpenCode, its files and its commands run inside the Sandbox.

This uses the existing Vercel CLI and managed universal image. You do not need this package, the workspace plugin, a local OpenCode installation or `/warp`.

## Before you start

- Install [Vercel CLI](https://vercel.com/docs/cli) and run `vercel login` on your laptop. This flow was tested with Vercel CLI **62.5.0**.
- Choose an existing Vercel team and project with Sandbox access. Replace `your-team` and `your-project` below with their names or IDs. This project owns the Sandbox and its usage charges.

You can try the tested default OpenCode model without a model-provider login or API key. You still need Vercel login, and normal [Sandbox compute and storage charges](https://vercel.com/docs/sandbox/pricing) apply. Other models may require credentials.

## 1. Create a Sandbox and enter its terminal

Run this on your laptop:

```sh
vercel sandbox create \
  --name opencode-demo \
  --image vercel/sandbox/universal \
  --timeout 15m \
  --connect \
  --scope your-team \
  --project your-project
```

Choose a different name if `opencode-demo` already exists in that project. To return to an existing Sandbox, use `connect` rather than creating it again.

Once the remote shell appears, these commands run inside the Sandbox:

```sh
pwd
opencode --version
```

In the tested image, the shell starts at `/vercel` and OpenCode is already on `PATH`. No separate agent installation or public server port is needed. The managed image rolls forward, so its agent version can change; it is not pinned to the workspace plugin's OpenCode version.

## 2. Run OpenCode inside the Sandbox

In that remote shell:

```sh
mkdir -p /vercel/sandbox/project
cd /vercel/sandbox/project
export OPENCODE_DISABLE_AUTOUPDATE=true
opencode
```

Start with a disposable example. In the verified setup, OpenCode selected **Big Pickle / OpenCode Zen** and completed a file edit without a model-provider login, API key or saved credentials.

Ask it:

```text
Create hello.txt containing Hello from Vercel Sandbox, then read it back using the terminal.
```

Model availability and authentication requirements can change. OpenCode lists Big Pickle as free for a limited time and says collected data may be used to improve the model. Review [OpenCode's model privacy information](https://opencode.ai/docs/zen/#privacy) before sharing code or prompts. Do not use sensitive code for this first test.

To use your own model access, enter `/connect`, select **Vercel AI Gateway**, and enter your [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok). Then use `/models` to choose a model. This is optional for the tested default, not a prerequisite for starting OpenCode. See [OpenCode's AI Gateway setup](https://opencode.ai/docs/providers/#vercel-ai-gateway).

Now ask OpenCode to create, edit or test files. It works in the remote directory you opened. Creating the Sandbox does not copy your laptop's project, OpenCode settings or saved model credentials. Use Git inside the Sandbox or the CLI's file-copy command to bring in code explicitly.

Code running in this Sandbox can access credentials saved there. Files and saved credentials can persist when the Sandbox is stopped; only configure keys you are willing to make available to that environment.

## 3. Exit and stop compute

Enter `/exit` in OpenCode, then `exit` in the remote shell. You are back at your laptop's terminal.

**Disconnecting does not stop the Sandbox.** Stop it explicitly from your laptop:

```sh
vercel sandbox stop opencode-demo \
  --scope your-team --project your-project
```

The Sandbox retains filesystem state by default. Stopping ends compute, but retained storage remains billable. The initial timeout above is 15 minutes; interactive connections can extend it. Do not use disconnecting as a cleanup strategy.

By default, snapshots expire 30 days after their last use. When you no longer need the Sandbox, copy out anything you want to keep, then use `vercel sandbox remove opencode-demo --delete-orphan-snapshots --scope your-team --project your-project` to permanently remove it and snapshots that are not used by another Sandbox. Without that flag, removal keeps snapshots. Shared snapshots remain retained and can still incur storage charges; manage them separately with [snapshot commands](https://vercel.com/docs/sandbox/cli-reference#sandbox-snapshots-delete). Removal prevents reconnection to this Sandbox, so do not remove it if you want to return to its files and conversation.

## 4. Reconnect and continue

On your laptop:

```sh
vercel sandbox connect opencode-demo \
  --scope your-team --project your-project
```

In the remote shell:

```sh
cd /vercel/sandbox/project
export OPENCODE_DISABLE_AUTOUPDATE=true
opencode --continue
```

This starts OpenCode again using retained files and conversation history. It does not restore a running agent process or an interrupted model turn. Exit both OpenCode and the shell, then stop the Sandbox when you finish.

## Bring files back

Files do not automatically sync to your laptop. While the Sandbox is running, you can copy an individual file from a separate local terminal:

```sh
vercel sandbox copy \
  opencode-demo:/vercel/sandbox/project/hello.txt \
  ./hello-from-sandbox.txt \
  --scope your-team --project your-project
```

Use the actual remote filename and a new local destination you are willing to write. Stop the Sandbox afterwards. For larger projects, use your normal Git workflow. This native terminal flow does not use the workspace plugin's `export` command.

## Verified scope

On October 7, 2026, a fresh Sandbox with the same CLI and image opened OpenCode **1.18.33** with **Big Pickle / OpenCode Zen** selected. A terminal-submitted request created and read a test file. Independent verification returned `VERCEL_NO_AUTH_E2E_PASS`: the contents matched, no OpenCode auth file existed, and no credential environment variables were present. No model credentials, local settings or project files were forwarded. The terminal exited cleanly and the Sandbox was stopped and retained. This verifies that default model in this setup, not that every model or future image is authentication-free.

On October 7, 2026, Vercel CLI 62.5.0 created and connected to the universal image with OpenCode **1.18.33** already installed. A terminal-submitted Gateway agent request edited a test file and ran its test successfully. After explicit stop and reconnect, the file and conversation survived and a second terminal-submitted test passed. The test Sandbox was stopped and retained.

The automated test provisioned one Gateway credential in the remote OpenCode auth store; interactive `/connect` key entry is documented upstream but was not exercised in that test. Destructive removal was not run; the cleanup flag was checked against CLI help. No local plugin or OpenCode installation was used. The separately tested workspace plugin remains pinned to 1.18.32.

References: [Sandbox CLI](https://vercel.com/docs/sandbox/cli-reference), [managed images](https://vercel.com/docs/sandbox/concepts/images), [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes).
