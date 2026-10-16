# Contributing

Use Node.js 22 or 24 and Git. Run the credential-free checks before submitting a change:

```sh
npm ci
npm run check
npm run build
npm run test:package
```

The package test creates and installs an actual tarball in a temporary directory. It verifies the public exports, CLI help, shipped build files and relative documentation links. CI runs these checks on both Node versions without Vercel or model credentials.

Runtime changes also need a real OpenCode 1.18.32 test against a disposable Git project and a Vercel Sandbox. Confirm a remote edit, automatic Git return, unchanged local working files and explicit Sandbox stop. Never commit credentials, `.vercel/`, raw logs or Sandbox identifiers.

The preview is restricted to OpenCode 1.18.32. Do not widen compatibility based only on unit tests. See [the release checklist](docs/releasing.md) for the separate publication gates.
