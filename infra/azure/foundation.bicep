targetScope = 'resourceGroup'

param location string = resourceGroup().location
param resourceToken string = take(uniqueString(resourceGroup().id), 8)
param identityName string = 'id-newsscout-preview'
param keyVaultName string = 'kv-nsc-preview-${resourceToken}'
param virtualNetworkName string = 'vnet-newsscout-preview'
param containerEnvironmentName string = 'cae-newsscout-preview'
param registryName string = 'acrnewsscout${resourceToken}'
param postgresServerName string = 'psql-newsscout-preview-${resourceToken}'
param storageAccountName string = 'stnscpreview${resourceToken}'
param logAnalyticsName string = 'law-newsscout-preview'
param applicationInsightsName string = 'appi-newsscout-preview'
param privateDnsZoneName string = 'newsscout-preview.postgres.database.azure.com'
param postgresAdministratorLogin string = 'scoutadmin'
param databaseName string = 'scoutnews'
param postgresAllowedExtensions array = [
  'PG_TRGM'
]
param virtualNetworkPrefix string = '10.42.0.0/16'
param containerSubnetPrefix string = '10.42.0.0/23'
param postgresSubnetPrefix string = '10.42.2.0/27'

@description('False for an existing server: omit password properties entirely to avoid resetting credentials.')
param initializePostgresPassword bool = true

@secure()
param postgresAdministratorPassword string = ''

@description('Log-ingestion safety valve only; not a hard budget or a compute-spending cap.')
@allowed([
  '0.1'
  '0.25'
  '0.5'
  '1'
])
param logDailyQuotaGb string = '0.25'

var tags = {
  product: 'NewsScout'
  environment: 'customer-preview'
  managedBy: 'Bicep'
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityName
}

resource vault 'Microsoft.KeyVault/vaults@2026-05-15' existing = {
  name: keyVaultName
}

resource databaseNsg 'Microsoft.Network/networkSecurityGroups@2026-03-01' = {
  name: 'nsg-${postgresServerName}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowApplicationPostgres'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: postgresSubnetPrefix
          destinationPortRange: '5432'
        }
      }
      {
        name: 'AllowPostgresIntraSubnet'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: postgresSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: postgresSubnetPrefix
          destinationPortRange: '5432'
        }
      }
      {
        name: 'DenyOtherInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2026-03-01' = {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [virtualNetworkPrefix]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: containerSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: postgresSubnetPrefix
          networkSecurityGroup: {
            id: databaseNsg.id
          }
          delegations: [
            {
              name: 'postgres-flexible'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
              locations: [location]
            }
          ]
        }
      }
    ]
  }
}

resource privateDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneName
  location: 'global'
  tags: tags
}

resource privateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDns
  name: '${virtualNetworkName}-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '17'
    createMode: 'Default'
    ...((initializePostgresPassword) ? {
      administratorLogin: postgresAdministratorLogin
      administratorLoginPassword: postgresAdministratorPassword
    } : {})
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
      tier: 'P4'
      type: 'Premium_LRS'
    }
    network: {
      delegatedSubnetResourceId: '${vnet.id}/subnets/postgres'
      privateDnsZoneArmResourceId: privateDns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [
    privateDnsLink
  ]
}

resource applicationDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource requireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: {
    source: 'user-override'
    value: 'on'
  }
}

module postgresExtensions './postgres-extensions.bicep' = {
  name: 'postgres-extensions'
  params: {
    postgresServerName: postgres.name
    allowedExtensions: postgresAllowedExtensions
  }
  dependsOn: [
    postgres
  ]
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
    }
  }
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource exportsStorage 'Microsoft.Storage/storageAccounts@2026-06-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2026-06-01' = {
  parent: exportsStorage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: {
      enabled: false
    }
    containerDeleteRetentionPolicy: {
      enabled: false
    }
  }
}

resource exports 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-06-01' = {
  parent: blobService
  name: 'exports'
  properties: {
    publicAccess: 'None'
  }
}

// Exports are ephemeral, per-user generated artifacts. Never put permanent user data here.
resource exportLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2026-06-01' = {
  parent: exportsStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-generated-exports-after-seven-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['exports/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource appExportsContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(exports.id, appIdentity.id, 'Storage Blob Data Contributor')
  scope: exports
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json(logDailyQuotaGb)
    }
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    DisableLocalAuth: true
    DisableIpMasking: false
    RetentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appMetricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsights.id, appIdentity.id, 'Monitoring Metrics Publisher')
  scope: applicationInsights
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// No container app or image is created here: authenticated runtime deployment is a separate gate.
resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: containerEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    vnetConfiguration: {
      infrastructureSubnetId: '${vnet.id}/subnets/container-apps'
      internal: false
    }
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// The latest stable diagnostics API supports explicit categories without preview category groups.
resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2016-09-01' = {
  name: 'service'
  scope: environment
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

output foundation object = {
  subscriptionId: subscription().subscriptionId
  tenantId: subscription().tenantId
  resourceGroupId: resourceGroup().id
  location: location
  identity: {
    id: appIdentity.id
    clientId: appIdentity.properties.clientId
    principalId: appIdentity.properties.principalId
  }
  keyVault: {
    id: vault.id
    name: vault.name
    uri: vault.properties.vaultUri
    secretNames: [
      'postgres-admin-password'
      'database-url'
      'applicationinsights-connection-string'
    ]
  }
  containerEnvironment: {
    id: environment.id
    name: environment.name
    defaultDomain: environment.properties.defaultDomain
  }
  registry: {
    id: registry.id
    name: registry.name
    loginServer: registry.properties.loginServer
  }
  postgres: {
    id: postgres.id
    name: postgres.name
    fqdn: postgres.properties.fullyQualifiedDomainName
    database: applicationDatabase.name
    administratorLogin: postgresAdministratorLogin
    privateDnsZoneId: privateDns.id
    allowedExtensions: postgresAllowedExtensions
  }
  storage: {
    id: exportsStorage.id
    name: exportsStorage.name
    blobEndpoint: exportsStorage.properties.primaryEndpoints.blob
    container: exports.name
    containerId: exports.id
  }
  observability: {
    logAnalyticsId: workspace.id
    applicationInsightsId: applicationInsights.id
    logDailyQuotaGb: logDailyQuotaGb
    retentionDays: 30
  }
  network: {
    id: vnet.id
    containerSubnetId: '${vnet.id}/subnets/container-apps'
    postgresSubnetId: '${vnet.id}/subnets/postgres'
  }
  runtimeRequirements: {
    deployed: false
    ingressPort: 3000
    minReplicas: 1
    maxReplicas: 1
    cpu: 1
    memory: '2Gi'
    workloadProfile: 'Consumption'
    databaseTlsMode: 'verify-full'
  }
}
