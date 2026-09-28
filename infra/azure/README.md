# NewsScout invited-preview foundation

This provisions infrastructure only. It does **not** deploy a container app, build an
image, change identity app registrations, or expose an application API.
Use it only for the authorized personal-subscription development/testing preview.

## Run from the repository root (PowerShell 7)

```powershell
# Read-only preflight, Bicep build and what-if.
.\scripts\azure-infra.ps1

# Every stage runs what-if before its corresponding deployment.
.\scripts\azure-infra.ps1 -Provision

# Independently inspect the deployed controls; no secrets are printed.
.\scripts\azure-infra-verify.ps1

# Narrow update for an existing foundation: no credentials, roles or other resources are changed.
.\scripts\azure-infra-postgres-extensions.ps1 -Provision
```

The authorized target (subscription, tenant, deployer object ID and expected
signed-in account) is read from the git-ignored `tmp\azure-preview-20260920\target.json`
unless passed explicitly with `-SubscriptionId`, `-TenantId`, `-DeployerPrincipalId`
and `-ExpectedAccount`; a missing value stops the run. The defaults create the
new resource group `rg-newsscout-preview` in `eastasia`. The scripts verify the
signed-in account and token tenant/object ID, explicitly scope every ARM command,
and never change the global Azure CLI default. No billing offer, spending limit,
quota increase, existing unrelated resource, or policy assignment is changed.
Azure also creates the Container Apps service-managed `ME_...` infrastructure
group and may automatically create `NetworkWatcherRG` when provisioning a VNet.
These are platform side effects, not application deployments; the scripts do not
change subscription-wide Network Watcher settings or delete shared resources.

The location, resource names, network prefixes, and deployer principal are Bicep
parameters. The runner intentionally keeps the preview's conservative size fixed:
PostgreSQL 17, Burstable B1ms, 32 GiB/P4, seven-day local backups, no HA, no
automatic storage growth; ACR Basic; StorageV2 Standard_LRS; a Consumption-only
Container Apps environment. Capability/usage checks reject unavailable low-cost
capacity rather than selecting a larger tier. Advertised SKU support is not a
capacity reservation; deployment errors remain authoritative.

## Deployment and credentials

1. `resource-group.bicep` creates the tagged, isolated group.
2. `bootstrap.bicep` creates the user-assigned identity, RBAC-only Key Vault,
   purge protection, and the vault-scoped read assignment. When GitHub App mode is
   enabled, `cloud-app.bicep` adds Secrets Officer only at the
   `copilot-github-oauth-bundle` secret scope so the runtime can persist rotations.
3. The runner creates a cryptographically random administrator password directly
   in Key Vault. Deployment parameters contain a **Key Vault reference**, never a
   plaintext password. Existing secrets are reused. When a PostgreSQL server
   exists, the template omits administrator/password properties entirely; a
   missing stored password is an error, not permission to reset credentials.
4. `foundation.bicep` creates private networking, PostgreSQL, registry, export
   storage, workspace-based monitoring, and the empty Container Apps environment.
5. The runner saves `database-url` and `applicationinsights-connection-string`
   directly to Key Vault and performs read-only verification.

An existing `database-url` is never overwritten, so a later switch to a
restricted database login cannot silently revert to the bootstrap administrator.
The verifier still requires the intended server/database and `verify-full` TLS.

The other secret is `postgres-admin-password`. Secret values and tokens stay in
process memory/Key Vault, never in command-line parameters, output JSON, or source
files. Operational artifacts are git-ignored under
`tmp\azure-preview-20260920`; `foundation.json` contains only resource IDs, names,
endpoints, identity IDs, and runtime requirements. `verification.json` records
checks and explicitly distinguishes configured private connectivity from a real
in-VNet database connection test.

### PostgreSQL bootstrap and RLS

`postgres-extensions.bicep`, included by the foundation, allowlists `PG_TRGM`
before application startup. The runner preserves other existing extension
allowlist entries. The configuration-only command above also builds and runs
what-if before applying exactly `azure.extensions`; it performs no SQL and
does not restart the server. The application migration must still execute
`CREATE EXTENSION pg_trgm`.

