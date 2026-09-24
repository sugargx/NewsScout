targetScope = 'resourceGroup'

param postgresServerName string

@description('Approved extension names. The runner preserves existing entries and adds PG_TRGM.')
param allowedExtensions array = [
  'PG_TRGM'
]

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = {
  name: postgresServerName
}

// Allowlisting enables the application migration to CREATE EXTENSION; it does not execute SQL.
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    source: 'user-override'
    value: join(allowedExtensions, ',')
  }
}

output configurationId string = extensions.id
output allowedExtensions array = allowedExtensions
