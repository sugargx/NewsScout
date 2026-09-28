import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAzureGitHubAppCredentialManager,
  GitHubAppCredentialManager,
  GitHubCredentialError,
  parseGitHubOAuthBundle,
  parseKeyVaultSecretUrl,
  type GitHubOAuthBundle,
  type OAuthBundleStore,
} from "./github-credential.js";

class MemoryStore implements OAuthBundleStore {
  saves = 0;
  constructor(public bundle: GitHubOAuthBundle) {}
  async load() { return structuredClone(this.bundle); }
  async save(bundle: GitHubOAuthBundle) {
    this.saves++;
    this.bundle = structuredClone(bundle);
  }
}

class RecoveringStore extends MemoryStore {
  failuresRemaining = 3;
  override async save(value: GitHubOAuthBundle) {
    this.saves++;
    if (this.failuresRemaining-- > 0) throw new Error("temporary Key Vault failure");
    this.bundle = structuredClone(value);
  }
}

class RecoveringWriteProbeStore extends MemoryStore {
  probes = 0;
  failuresRemaining = 1;
  async verifyWrite(value: GitHubOAuthBundle) {
    this.probes++;
    assert.equal(value.generationId, this.bundle.generationId);
    if (this.failuresRemaining-- > 0) throw new Error("temporary Key Vault metadata failure");
  }
}

const baseTime = Date.parse("2026-09-28T06:00:00Z");
function bundle(overrides: Partial<GitHubOAuthBundle> = {}): GitHubOAuthBundle {
  return {
    version: 1,
    generationId: "generation-1",
    accountId: "12345",
    accessToken: "ghu_old",
    accessTokenExpiresAt: new Date(baseTime + 4 * 60 * 60 * 1000).toISOString(),
    refreshToken: "ghr_old",
    refreshTokenExpiresAt: new Date(baseTime + 180 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(baseTime).toISOString(),
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("parses only unversioned Azure Key Vault secret URLs", () => {
  assert.deepEqual(
    parseKeyVaultSecretUrl("https://kv-example.vault.azure.net/secrets/copilot-github-oauth-bundle"),
    { vaultUrl: "https://kv-example.vault.azure.net", secretName: "copilot-github-oauth-bundle" },
  );
  assert.throws(
    () => parseKeyVaultSecretUrl("https://kv-example.vault.azure.net/secrets/copilot/version"),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "configuration_invalid",
  );
});

test("requires an explicit managed credential mode without partial fallback configuration", () => {
  assert.equal(createAzureGitHubAppCredentialManager({ SCOUTNEWS_COPILOT_AUTH_MODE: "disabled" }), undefined);
  assert.throws(
    () => createAzureGitHubAppCredentialManager({
      SCOUTNEWS_COPILOT_AUTH_MODE: "disabled",
      SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID: "Iv1.client",
    }),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "configuration_invalid",
  );
  assert.throws(
    () => createAzureGitHubAppCredentialManager({ SCOUTNEWS_COPILOT_AUTH_MODE: "legacy-pat" }),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "configuration_invalid",
  );
  assert.throws(
    () => createAzureGitHubAppCredentialManager({
      SCOUTNEWS_COPILOT_AUTH_MODE: "github-app",
      SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID: "Iv1.client",
      SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL:
        "https://kv-example.vault.azure.net/secrets/copilot-github-oauth-bundle",
    }),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "configuration_invalid",
  );
});

test("rejects non GitHub App token bundles without exposing values", () => {
  const raw = JSON.stringify(bundle({ accessToken: "github_pat_secret" }));
  assert.throws(
    () => parseGitHubOAuthBundle(raw),
    (error: unknown) => error instanceof GitHubCredentialError &&
      error.code === "bundle_invalid" && !error.message.includes("github_pat_secret"),
  );
});

test("returns a valid cached token without refreshing", async () => {
  const store = new MemoryStore(bundle());
  let requests = 0;
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: async input => {
      requests++;
      assert.equal(String(input), "https://api.github.com/user");
      return jsonResponse({ id: 12345 });
    },
    logger: silentLogger(),
  });
  const result = await manager.tokenProvider({ host: "github.com", reason: "initial", sessionId: "session" });
  assert.equal(result.kind, "token");
  if (result.kind === "token") {
    assert.equal(result.accessToken, "ghu_old");
    assert.equal(result.expiresIn, 4 * 60 * 60);
  }
  assert.equal(requests, 1);
  assert.equal(store.saves, 0);
  assert.equal(manager.status().accountVerified, true);
  assert.equal(manager.status().durable, false);
  assert.equal(manager.status().ready, false);
  manager.stop();
});

test("rejects a bundle whose self-declared account differs from the external pin", async () => {
  let requests = 0;
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store: new MemoryStore(bundle({ accountId: "99999" })),
    now: () => baseTime,
    fetch: async () => { requests++; return jsonResponse({ id: 99999 }); },
    logger: silentLogger(),
  });
  await assert.rejects(
    async () => manager.accessToken(),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "account_changed",
  );
  assert.equal(requests, 0);
  manager.stop();
});

