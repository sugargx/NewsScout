targetScope = 'resourceGroup'

@description('Immutable image digest or unique build tag in the private registry.')
param image string
param location string = resourceGroup().location
param appName string = 'newsscout'
param environmentName string = 'cae-newsscout-preview'
param environmentDomain string
param identityName string = 'id-newsscout-preview'
param identityClientId string
param registryHost string
param vaultName string
param vaultUri string
param exportStorageUrl string
param loginClientId string
param customerAuthEnabled bool = false
@description('EasyAuth alias for the customer External ID OpenID Connect provider.')
param customerAuthProviderName string = 'newsscout-account'
param customerAuthClientId string = ''
@description('Exact issuer claim accepted from the customer External ID provider.')
param customerAuthIssuer string = ''
@description('OpenID Connect discovery endpoint for the customer External ID provider.')
param customerAuthWellKnownConfiguration string = ''
param customerAuthClientSecretName string = 'customer-auth-client-secret'
@allowed([
  'disabled'
  'github-app'
])
param copilotAuthMode string = 'disabled'
@description('Public client ID of the GitHub App used for device-flow user authorization.')
param copilotGitHubClientId string = ''
@description('Immutable numeric GitHub account ID authorized for the managed Copilot credential.')
param copilotGitHubAccountId string = ''
param copilotOAuthBundleSecretName string = 'copilot-github-oauth-bundle'
param releaseId string
@description('Open ingress only after the initial deployment has enabled and verified EasyAuth.')
param openToUsers bool = false

resource environment 'Microsoft.App/managedEnvironments@2026-01-01' existing = {
  name: environmentName
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityName
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}
resource copilotOAuthBundle 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: copilotOAuthBundleSecretName
}

var origin = 'https://${appName}.${environmentDomain}'
var githubAppEnabled = copilotAuthMode == 'github-app'
var secretNames = concat([
  'database-url'
  'csrf-secret'
  'proxy-token'
  'gateway-shared-secret'
  'applicationinsights-connection-string'
  'entra-client-secret'
], customerAuthEnabled ? [customerAuthClientSecretName] : [])
var credentials = secretNames
var customerIdentityProvider = customerAuthEnabled ? {
  customOpenIdConnectProviders: {
    '${customerAuthProviderName}': {
      enabled: true
      registration: {
        clientId: customerAuthClientId
        clientCredential: {
          method: 'ClientSecretPost'
          clientSecretSettingName: customerAuthClientSecretName
        }
        openIdConnectConfiguration: {
          wellKnownOpenIdConfiguration: customerAuthWellKnownConfiguration
        }
      }
      login: {
        nameClaimType: 'name'
        scopes: [
          'openid'
          'profile'
          'email'
        ]
      }
    }
  }
} : {}

resource appCopilotOAuthBundleOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (githubAppEnabled) {
  name: guid(copilotOAuthBundle.id, identity.id, 'NewsScout Copilot OAuth bundle writer')
  scope: copilotOAuthBundle
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource app 'Microsoft.App/containerApps@2026-01-01' = {
  name: appName
  location: location
  dependsOn: githubAppEnabled ? [
    appCopilotOAuthBundleOfficer
  ] : []
  tags: {
    product: 'NewsScout'
    environment: 'customer-preview'
    release: releaseId
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
        // Auth configuration is a child resource created after the app. Block public traffic during bootstrap.
        ipSecurityRestrictions: openToUsers ? [] : [{
          name: 'authentication-bootstrap'
          description: 'No public traffic before authentication is configured.'
          action: 'Allow'
          ipAddressRange: '192.0.2.1/32'
        }]
      }
      registries: [{ server: registryHost, identity: identity.id }]
      secrets: [for name in credentials: {
        name: name
        keyVaultUrl: '${vaultUri}secrets/${name}'
        identity: identity.id
      }]
    }
    template: {
      // One always-on process owns the existing scheduler; horizontal scaling needs a separate worker design.
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [{
        name: 'newsscout'
        image: image
        resources: { cpu: 1, memory: '2Gi' }
        env: concat([
          { name: 'SCOUTNEWS_AUTH_MODE', value: 'azure' }
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'SCOUTNEWS_CSRF_SECRET', secretRef: 'csrf-secret' }
          { name: 'SCOUTNEWS_PROXY_TOKEN', secretRef: 'proxy-token' }
          { name: 'COPILOT_GATEWAY_SHARED_SECRET', secretRef: 'gateway-shared-secret' }
          { name: 'SCOUTNEWS_COPILOT_AUTH_MODE', value: copilotAuthMode }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'applicationinsights-connection-string' }
          { name: 'WEB_ORIGIN', value: origin }
          { name: 'AZURE_CLIENT_ID', value: identityClientId }
          { name: 'SCOUTNEWS_EXPORT_STORAGE_URL', value: exportStorageUrl }
          { name: 'SCOUTNEWS_RELEASE_ID', value: releaseId }
          { name: 'SCOUTNEWS_DEMO_MODE', value: 'false' }
          { name: 'SCOUTNEWS_PUBLIC_ONLY', value: 'false' }
          { name: 'SCOUTNEWS_BROWSER_ARTICLE_HOSTS', value: '' }
          { name: 'RUST_LOG', value: 'scoutnews_api=info,tower_http=warn' }
        ], githubAppEnabled ? [
          { name: 'SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID', value: copilotGitHubClientId }
          { name: 'SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID', value: copilotGitHubAccountId }
          { name: 'SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL', value: '${vaultUri}secrets/${copilotOAuthBundleSecretName}' }
        ] : [], customerAuthEnabled ? [
          { name: 'SCOUTNEWS_CUSTOM_OIDC_PROVIDER_NAME', value: customerAuthProviderName }
          { name: 'SCOUTNEWS_CUSTOM_OIDC_ISSUER', value: customerAuthIssuer }
        ] : [])
        probes: [
          { type: 'Startup', httpGet: { path: '/health', port: 3000 }, periodSeconds: 5, timeoutSeconds: 6, failureThreshold: 36 }
          { type: 'Readiness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 10, timeoutSeconds: 6, failureThreshold: 3 }
          { type: 'Liveness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 30, timeoutSeconds: 6, failureThreshold: 3 }
        ]
      }]
    }
  }
}

resource auth 'Microsoft.App/containerApps/authConfigs@2026-01-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: { enabled: true }
    // Static sign-in/privacy and explicitly published shares are public; the API authenticates every private route.
    globalValidation: { unauthenticatedClientAction: 'AllowAnonymous' }
    // EasyAuth also uses this exact origin to validate cookie-authenticated browser POSTs.
    login: { allowedExternalRedirectUrls: [origin] }
    httpSettings: { requireHttps: true }
    identityProviders: union({
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: loginClientId
          clientSecretSettingName: 'entra-client-secret'
          openIdIssuer: 'https://login.microsoftonline.com/common/v2.0'
        }
        login: { loginParameters: ['scope=openid profile email'] }
        validation: { allowedAudiences: [loginClientId] }
      }
    }, customerIdentityProvider)
  }
}

output siteUrl string = origin
output appId string = app.id
output authId string = auth.id