Migration `0025` creates request role `scoutnews_reader` with `NOLOGIN`,
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and `NOBYPASSRLS`.
The migration connection needs `CREATEROLE` (as provided by the Azure server
administrator), or the role must already exist with those attributes and the
required membership for the migration/runtime database owner. Do not grant
superuser or `BYPASSRLS`. PostgreSQL 17 role creation does not automatically give
a nonsuperuser creator `SET ROLE` permission: explicitly grant the required
membership. Each request query must use `SET LOCAL ROLE` and transaction-local
actor state, not shared mutable pool/session state. Verify those permissions and
RLS isolation from an in-VNet connection before rollout.

## Runtime integration gate

Before a separate runtime deployment:

- `Dockerfile.azure` packages the compiled TypeScript workspace
  `@scoutnews/cloud-host`; its entry is
  `/app/services/cloud-host/dist/server.js`, not a standalone `.mjs` file.
  Root `npm run build` builds web, gateway, and cloud host; the targeted host
  build is `npm run build -w @scoutnews/cloud-host`. The runtime also includes
  `/app/bin/scoutnews-api`, `/app/apps/web/dist`, and
  `/app/services/copilot-gateway/dist/index.js`.
  Build dependencies stay in separate stages; the final image runs as the
  non-root `node` user with a signal-forwarding init, CA trust, and OpenSSL.
  The allowlisted `.dockerignore` excludes local credentials, `tmp`, caches,
  dependencies, and existing build outputs from remote-build upload.
  No image build, push, or app deployment is performed by the foundation script.
- Use the output environment and identity, `Consumption`, **min/max replicas 1**,
  **1 CPU / 2 GiB**, and external HTTPS ingress targeting **3000 only**. Internal
  Axum `127.0.0.1:8080` and optional gateway `127.0.0.1:8787` are never ingress
  ports. A running background scheduler is incompatible with scale-to-zero.
- Configure both supported EasyAuth providers before opening self-service access:
  `aad` for Microsoft accounts and the exact External ID OIDC alias/issuer for
  customer email accounts. The foundation provides no anonymous private API.
  The Rust boundary accepts only provider-verified stable subjects, never an
  email/display name supplied by the browser. Unknown providers, issuer drift,
  malformed principals, missing proxy trust, and anonymous private requests fail
  closed. Public health/share routes remain explicit exceptions. External ID does
  not support phone numbers as first-factor sign-in; SMS is an optional paid MFA
  add-on and must not be represented as phone-account registration.
- Pull from the output ACR using the assigned identity (AcrPull). Registry admin
  and anonymous pull are disabled. ACR supports a later remote Linux build; no
  Docker image is required for foundation provisioning.
- Set `AZURE_CLIENT_ID` to `identity.clientId`. Resolve `DATABASE_URL` from the
  `database-url` Key Vault secret; it requires `sslmode=verify-full`. Include
  a current CA trust bundle and verify PostgreSQL DNS, certificate/hostname, and
  an actual query from the in-VNet runtime before accepting the release.
- The database has a delegated subnet, VNet-linked private DNS, an inbound NSG
  restricted to the app/database subnets on 5432, no public endpoint, no public
  firewall rules, and enforced TLS. Entra database authentication is deliberately
  not claimed: the current runtime has no implemented token-refresh integration.
  The stored bootstrap database URL uses the administrator for migrations; add
  a restricted runtime database role via a private connection before wider use.
- Set `SCOUTNEWS_EXPORT_STORAGE_URL` to `storage.blobEndpoint`; use container
  `exports` and managed-identity OAuth for
  authenticated, own-data exports. The app identity's Blob Data Contributor role
  is scoped to that container. Prefix blob names with an opaque authenticated user
  identifier; authorize ownership on reads/downloads and stream data through the
  authenticated server. Never expose account keys, public blob ACLs, or key SAS.
  Lifecycle deletes generated exports after seven days; asynchronous lifecycle
  processing is not a precise TTL, so the app must enforce download expiry too.
