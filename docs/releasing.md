# Release checklist

This package is not published. `private: true` prevents accidental npm publication while engineering review, licensing and publisher ownership are pending.

## 1. Review the repository

- Approve both the automatic-tool boundary and the workspace credential-forwarding behavior.
- Approve a license and add its text before public distribution.
- Confirm the npm name and the Vercel-owned publisher. A registry 404 does not reserve the name.
- Run CI and review the rendered README, setup instructions and packaged files.

## 2. Publish the approved preview

After review, make the repository public, verify its actual default branch and installation instructions, remove the private publication guard and set the approved license metadata. Keep the preview version and publish under a non-default `preview` tag. Configure npm publishing through the approved Vercel owner; do not put a personal token in repository files.

Do not publish or merge automatically from the initial review workflow. An authorized maintainer performs the first release after reviewing the exact package contents.

## 3. Test the published package

In a fresh OpenCode 1.18.32 profile with no development paths or extra plugins, use the published package name and exact preview version:

```json
{
  "plugin": [
    ["opencode-vercel-sandbox@0.1.0-preview.0", { "mode": "automatic" }]
  ]
}
```

This configuration is for the future release, not an installation command that works today. Verify Vercel login/project selection, a real remote edit/test, automatic return to a separate branch, unchanged local HEAD/index/worktree, reconnect and explicit stop. Retain evidence without publishing credentials or resource IDs. A clean local tarball installation is not this test.

## 4. Submit the OpenCode listing

Once the public package installation works, submit an entry to the [OpenCode ecosystem](https://opencode.ai/docs/ecosystem/). Link the public repository and document the supported OpenCode version. Listing approval is separate from npm publication.

## 5. Publish the Vercel ecosystem guide

Document both automatic plugin mode and the separate Sandbox CLI shortcut. Verify the released CLI version and actual command before adding it. Link the published plugin and tested setup, not a local prototype. Review the deployed docs preview before sharing it.
