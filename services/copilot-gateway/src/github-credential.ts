import { ManagedIdentityCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { GitHubTokenProvider, GitHubTokenProviderArgs, GitHubTokenProviderResult } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";

const githubHost = "github.com";
const refreshWindowMs = 90 * 60 * 1000;
const minimumProviderLifetimeSeconds = 60 * 60;
const refreshTokenWarningMs = 14 * 24 * 60 * 60 * 1000;
const persistenceRetryMs = 30_000;

export interface GitHubOAuthBundle {
  version: 1;
  generationId: string;
  accountId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  updatedAt: string;
}

export interface OAuthBundleStore {
  load(): Promise<GitHubOAuthBundle>;
  save(bundle: GitHubOAuthBundle): Promise<void>;
  verifyWrite?(bundle: GitHubOAuthBundle): Promise<void>;
}

interface CredentialLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

interface CredentialManagerOptions {
  clientId: string;
  expectedAccountId: string;
  store: OAuthBundleStore;
  fetch?: typeof fetch;
  now?: () => number;
  logger?: CredentialLogger;
  refreshWindow?: number;
  persistenceRetry?: number;
}

function eventLogger(level: "info" | "warn" | "error") {
  return (event: Record<string, unknown>) => console[level](JSON.stringify(event));
}

const defaultLogger: CredentialLogger = {
  info: eventLogger("info"),
  warn: eventLogger("warn"),
  error: eventLogger("error"),
};

export class GitHubCredentialError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GitHubCredentialError";
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GitHubCredentialError("bundle_invalid", `GitHub OAuth bundle field ${field} is invalid.`);
  }
  return value;
}

function requiredDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new GitHubCredentialError("bundle_invalid", `GitHub OAuth bundle field ${field} is not a timestamp.`);
  }
  return text;
}

function requiredAccountId(value: unknown, field: string): string {
  const text = requiredString(value, field);
  const numeric = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(numeric)) {
    throw new GitHubCredentialError("bundle_invalid", `GitHub OAuth bundle field ${field} is not a numeric account ID.`);
  }
  return text;
}

export function parseGitHubOAuthBundle(value: string): GitHubOAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GitHubCredentialError("bundle_invalid", "GitHub OAuth bundle is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new GitHubCredentialError("bundle_invalid", "GitHub OAuth bundle is not an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new GitHubCredentialError("bundle_invalid", "GitHub OAuth bundle version is unsupported.");
  }
  const accessToken = requiredString(record.accessToken, "accessToken");
  const refreshToken = requiredString(record.refreshToken, "refreshToken");
  if (!accessToken.startsWith("ghu_")) {
    throw new GitHubCredentialError("bundle_invalid", "GitHub OAuth access token is not a GitHub App user token.");
  }
  if (!refreshToken.startsWith("ghr_")) {
    throw new GitHubCredentialError("bundle_invalid", "GitHub OAuth refresh token has an unexpected type.");
  }
  return {
    version: 1,
    generationId: requiredString(record.generationId, "generationId"),
    accountId: requiredAccountId(record.accountId, "accountId"),
    accessToken,
    accessTokenExpiresAt: requiredDate(record.accessTokenExpiresAt, "accessTokenExpiresAt"),
    refreshToken,
    refreshTokenExpiresAt: requiredDate(record.refreshTokenExpiresAt, "refreshTokenExpiresAt"),
    updatedAt: requiredDate(record.updatedAt, "updatedAt"),
  };
}

export function parseKeyVaultSecretUrl(value: string): { vaultUrl: string; secretName: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubCredentialError("configuration_invalid", "Copilot OAuth bundle secret URL is invalid.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vault.azure.net") ||
      segments.length !== 2 || segments[0] !== "secrets" || !segments[1] || url.search || url.hash) {
    throw new GitHubCredentialError(
      "configuration_invalid",
      "Copilot OAuth bundle URL must identify the latest version of one Azure Key Vault secret.",
    );
  }
  return { vaultUrl: `${url.protocol}//${url.hostname}`, secretName: segments[1] };
}

export class AzureOAuthBundleStore implements OAuthBundleStore {
  private readonly client: SecretClient;
  private readonly secretName: string;

