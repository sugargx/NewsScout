targetScope = 'subscription'

@description('A new, dedicated group; never use a pre-existing unrelated resource group.')
param resourceGroupName string = 'rg-newsscout-preview'

param location string = 'eastasia'

resource preview 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: {
    product: 'NewsScout'
    environment: 'customer-preview'
    managedBy: 'Bicep'
  }
}

output resourceGroupId string = preview.id