- Resolve `APPLICATIONINSIGHTS_CONNECTION_STRING` from its Key Vault secret.
  Both Application Insights and the workspace disable local authentication:
  configure the Azure Monitor SDK with `ManagedIdentityCredential` for the
  assigned client ID. The app has resource-scoped Monitoring Metrics Publisher.
  Keep telemetry manual and limited to allowlisted route templates; do not enable
  automatic request/dependency capture. Never log request bodies, credentials,
  auth headers, or sensitive URL queries.
  Application usage analytics must remain opt-in.
- Console/system logs route through Azure Monitor diagnostic settings without
  workspace shared keys. HTTP request-log collection is not enabled here.
- The optional source-access browser helper is packaged, but a browser binary is
  deliberately not installed or enabled. Its current default channel is
  `msedge`; do not enable `SCOUTNEWS_BROWSER_ARTICLE_HOSTS` until that optional
  feature has a compatible Linux browser and a separately tested memory budget.
  Container Apps must have explicit startup/readiness/liveness probes on
  `/health`, port 3000; do not assume Docker's health check configures them.

### Required runtime environment

| Variable | Source / constraint |
| --- | --- |
| `SCOUTNEWS_AUTH_MODE` | `azure` (also the image default; do not override with local/anonymous mode) |
| `DATABASE_URL` | Key Vault `database-url`; TLS `verify-full` |
| `SCOUTNEWS_CSRF_SECRET` | Parent-owned application secret, at least 32 characters, resolved from Key Vault |
| `SCOUTNEWS_PROXY_TOKEN` | Parent-owned application secret, at least 32 characters |
| `COPILOT_GATEWAY_SHARED_SECRET` | Parent-owned application secret, resolved from Key Vault |
| `SCOUTNEWS_COPILOT_AUTH_MODE` | Explicitly `disabled` or `github-app`; there is no PAT fallback |
| `SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID` | Public GitHub App client ID; required only in `github-app` mode |
| `SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID` | Independently pinned numeric GitHub account ID; required only in `github-app` mode |
| `SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL` | Unversioned Key Vault URL for `copilot-github-oauth-bundle`; required only in `github-app` mode |
| `WEB_ORIGIN` | Exact `https://<apphost>` origin after the authenticated app hostname is determined |
| `AZURE_CLIENT_ID` | Foundation `identity.clientId`, for the attached user-assigned identity |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Key Vault `applicationinsights-connection-string`; MI exporter credential is also required |
| `SCOUTNEWS_EXPORT_STORAGE_URL` | Foundation `storage.blobEndpoint` |

The foundation intentionally does not generate or rotate parent-owned application
secrets, configure OAuth, or infer a public app hostname. Never pass runtime
credentials through Docker build arguments or copy them into the image.
`AZURE_CLIENT_ID` is the managed identity's client ID, **not** the distinct
Microsoft-login application registration client ID. The latter belongs in the
parent-owned authentication configuration.
Cloud mode must never restore local credentials or import workstation credential
stores. The container build context excludes those local artifacts.
Azure startup must ignore local `.env` files, reject demo/public-only cloud mode,
and require the API bind address `127.0.0.1:8080`.

Azure Copilot uses a GitHub App user credential created through Device Flow by
`scripts\initialize-copilot-github-app.ps1`. The versioned JSON bundle is stored
only in Key Vault; the public client ID and unversioned secret URL are runtime
settings. The Gateway pins the numeric GitHub account ID and rotates both access
and refresh tokens. `COPILOT_GITHUB_TOKEN` is legacy configuration: if it appears
in the cloud process environment, startup fails rather than silently using it.

## Cost and retention boundaries

Log Analytics retention is 30 days with a 0.25 GB/day ingestion cap. The cap is
best-effort ingestion control, **not** a hard Azure budget or compute cost ceiling.
ACR, PostgreSQL, storage, monitoring, managed networking, and the eventual always-on app can incur
charges even when no invited user is active. There are no dedicated ACA workload
profiles, NAT gateways, AKS, Redis, Cosmos DB, or premium private endpoints.
Key Vault and blob service endpoints are public-network reachable but data access
requires Entra/RBAC; blobs are not public and shared-key authentication is disabled.
Key Vault purge protection cannot be bypassed for cleanup.