  constructor(secretUrl: string, managedIdentityClientId: string) {
    if (!managedIdentityClientId.trim()) {
      throw new GitHubCredentialError("configuration_invalid", "AZURE_CLIENT_ID is required for Copilot OAuth.");
    }
    const parsed = parseKeyVaultSecretUrl(secretUrl);
    this.secretName = parsed.secretName;
    this.client = new SecretClient(parsed.vaultUrl, new ManagedIdentityCredential(managedIdentityClientId));
  }

  async load(): Promise<GitHubOAuthBundle> {
    const secret = await this.client.getSecret(this.secretName);
    if (!secret.value) {
      throw new GitHubCredentialError("bundle_missing", "Copilot OAuth bundle has no value.");
    }
    return parseGitHubOAuthBundle(secret.value);
  }

  async save(bundle: GitHubOAuthBundle): Promise<void> {
    await this.client.setSecret(this.secretName, JSON.stringify(bundle), {
      contentType: "application/vnd.newsscout.github-oauth-bundle+json",
      expiresOn: new Date(bundle.refreshTokenExpiresAt),
      tags: {
        accountId: bundle.accountId,
        generationId: bundle.generationId,
        managedBy: "NewsScout",
      },
    });
  }

  async verifyWrite(bundle: GitHubOAuthBundle): Promise<void> {
    const current = await this.client.getSecret(this.secretName);
    if (!current.value || !current.properties.version) {
      throw new GitHubCredentialError("bundle_missing", "Copilot OAuth bundle has no writable version.");
    }
    const stored = parseGitHubOAuthBundle(current.value);
    if (stored.generationId !== bundle.generationId) {
      throw new GitHubCredentialError("bundle_write_conflict", "A different OAuth bundle version became current.");
    }
    const marker = randomUUID();
    await this.client.updateSecretProperties(this.secretName, current.properties.version, {
      tags: {
        ...current.properties.tags,
        accountId: bundle.accountId,
        generationId: bundle.generationId,
        managedBy: "NewsScout",
        persistenceProbe: marker,
      },
    });
    const verified = await this.client.getSecret(this.secretName, { version: current.properties.version });
    if (verified.properties.tags?.persistenceProbe !== marker || !verified.value ||
        parseGitHubOAuthBundle(verified.value).generationId !== bundle.generationId) {
      throw new GitHubCredentialError("bundle_write_verification_failed", "Key Vault write verification failed.");
    }
  }
}