test("refreshes once for concurrent callers, pins the account, and persists before returning", async () => {
  const store = new MemoryStore(bundle({
    accessTokenExpiresAt: new Date(baseTime + 30 * 60 * 1000).toISOString(),
  }));
  let refreshRequests = 0;
  let accountRequests = 0;
  const request: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/login/oauth/access_token")) {
      refreshRequests++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse({
        access_token: "ghu_new",
        expires_in: 28_800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
      });
    }
    if (url === "https://api.github.com/user") {
      accountRequests++;
      return jsonResponse({ id: 12345, login: "ignored" });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: request,
    logger: silentLogger(),
  });
  const [first, second] = await Promise.all([
    manager.tokenProvider({ host: "github.com", reason: "initial", sessionId: "one" }),
    manager.tokenProvider({ host: "github.com", reason: "refresh", sessionId: "two" }),
  ]);
  assert.equal(first.kind, "token");
  assert.equal(second.kind, "token");
  if (first.kind === "token" && second.kind === "token") {
    assert.equal(first.accessToken, "ghu_new");
    assert.equal(second.accessToken, "ghu_new");
    assert.equal(first.expiresIn, 28_800);
  }
  assert.equal(refreshRequests, 1);
  assert.equal(accountRequests, 1);
  assert.equal(store.saves, 1);
  assert.equal(store.bundle.accessToken, "ghu_new");
  assert.equal(store.bundle.accountId, "12345");
  manager.stop();
});

test("persists a rotated pair before rejecting another account", async () => {
  const store = new MemoryStore(bundle({
    accessTokenExpiresAt: new Date(baseTime + 30 * 60 * 1000).toISOString(),
  }));
  const request: typeof fetch = async input => String(input).endsWith("/login/oauth/access_token")
    ? jsonResponse({
      access_token: "ghu_new",
      expires_in: 28_800,
      refresh_token: "ghr_new",
      refresh_token_expires_in: 15_897_600,
    })
    : jsonResponse({ id: 99999 });
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: request,
    logger: silentLogger(),
  });
  await assert.rejects(
    async () => manager.tokenProvider({ host: "github.com", reason: "initial", sessionId: "session" }),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "account_changed",
  );
  assert.equal(store.saves, 1);
  assert.equal(store.bundle.accessToken, "ghu_new");
  assert.equal(store.bundle.refreshToken, "ghr_new");
  manager.stop();
});

test("retries account verification against the retained rotated pair without reusing the old refresh token", async () => {
  const store = new MemoryStore(bundle({
    accessTokenExpiresAt: new Date(baseTime + 30 * 60 * 1000).toISOString(),
  }));
  let refreshRequests = 0;
  let accountRequests = 0;
  const request: typeof fetch = async input => {
    if (String(input).endsWith("/login/oauth/access_token")) {
      refreshRequests++;
      return jsonResponse({
        access_token: "ghu_new",
        expires_in: 28_800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15_897_600,
      });
    }
    accountRequests++;
    return accountRequests === 1 ? jsonResponse({ message: "temporary" }, 503) : jsonResponse({ id: 12345 });
  };
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: request,
    logger: silentLogger(),
    persistenceRetry: 1000,
  });
  await assert.rejects(
    async () => manager.tokenProvider({ host: "github.com", reason: "initial", sessionId: "first" }),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "account_http_503",
  );
  const result = await manager.tokenProvider({ host: "github.com", reason: "initial", sessionId: "second" });
  assert.equal(result.kind, "token");
  if (result.kind === "token") assert.equal(result.accessToken, "ghu_new");
  assert.equal(refreshRequests, 1);
  assert.equal(accountRequests, 2);
  assert.equal(store.saves, 1);
  manager.stop();
});

test("keeps a rotated token in memory and repairs delayed Key Vault persistence", async () => {
  const store = new RecoveringStore(bundle({
    accessTokenExpiresAt: new Date(baseTime + 30 * 60 * 1000).toISOString(),
  }));
  const request: typeof fetch = async input => String(input).endsWith("/login/oauth/access_token")
    ? jsonResponse({
      access_token: "ghu_new",
      expires_in: 28_800,
      refresh_token: "ghr_new",
      refresh_token_expires_in: 15_897_600,
    })
    : jsonResponse({ id: 12345 });
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: request,
    logger: silentLogger(),
    persistenceRetry: 5,
  });
  const result = await manager.tokenProvider({ host: "github.com", reason: "initial", sessionId: "session" });
  assert.equal(result.kind, "token");
  if (result.kind === "token") assert.equal(result.accessToken, "ghu_new");
  assert.equal(manager.status().durable, false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.status().durable, true);
  assert.equal(store.bundle.accessToken, "ghu_new");
  assert.equal(store.saves, 4);
  manager.stop();
});

test("rejects token acquisition for an unexpected GitHub host", async () => {
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store: new MemoryStore(bundle()),
    now: () => baseTime,
    logger: silentLogger(),
  });
  await assert.rejects(
    async () => manager.tokenProvider({ host: "github.example.com", reason: "initial", sessionId: "session" }),
    (error: unknown) => error instanceof GitHubCredentialError && error.code === "host_rejected",
  );
  manager.stop();
});

test("startup verifies the configured account and exercises a Key Vault write", async () => {
  const store = new MemoryStore(bundle());
  let accountRequests = 0;
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: async () => {
      accountRequests++;
      return jsonResponse({ id: 12345 });
    },
    logger: silentLogger(),
  });
  await manager.start();
  assert.equal(accountRequests, 1);
  assert.equal(store.saves, 1);
  assert.equal(manager.status().accountVerified, true);
  assert.equal(manager.status().durable, true);
  assert.equal(manager.status().ready, true);
  manager.stop();
});

test("a failed persistence probe retries metadata without rewriting the bundle value", async () => {
  const store = new RecoveringWriteProbeStore(bundle());
  const manager = new GitHubAppCredentialManager({
    clientId: "Iv1.client",
    expectedAccountId: "12345",
    store,
    now: () => baseTime,
    fetch: async () => jsonResponse({ id: 12345 }),
    logger: silentLogger(),
    persistenceRetry: 5,
  });
  await manager.start();
  assert.equal(manager.status().durable, false);
  assert.equal(store.saves, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.probes, 2);
  assert.equal(store.saves, 0);
  assert.equal(manager.status().durable, true);
  manager.stop();
});
