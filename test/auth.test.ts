import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCredentials } from "../src/auth.js";
import { optionsSchema } from "../src/config.js";

const loginDependencies = (overrides = {}) => ({ env: {}, ...overrides });

test("environment credentials take precedence over login and configured scope", async () => {
  let loginReads = 0;
  const getAuth = () => {
    loginReads += 1;
    return { token: "login-token" };
  };

  const oidc = await resolveCredentials("/fixture", { teamId: "configured-team", projectId: "configured-project" }, {
    getAuth,
    env: {
      VERCEL_OIDC_TOKEN: "oidc",
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    },
  });
  assert.deepEqual(oidc, {});

  const accessToken = await resolveCredentials("/fixture", { teamId: "configured-team", projectId: "configured-project" }, {
    getAuth,
    env: { VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" },
  });
  assert.deepEqual(accessToken, { token: "token", teamId: "team", projectId: "project" });
  assert.equal(loginReads, 0);
});

test("partial explicit environment credentials reject without reading login", async () => {
  let loginReads = 0;
  const getAuth = () => {
    loginReads += 1;
    return { token: "login-token" };
  };

  await assert.rejects(resolveCredentials("/fixture", undefined, {
    getAuth,
    env: { VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team" },
  }), /Set VERCEL_OIDC_TOKEN/);
  await assert.rejects(resolveCredentials("/fixture", undefined, {
    getAuth,
    env: { VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" },
  }), /Set VERCEL_OIDC_TOKEN/);
  assert.equal(loginReads, 0);
});

test("configured project and repository-linked project provide explicit scope", async () => {
  const getAuth = () => ({ token: "token" });
  const configured = await resolveCredentials(
    "/fixture",
    { teamId: "configured-team", projectId: "configured-project" },
    loginDependencies({ getAuth }),
  );
  assert.deepEqual(configured, {
    token: "token",
    teamId: "configured-team",
    projectId: "configured-project",
  });

  const linked = await resolveCredentials("/fixture", undefined, loginDependencies({
    getAuth,
    gitRoot: async () => "/git-root",
    readFile: async () => JSON.stringify({ orgId: "linked-team", projectId: "linked-project", projectName: "my-project" }),
  }));
  assert.deepEqual(linked, { token: "token", teamId: "linked-team", projectId: "linked-project" });
});

test("malformed linked project files reject safely", async () => {
  for (const content of [
    JSON.stringify({ orgId: "", projectId: "project" }),
    JSON.stringify({ orgId: "team" }),
    "{invalid json",
  ]) {
    await assert.rejects(resolveCredentials("/fixture", undefined, {
      ...loginDependencies({ getAuth: () => ({ token: "token" }) }),
      gitRoot: async () => "/git-root",
      readFile: async () => content,
    }), (error: Error) => {
      return error.message.includes("Invalid .vercel/project.json") && !error.message.includes("extra");
    });
  }
});

test("missing or incomplete login gives instructions without interactive login", async () => {
  let refreshes = 0;
  const refreshLogin = async () => {
    refreshes += 1;
  };

  await assert.rejects(resolveCredentials("/fixture", { teamId: "team", projectId: "project" }, {
    ...loginDependencies({ getAuth: () => null }),
    refreshLogin,
  }), /Run vercel login/);
  await assert.rejects(resolveCredentials("/fixture", { teamId: "team", projectId: "project" }, {
    ...loginDependencies({ getAuth: () => ({ refreshToken: "refresh" }) }),
    refreshLogin,
  }), /Run vercel login/);
  assert.equal(refreshes, 0);
});

test("expired login refreshes, re-reads, and rejects missing or still-expired auth", async () => {
  const expired = { token: "expired", expiresAt: new Date(0) };
  const valid = { token: "valid", expiresAt: new Date(Date.now() + 60_000) };
  let reads = 0;
  let refreshes = 0;
  const getAuth = () => {
    reads += 1;
    return reads === 1 ? expired : valid;
  };

  const refreshed = await resolveCredentials("/fixture", { teamId: "team", projectId: "project" }, loginDependencies({
    getAuth,
    refreshLogin: async (teamId: string) => {
      assert.equal(teamId, "team");
      refreshes += 1;
    },
  }));
  assert.deepEqual(refreshed, { token: "valid", teamId: "team", projectId: "project" });
  assert.equal(refreshes, 1);

  await assert.rejects(resolveCredentials("/fixture", { teamId: "team", projectId: "project" }, {
    ...loginDependencies({ getAuth: () => expired }),
    refreshLogin: async () => {},
  }), /still expired/);

  await assert.rejects(resolveCredentials("/fixture", { teamId: "team", projectId: "project" }, {
    ...loginDependencies({ getAuth: () => expired }),
    refreshLogin: async () => {},
    readFile: async () => {
      throw new Error("should not read project metadata");
    },
  }), /still expired/);
});

test("refresh failures and missing scope produce safe errors", async () => {
  await assert.rejects(resolveCredentials("/fixture", { teamId: "team", projectId: "project" }, {
    ...loginDependencies({ getAuth: () => ({ token: "expired", expiresAt: new Date(0) }) }),
    refreshLogin: async () => {
      throw Object.assign(new Error("secret stdout and stderr"), {
        stdout: "secret-output",
        stderr: "secret-error",
      });
    },
  }), (error: Error) => !error.message.includes("secret"));

  await assert.rejects(resolveCredentials("/fixture", undefined, {
    ...loginDependencies({ getAuth: () => ({ token: "token" }) }),
    gitRoot: async () => null,
  }), /No explicit Sandbox project/);
});

test("project option requires exactly team and project IDs", () => {
  assert.deepEqual(
    optionsSchema.parse({ project: { teamId: "team", projectId: "project" } }).project,
    { teamId: "team", projectId: "project" },
  );
  assert.throws(() => optionsSchema.parse({ project: { teamId: "team" } }));
  assert.throws(() => optionsSchema.parse({ project: { teamId: "team", projectId: "project", extra: true } }));
});