function normalizedHost(value: string): string {
  const text = value.trim().toLowerCase().replace(/^https?:\/\//, "");
  return text.split("/", 1)[0].replace(/:\d+$/, "");
}

function secondsRemaining(expiresAt: string, now: number): number {
  return Math.floor((Date.parse(expiresAt) - now) / 1000);
}

function publicErrorCode(error: unknown): string {
  return error instanceof GitHubCredentialError ? error.code
    : error instanceof DOMException && error.name === "TimeoutError" ? "request_timeout"
      : error instanceof TypeError ? "request_failed"
        : "unexpected_error";
}

async function fetchWithTimeout(
  request: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  milliseconds: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    milliseconds,
  );
  timer.unref();
  try {
    return await request(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class GitHubAppCredentialManager {
  private readonly clientId: string;
  private readonly expectedAccountId: string;
  private readonly store: OAuthBundleStore;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly logger: CredentialLogger;
  private readonly refreshWindow: number;
  private readonly persistenceRetry: number;
  private cached?: GitHubOAuthBundle;
  private refreshPromise?: Promise<GitHubOAuthBundle>;
  private pendingPersistence?: GitHubOAuthBundle;
  private persistenceVerificationPending = false;
  private verifiedGenerationId?: string;
  private persistenceVerifiedGenerationId?: string;
  private verificationPromise?: { generationId: string; promise: Promise<void> };
  private refreshTimer?: NodeJS.Timeout;
  private persistenceTimer?: NodeJS.Timeout;
  private persistenceVerificationTimer?: NodeJS.Timeout;
  private verificationTimer?: NodeJS.Timeout;
  private lastErrorCode?: string;
  private lastRefreshAt?: string;
  private stopped = false;

  constructor(options: CredentialManagerOptions) {
    if (!options.clientId.trim()) {
      throw new GitHubCredentialError("configuration_invalid", "GitHub App client ID is required.");
    }
    this.clientId = options.clientId;
    try {
      this.expectedAccountId = requiredAccountId(options.expectedAccountId, "expectedAccountId");
    } catch {
      throw new GitHubCredentialError("configuration_invalid", "Expected GitHub numeric account ID is required.");
    }
    this.store = options.store;
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? defaultLogger;
    this.refreshWindow = options.refreshWindow ?? refreshWindowMs;
    this.persistenceRetry = options.persistenceRetry ?? persistenceRetryMs;
  }

  readonly tokenProvider: GitHubTokenProvider = async (args: GitHubTokenProviderArgs): Promise<GitHubTokenProviderResult> => {
    if (normalizedHost(args.host) !== githubHost) {
      throw new GitHubCredentialError("host_rejected", "Copilot requested a credential for an unexpected GitHub host.");
    }
    const bundle = await this.acquire(args.reason);
    const expiresIn = secondsRemaining(bundle.accessTokenExpiresAt, this.now());
    if (expiresIn <= minimumProviderLifetimeSeconds) {
      throw new GitHubCredentialError("access_token_too_close_to_expiry", "Refreshed GitHub token lifetime is too short.");
    }
    return { kind: "token", accessToken: bundle.accessToken, tokenType: "bearer", expiresIn };
  };

  async start(): Promise<void> {
    this.stopped = false;
    try {
      const bundle = await this.load();
      const current = await this.refreshIfNeeded(bundle);
      if (this.persistenceVerifiedGenerationId !== current.generationId) {
        try {
          await this.verifyPersistence(current);
          this.persistenceVerificationPending = false;
        } catch (error) {
          this.persistenceVerificationPending = true;
          this.lastErrorCode = publicErrorCode(error);
          this.schedulePersistenceVerificationRetry();
          this.logger.error({
            category: "copilot_credential_persistence_verification_pending",
            errorCode: this.lastErrorCode,
          });
        }
      }
    } catch (error) {
      this.lastErrorCode = publicErrorCode(error);
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    if (this.persistenceVerificationTimer) clearTimeout(this.persistenceVerificationTimer);
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.refreshTimer = undefined;
    this.persistenceTimer = undefined;
    this.persistenceVerificationTimer = undefined;
    this.verificationTimer = undefined;
  }

  async accessToken(): Promise<string> {
    return (await this.acquire("initial")).accessToken;
  }

  status(): {
    configured: true;
    ready: boolean;
    accountVerified: boolean;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    durable: boolean;
    refreshTokenNearExpiry: boolean;
    lastErrorCode?: string;
    lastRefreshAt?: string;
  } {
    const accountVerified = !!this.cached && this.verifiedGenerationId === this.cached.generationId;
    const durable = !!this.cached && !this.pendingPersistence && !this.persistenceVerificationPending &&
      this.persistenceVerifiedGenerationId === this.cached.generationId;
    return {
      configured: true,
      ready: accountVerified && durable,
      accountVerified,
      accessTokenExpiresAt: this.cached?.accessTokenExpiresAt,
      refreshTokenExpiresAt: this.cached?.refreshTokenExpiresAt,
      durable,
      refreshTokenNearExpiry: !!this.cached &&
        Date.parse(this.cached.refreshTokenExpiresAt) - this.now() <= refreshTokenWarningMs,
      lastErrorCode: this.lastErrorCode,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  private async acquire(reason: "initial" | "refresh"): Promise<GitHubOAuthBundle> {
    const bundle = this.cached ?? await this.load();
    const accessRemaining = Date.parse(bundle.accessTokenExpiresAt) - this.now();
    if (reason === "refresh" || accessRemaining <= this.refreshWindow) {
      if (accessRemaining > this.refreshWindow) await this.ensureAccountVerified(bundle);
      return this.refresh(bundle);
    }
    await this.ensureAccountVerified(bundle);
    this.scheduleRefresh(bundle);
    return bundle;
  }

  private async load(): Promise<GitHubOAuthBundle> {
    const bundle = await this.store.load();
    this.assertExpectedAccount(bundle);
    if (Date.parse(bundle.refreshTokenExpiresAt) <= this.now()) {
      throw new GitHubCredentialError("refresh_token_expired", "GitHub OAuth refresh token has expired.");
    }
    this.cache(bundle);
    this.warnForRefreshExpiry(bundle);
    this.scheduleRefresh(bundle);
    return bundle;
  }

  private async refreshIfNeeded(bundle: GitHubOAuthBundle): Promise<GitHubOAuthBundle> {
    if (Date.parse(bundle.accessTokenExpiresAt) - this.now() <= this.refreshWindow) {
      return this.refresh(bundle);
    }
    await this.ensureAccountVerified(bundle);
    this.scheduleRefresh(bundle);
    return bundle;
  }

  private refresh(bundle: GitHubOAuthBundle): Promise<GitHubOAuthBundle> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh(bundle)
      .catch(error => {
        this.lastErrorCode = publicErrorCode(error);
        this.logger.error({
          category: "copilot_credential_refresh_failed",
          errorCode: this.lastErrorCode,
        });
        if (this.cached?.generationId !== bundle.generationId) this.scheduleVerificationRetry(error);
        else this.scheduleRefreshRetry();
        throw error;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  private async performRefresh(candidate: GitHubOAuthBundle): Promise<GitHubOAuthBundle> {
    const latest = await this.store.load().catch(() => candidate);
    const current = Date.parse(latest.updatedAt) > Date.parse(candidate.updatedAt) ? latest : candidate;
    this.assertExpectedAccount(current);
    if (current.generationId !== candidate.generationId &&
        Date.parse(current.accessTokenExpiresAt) - this.now() > this.refreshWindow) {
      this.cache(current);
      await this.ensureAccountVerified(current);
      this.scheduleRefresh(current);
      return current;
    }
    if (Date.parse(current.refreshTokenExpiresAt) <= this.now()) {
      throw new GitHubCredentialError("refresh_token_expired", "GitHub OAuth refresh token has expired.");
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    });
    let response: Response;
    try {
      response = await fetchWithTimeout(this.request, "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }, 30_000);
    } catch (error) {
      throw new GitHubCredentialError(publicErrorCode(error), "GitHub OAuth refresh request failed.");
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof payload.error === "string") {
      const code = typeof payload.error === "string" && /^[a-z_]+$/.test(payload.error) ? payload.error : `http_${response.status}`;
      throw new GitHubCredentialError(`refresh_${code}`, "GitHub rejected the OAuth refresh request.");
    }
    const accessToken = requiredString(payload.access_token, "access_token");
    const refreshToken = requiredString(payload.refresh_token, "refresh_token");
    const accessLifetime = Number(payload.expires_in);
    const refreshLifetime = Number(payload.refresh_token_expires_in);
    if (!accessToken.startsWith("ghu_") || !refreshToken.startsWith("ghr_") ||
        !Number.isInteger(accessLifetime) || accessLifetime <= minimumProviderLifetimeSeconds ||
        !Number.isInteger(refreshLifetime) || refreshLifetime <= accessLifetime) {
      throw new GitHubCredentialError("refresh_response_invalid", "GitHub OAuth refresh response is incomplete.");
    }
    const now = this.now();
    const next: GitHubOAuthBundle = {
      version: 1,
      generationId: randomUUID(),
      accountId: this.expectedAccountId,
      accessToken,
      accessTokenExpiresAt: new Date(now + accessLifetime * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: new Date(now + refreshLifetime * 1000).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    // GitHub consumes the old refresh token when it returns this pair. Retain the
    // new generation before any further network request so a transient /user
    // failure cannot make the credential unrecoverable.
    this.cache(next);
    this.lastRefreshAt = new Date(now).toISOString();
    this.scheduleRefresh(next);
    try {
      await this.persist(next);
      this.pendingPersistence = undefined;
    } catch (error) {
      this.pendingPersistence = next;
      this.schedulePersistenceRetry();
      this.logger.error({
        category: "copilot_credential_persistence_pending",
        errorCode: publicErrorCode(error),
      });
    }
    await this.ensureAccountVerified(next);
    this.lastErrorCode = undefined;
    this.warnForRefreshExpiry(next);
    this.logger.info({
      category: "copilot_credential_refreshed",
      accessTokenExpiresAt: next.accessTokenExpiresAt,
      refreshTokenExpiresAt: next.refreshTokenExpiresAt,
      durable: !this.pendingPersistence,
    });
    return next;
  }

  private async verifyAccount(accessToken: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.request, "https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "NewsScout-Copilot-Credential-Rotation",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      }, 30_000);
    } catch (error) {
      throw new GitHubCredentialError(publicErrorCode(error), "GitHub account verification request failed.");
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !Number.isSafeInteger(payload.id)) {
      throw new GitHubCredentialError(`account_http_${response.status}`, "GitHub account verification failed.");
    }
    return String(payload.id);
  }

  async verifyPersistence(bundle = this.cached): Promise<void> {
    let current = bundle ?? await this.load();
    await this.ensureAccountVerified(current);
    if (this.pendingPersistence?.generationId === current.generationId) {
      await this.persist(current);
      this.pendingPersistence = undefined;
      this.persistenceVerificationPending = false;
      return;
    }
    if (!this.store.verifyWrite) {
      await this.persist(current);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const latest = await this.store.load();
      this.assertExpectedAccount(latest);
      if (latest.generationId !== current.generationId) {
        current = latest;
        this.cache(current);
        await this.ensureAccountVerified(current);
      }
      await this.store.verifyWrite(current);
      const confirmed = await this.store.load();
      this.assertExpectedAccount(confirmed);
      if (confirmed.generationId === current.generationId) {
        this.persistenceVerifiedGenerationId = current.generationId;
        this.persistenceVerificationPending = false;
        return;
      }
      current = confirmed;
      this.cache(current);
      await this.ensureAccountVerified(current);
    }
    throw new GitHubCredentialError("bundle_write_conflict", "The current OAuth bundle changed during verification.");
  }

  private async ensureAccountVerified(bundle: GitHubOAuthBundle): Promise<void> {
    this.assertExpectedAccount(bundle);
    if (this.verifiedGenerationId === bundle.generationId) return;
    if (this.verificationPromise?.generationId === bundle.generationId) {
      return this.verificationPromise.promise;
    }
    const promise = this.verifyAccount(bundle.accessToken)
      .then(accountId => {
        if (accountId !== this.expectedAccountId) {
          throw new GitHubCredentialError("account_changed", "GitHub OAuth credential belongs to a different account.");
        }
        this.verifiedGenerationId = bundle.generationId;
        this.lastErrorCode = undefined;
      })
      .catch(error => {
        this.lastErrorCode = publicErrorCode(error);
        this.scheduleVerificationRetry(error);
        throw error;
      })
      .finally(() => {
        if (this.verificationPromise?.generationId === bundle.generationId) {
          this.verificationPromise = undefined;
        }
      });
    this.verificationPromise = { generationId: bundle.generationId, promise };
    return promise;
  }

  private assertExpectedAccount(bundle: GitHubOAuthBundle): void {
    if (bundle.accountId !== this.expectedAccountId) {
      throw new GitHubCredentialError("account_changed", "GitHub OAuth bundle does not match the configured account.");
    }
  }

  private cache(bundle: GitHubOAuthBundle): void {
    if (this.cached?.generationId !== bundle.generationId) {
      this.verifiedGenerationId = undefined;
      this.persistenceVerifiedGenerationId = undefined;
    }
    this.cached = bundle;
  }

  private async persist(bundle: GitHubOAuthBundle): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.store.save(bundle);
        const saved = await this.store.load();
        this.assertExpectedAccount(saved);
        if (saved.generationId !== bundle.generationId) {
          throw new GitHubCredentialError("bundle_write_conflict", "A different OAuth bundle version became current.");
        }
        this.persistenceVerifiedGenerationId = bundle.generationId;
        if (this.cached?.generationId === bundle.generationId) {
          this.persistenceVerificationPending = false;
          if (this.persistenceVerificationTimer) clearTimeout(this.persistenceVerificationTimer);
          this.persistenceVerificationTimer = undefined;
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private scheduleRefresh(bundle: GitHubOAuthBundle): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(1_000, Date.parse(bundle.accessTokenExpiresAt) - this.now() - this.refreshWindow);
    this.refreshTimer = setTimeout(() => {
      void this.acquire("refresh").catch(() => {});
    }, delay);
    this.refreshTimer.unref();
  }

  private scheduleRefreshRetry(): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.acquire("refresh").catch(() => {});
    }, Math.min(this.persistenceRetry * 10, 5 * 60 * 1000));
    this.refreshTimer.unref();
  }

  private scheduleVerificationRetry(error: unknown): void {
    if (this.stopped || (error instanceof GitHubCredentialError && error.code === "account_changed")) return;
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.verificationTimer = setTimeout(() => {
      const current = this.cached;
      if (!current) return;
      void this.ensureAccountVerified(current).then(async () => {
        this.logger.info({ category: "copilot_credential_account_verification_restored" });
        if (!this.pendingPersistence &&
            this.persistenceVerifiedGenerationId !== current.generationId) {
          try {
            await this.verifyPersistence(current);
          } catch (persistenceError) {
            this.persistenceVerificationPending = true;
            this.lastErrorCode = publicErrorCode(persistenceError);
            this.schedulePersistenceVerificationRetry();
            this.logger.error({
              category: "copilot_credential_persistence_verification_pending",
              errorCode: this.lastErrorCode,
            });
          }
        }
      }).catch(retryError => {
        this.logger.error({
          category: "copilot_credential_account_verification_failed",
          errorCode: publicErrorCode(retryError),
        });
        this.scheduleVerificationRetry(retryError);
      });
    }, Math.min(this.persistenceRetry * 10, 5 * 60 * 1000));
    this.verificationTimer.unref();
  }

  private schedulePersistenceRetry(): void {
    if (this.stopped || !this.pendingPersistence) return;
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = setTimeout(() => {
      const pending = this.pendingPersistence;
      if (!pending) return;
      void this.persist(pending).then(() => {
        if (this.pendingPersistence?.generationId === pending.generationId) this.pendingPersistence = undefined;
        this.lastErrorCode = undefined;
        this.logger.info({ category: "copilot_credential_persistence_restored" });
      }).catch(error => {
        this.logger.error({
          category: "copilot_credential_persistence_failed",
          errorCode: publicErrorCode(error),
        });
        this.schedulePersistenceRetry();
      });
    }, this.persistenceRetry);
    this.persistenceTimer.unref();
  }

  private schedulePersistenceVerificationRetry(): void {
    if (this.stopped || !this.persistenceVerificationPending) return;
    if (this.persistenceVerificationTimer) clearTimeout(this.persistenceVerificationTimer);
    this.persistenceVerificationTimer = setTimeout(() => {
      void this.verifyPersistence().then(() => {
        this.persistenceVerificationPending = false;
        this.lastErrorCode = undefined;
        this.logger.info({ category: "copilot_credential_persistence_verification_restored" });
      }).catch(error => {
        this.lastErrorCode = publicErrorCode(error);
        this.logger.error({
          category: "copilot_credential_persistence_verification_failed",
          errorCode: this.lastErrorCode,
        });
        this.schedulePersistenceVerificationRetry();
      });
    }, this.persistenceRetry);
    this.persistenceVerificationTimer.unref();
  }

  private warnForRefreshExpiry(bundle: GitHubOAuthBundle): void {
    if (Date.parse(bundle.refreshTokenExpiresAt) - this.now() <= refreshTokenWarningMs) {
      this.logger.warn({
        category: "copilot_refresh_token_near_expiry",
        refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
      });
    }
  }
}

export function createAzureGitHubAppCredentialManager(environment: NodeJS.ProcessEnv = process.env):
GitHubAppCredentialManager | undefined {
  const mode = environment.SCOUTNEWS_COPILOT_AUTH_MODE?.trim();
  const clientId = environment.SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID?.trim();
  const accountId = environment.SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID?.trim();
  const secretUrl = environment.SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL?.trim();
  if (!mode || mode === "disabled") {
    if (clientId || accountId || secretUrl) {
      throw new GitHubCredentialError(
        "configuration_invalid",
        "Managed Copilot credential settings require SCOUTNEWS_COPILOT_AUTH_MODE=github-app.",
      );
    }
    return undefined;
  }
  if (mode !== "github-app") {
    throw new GitHubCredentialError(
      "configuration_invalid",
      "SCOUTNEWS_COPILOT_AUTH_MODE must be github-app or disabled.",
    );
  }
  if (!clientId || !accountId || !secretUrl) {
    throw new GitHubCredentialError(
      "configuration_invalid",
      "SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID, SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID, and SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL must be set together.",
    );
  }
  const store = new AzureOAuthBundleStore(secretUrl, environment.AZURE_CLIENT_ID ?? "");
  return new GitHubAppCredentialManager({ clientId, expectedAccountId: accountId, store });
}
