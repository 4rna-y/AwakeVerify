@description('A short, globally unique prefix. Use only lowercase letters and numbers.')
@minLength(3)
@maxLength(18)
param namePrefix string

@description('Azure region for all newly-created resources.')
param location string = resourceGroup().location

@description('Set false for the foundation deployment. Set true only after the required public container images have been published.')
param deployWorkloads bool = false

@description('Deploy the independent Next.js SSR Frontend Container App. It defaults to false so existing Backend/Worker non-production load-test deployments remain compatible.')
param deployFrontend bool = false

@description('Public OCI registry host used by the Frontend, Backend, and Worker images.')
param containerImageRegistry string = 'ghcr.io'

@description('Public OCI registry namespace that owns the Frontend, Backend, and Worker repositories.')
param containerImageNamespace string = '4rna-y'

@description('Frontend image repository in the public OCI registry.')
param frontendImageRepository string = 'awaver-frontend'

@description('Backend image repository in the public OCI registry.')
param backendImageRepository string = 'awaver-backend'

@description('Worker image repository in the public OCI registry.')
param workerImageRepository string = 'awaver-worker'

@description('Immutable image tag used only by the legacy non-production deployment scripts. New workflow-driven deployments should pass frontendImage, backendImage, and workerImage as complete immutable references.')
param imageTag string = 'replace-with-immutable-tag'

@description('Complete immutable Frontend OCI image reference produced by the image workflow. The default preserves the existing imageTag convention when deployFrontend is explicitly enabled.')
param frontendImage string = '${containerImageRegistry}/${containerImageNamespace}/${frontendImageRepository}:${imageTag}'

@description('Complete immutable Backend OCI image reference produced by the image workflow. The default preserves the existing non-production imageTag contract.')
param backendImage string = '${containerImageRegistry}/${containerImageNamespace}/${backendImageRepository}:${imageTag}'

@description('Complete immutable Worker OCI image reference produced by the image workflow. The default preserves the existing non-production imageTag contract.')
param workerImage string = '${containerImageRegistry}/${containerImageNamespace}/${workerImageRepository}:${imageTag}'

@minValue(0)
@description('Minimum independent Frontend ACA replicas. Use zero between demos and warm it before scheduled demonstrations.')
param frontendMinReplicas int = 0

@minValue(1)
@description('Maximum independent Frontend ACA replicas.')
param frontendMaxReplicas int = 2

@description('Container Apps CPU cores allocated to each Frontend replica.')
param frontendCpu int = 1

@description('Container Apps memory allocated to each Frontend replica.')
param frontendMemory string = '2Gi'

@minValue(0)
@description('Minimum Backend ACA replicas. Use zero between demos; restore the validated warm profile before a scheduled demo or load test.')
param backendMinInstances int = 1

@minValue(1)
@description('Maximum Backend ACA routing replicas. This value is passed to BACKEND_EXPECTED_INSTANCE_COUNT.')
param backendMaxInstances int = 2

@minValue(1)
@description('HTTP concurrent-request target for the Backend ACA scale rule. Tune from frame ingress and analysis-result measurements; do not derive it from a fixed session count.')
param backendHttpConcurrentRequests int = 20

@minValue(1)
@description('Seconds granted to a Backend ACA replica for graceful shutdown before termination.')
param backendTerminationGracePeriodSeconds int = 60

@description('Container Apps CPU cores allocated to each Backend replica.')
param backendCpu int = 1

@description('Container Apps memory allocated to each Backend replica.')
param backendMemory string = '2Gi'

@minValue(0)
param workerMinReplicas int = 0

@minValue(1)
param workerMaxReplicas int = 3

@minValue(1)
@description('Seconds between KEDA checks of the Worker Service Bus backlog.')
param workerScalingPollingIntervalSeconds int = 30

@minValue(1)
@description('Service Bus active-message target per Worker replica.')
param workerScaleQueueThreshold int = 10

@minValue(1)
param workerSessionConcurrency int = 1

@minValue(1)
param workerShutdownTimeoutSeconds int = 30

@minValue(1)
param workerTerminationGracePeriodSeconds int = 60

@description('Container Apps CPU cores allocated to each Worker replica.')
param workerCpu int = 1

@description('Container Apps memory allocated to each Worker replica.')
param workerMemory string = '2Gi'

@allowed([
  'Standard'
  'Premium'
])
@description('Basic does not support Service Bus sessions and must not be used.')
param serviceBusSkuName string = 'Standard'

@minValue(1)
param serviceBusMaxDeliveryCount int = 10

@description('ISO 8601 Service Bus session/message lock duration.')
param serviceBusLockDuration string = 'PT1M'

@description('ISO 8601 Service Bus duplicate-detection history window. It must cover the maximum HTTP frame retry horizon for a stable (sessionId, sequenceNo) message ID.')
param serviceBusDuplicateDetectionHistoryTimeWindow string = 'PT1H'

@description('Session-enabled frame queue name. Use a new name when immutable queue capabilities, such as duplicate detection, must change.')
param frameQueueName string = 'frame-processing-queue-http-v2'

@description('Globally unique Storage account name for frame and video containers.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@minValue(1)
param frameBlobRetentionDays int = 7

@description('UTC expiry for generated Blob SAS. The default is 14 days after deployment; redeploy the foundation to rotate it.')
param blobSasExpiry string = dateTimeAdd(utcNow(), 'P14D')

param frameContainerName string = 'frames'
param videoContainerName string = 'videos'

@description('Globally unique PostgreSQL Flexible Server name.')
@minLength(3)
@maxLength(63)
param postgresServerName string

param postgresAdministratorLogin string = 'awaveradmin'

@secure()
@description('Administrator password for the temporary PostgreSQL Flexible Server.')
param postgresAdministratorPassword string

param postgresDatabaseName string = 'awaver'

@description('PostgreSQL Flexible Server SKU, for example Standard_B1ms.')
param postgresSkuName string = 'Standard_B1ms'

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresSkuTier string = 'Burstable'

@minValue(32)
param postgresStorageSizeGb int = 32

@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

@description('Globally unique Azure Managed Redis cluster name.')
@minLength(1)
@maxLength(60)
param redisCacheName string

@description('Azure Managed Redis SKU, for example Balanced_B0 for a short-lived non-production environment.')
param managedRedisSkuName string = 'Balanced_B0'

@description('Frontend origin permitted by Backend CORS, including scheme and no trailing slash.')
param frontendOrigin string = 'https://awaver.4rnay.net'

@secure()
@description('Initial administrator ID used only for first-start bootstrap. Pass it together with initialAdminPassword, then redeploy both as empty strings after bootstrap succeeds.')
param initialAdminId string = ''

@secure()
@description('Initial administrator password used only for first-start bootstrap. It is stored as an ACA secret and is never emitted as a deployment output. Pass it together with initialAdminId, then remove both after bootstrap succeeds.')
param initialAdminPassword string = ''

@allowed([
  'None'
  'DnsValidated'
  'Secured'
])
@description('Custom-domain deployment stage. None creates no bindings; DnsValidated adds certificate-free bindings after Cloudflare A/TXT propagation; Secured binds certificates created by managed-certificates.bicep.')
param customDomainBindingStage string = 'None'

@description('Frontend custom hostname bound only to the independent Frontend Container App.')
param frontendHostname string = 'awaver.4rnay.net'

@description('API and SignalR custom hostname bound to the Backend Container App.')
param backendHostname string = 'api.awaver.4rnay.net'

@description('Health-only custom hostname bound to the Worker Container App port 8000.')
param workerHealthHostname string = 'worker.api.awaver.4rnay.net'

@description('Managed certificate resource name for frontendHostname. The certificate is created by managed-certificates.bicep after DNS handoff.')
param frontendManagedCertificateName string = 'awaver-frontend-managed'

@description('Managed certificate resource name for backendHostname. The certificate is created by managed-certificates.bicep after DNS handoff.')
param backendManagedCertificateName string = 'awaver-backend-managed'

@description('Managed certificate resource name for workerHealthHostname. The certificate is created by managed-certificates.bicep after DNS handoff.')
param workerManagedCertificateName string = 'awaver-worker-health-managed'

@description('Microsoft Entra authority for Backend Worker bearer-token validation.')
param workerEntraAuthority string

@description('Microsoft Entra audience/Application ID URI accepted by Backend.')
param workerEntraAudience string

@description('Issuer expected from the Worker managed identity access token.')
param workerEntraValidIssuer string

@description('Worker token scope, normally the Backend Application ID URI followed by /.default.')
param workerBackendTokenScope string

@description('Azure SignalR SKU, for example Free_F1 or Standard_S1.')
param signalrSkuName string = 'Standard_S1'

@minValue(1)
param signalrCapacity int = 1

@minValue(1)
param outboxBatchSize int = 100

@minValue(1)
param outboxPollIntervalMs int = 250

@minValue(1)
param outboxLeaseSeconds int = 30

@minValue(1)
param logAnalyticsRetentionDays int = 30

param tags object = {
  workload: 'awakeverify'
  environment: 'nonproduction'
  purpose: 'distributed-load-test'
}

var serviceBusNamespaceName = '${namePrefix}-servicebus'
var signalrName = '${namePrefix}-signalr'
var frontendAppName = '${namePrefix}-frontend'
var backendAppName = '${namePrefix}-backend'
var containerEnvironmentName = '${namePrefix}-cae'
var workerAppName = '${namePrefix}-worker'
var logAnalyticsName = '${namePrefix}-logs'
var backendApplicationInsightsName = '${namePrefix}-backend-ai'
var backendExpectedInstanceCount = backendMaxInstances
var bootstrapAdminConfigured = !empty(initialAdminId) && !empty(initialAdminPassword)
var customDomainsEnabled = customDomainBindingStage != 'None'
var securedCustomDomainsEnabled = customDomainBindingStage == 'Secured'
var frontendManagedCertificateId = resourceId('Microsoft.App/managedEnvironments/managedCertificates', containerEnvironmentName, frontendManagedCertificateName)
var backendManagedCertificateId = resourceId('Microsoft.App/managedEnvironments/managedCertificates', containerEnvironmentName, backendManagedCertificateName)
var workerManagedCertificateId = resourceId('Microsoft.App/managedEnvironments/managedCertificates', containerEnvironmentName, workerManagedCertificateName)
var frontendCustomDomains = !customDomainsEnabled ? [] : securedCustomDomainsEnabled ? [
  {
    name: frontendHostname
    bindingType: 'SniEnabled'
    certificateId: frontendManagedCertificateId
  }
] : [
  {
    name: frontendHostname
    bindingType: 'Disabled'
  }
]
var backendCustomDomains = !customDomainsEnabled ? [] : securedCustomDomainsEnabled ? [
  {
    name: backendHostname
    bindingType: 'SniEnabled'
    certificateId: backendManagedCertificateId
  }
] : [
  {
    name: backendHostname
    bindingType: 'Disabled'
  }
]
var workerCustomDomains = !customDomainsEnabled ? [] : securedCustomDomainsEnabled ? [
  {
    name: workerHealthHostname
    bindingType: 'SniEnabled'
    certificateId: workerManagedCertificateId
  }
] : [
  {
    name: workerHealthHostname
    bindingType: 'Disabled'
  }
]

var backendBlobSas = storage.listAccountSas('2023-05-01', {
  signedServices: 'b'
  signedResourceTypes: 'sco'
  signedPermission: 'racwdl'
  signedProtocol: 'https'
  signedExpiry: blobSasExpiry
}).accountSasToken
var workerBlobSas = storage.listAccountSas('2023-05-01', {
  signedServices: 'b'
  signedResourceTypes: 'sco'
  signedPermission: 'rl'
  signedProtocol: 'https'
  signedExpiry: blobSasExpiry
}).accountSasToken
var backendBlobConnectionString = 'BlobEndpoint=https://${storage.name}.blob.${environment().suffixes.storage};SharedAccessSignature=${backendBlobSas}'
var workerBlobConnectionString = 'BlobEndpoint=https://${storage.name}.blob.${environment().suffixes.storage};SharedAccessSignature=${workerBlobSas}'
var databaseConnectionString = 'Host=${postgres.name}.postgres.database.azure.com;Port=5432;Database=${postgresDatabaseName};Username=${postgresAdministratorLogin};Password=${postgresAdministratorPassword};Ssl Mode=Require;Trust Server Certificate=false'
var redisConnectionString = '${redis.properties.hostName}:${redisDatabase.properties.port},password=${redisDatabase.listKeys().primaryKey},ssl=True,abortConnect=False'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logAnalyticsRetentionDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource backendApplicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: backendApplicationInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: tags
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Enabled'
    encryption: {
      services: {
        blob: {
          enabled: true
        }
      }
      keySource: 'Microsoft.Storage'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource frameContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: frameContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource videoContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: videoContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource storageLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-expired-frame-blobs'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${frameContainerName}/sessions/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: frameBlobRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: serviceBusNamespaceName
  location: location
  sku: {
    name: serviceBusSkuName
    tier: serviceBusSkuName
  }
  tags: tags
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

resource frameQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: frameQueueName
  properties: {
    requiresSession: true
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: serviceBusDuplicateDetectionHistoryTimeWindow
    lockDuration: serviceBusLockDuration
    maxDeliveryCount: serviceBusMaxDeliveryCount
    deadLetteringOnMessageExpiration: true
  }
}

resource backendSenderRule 'Microsoft.ServiceBus/namespaces/authorizationRules@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: 'backend-send'
  properties: {
    rights: [
      'Send'
    ]
  }
}

resource workerReceiverRule 'Microsoft.ServiceBus/namespaces/authorizationRules@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: 'worker-listen'
  properties: {
    rights: [
      'Listen'
    ]
  }
}

// KEDA must read queue runtime properties to calculate the ACA replica count.
// Keep this scoped to the queue and separate from the Worker's Listen-only credential.
resource workerScalerRule 'Microsoft.ServiceBus/namespaces/queues/authorizationRules@2022-10-01-preview' = {
  parent: frameQueue
  name: 'worker-scaler-manage'
  properties: {
    rights: [
      // Service Bus requires Send and Listen to accompany Manage on a SAS policy.
      'Manage'
      'Send'
      'Listen'
    ]
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  tags: tags
  properties: {
    administratorLogin: postgresAdministratorLogin
    administratorLoginPassword: postgresAdministratorPassword
    version: '16'
    storage: {
      storageSizeGB: postgresStorageSizeGb
      autoGrow: 'Enabled'
      tier: 'P4'
    }
    backup: {
      backupRetentionDays: postgresBackupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresAzureServicesFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'allow-azure-services'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource redis 'Microsoft.Cache/redisEnterprise@2025-04-01' = {
  name: redisCacheName
  location: location
  sku: {
    name: managedRedisSkuName
  }
  tags: tags
  properties: {
    encryption: {}
    minimumTlsVersion: '1.2'
  }
}

resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-04-01' = {
  parent: redis
  name: 'default'
  properties: {
    accessKeysAuthentication: 'Enabled'
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'OSSCluster'
    evictionPolicy: 'VolatileLRU'
    modules: []
    port: 10000
  }
}

resource signalr 'Microsoft.SignalRService/SignalR@2023-02-01' = {
  name: signalrName
  location: location
  sku: {
    name: signalrSkuName
    capacity: signalrCapacity
  }
  tags: tags
  properties: {
    tls: {
      clientCertEnabled: false
    }
    features: [
      {
        flag: 'ServiceMode'
        value: 'Default'
      }
    ]
  }
}

resource frontendContainerApp 'Microsoft.App/containerApps@2025-01-01' = if (deployWorkloads && deployFrontend) {
  name: frontendAppName
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        customDomains: frontendCustomDomains
      }
    }
    template: {
      containers: [
        {
          name: 'frontend'
          image: frontendImage
          resources: {
            cpu: frontendCpu
            memory: frontendMemory
          }
          env: [
            {
              name: 'HOSTNAME'
              value: '0.0.0.0'
            }
            {
              name: 'PORT'
              value: '3000'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: frontendMinReplicas
        maxReplicas: frontendMaxReplicas
        rules: [
          {
            name: 'http-concurrent-requests'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

resource backendContainerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployWorkloads) {
  name: backendAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: tags
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        customDomains: backendCustomDomains
      }
      secrets: concat([
        {
          name: 'backend-application-insights'
          value: backendApplicationInsights.properties.ConnectionString
        }
        {
          name: 'backend-database-connection'
          // This string is derived from the secure PostgreSQL password parameter and is stored only as an ACA secret.
          #disable-next-line use-secure-value-for-secure-inputs
          value: databaseConnectionString
        }
        {
          name: 'backend-blob-connection'
          value: backendBlobConnectionString
        }
        {
          name: 'backend-servicebus-connection'
          value: backendSenderRule.listKeys().primaryConnectionString
        }
        {
          name: 'backend-redis-connection'
          value: redisConnectionString
        }
        {
          name: 'backend-signalr-connection'
          value: signalr.listKeys().primaryConnectionString
        }
      ], bootstrapAdminConfigured ? [
        {
          name: 'initial-admin-id'
          value: initialAdminId
        }
        {
          name: 'initial-admin-password'
          value: initialAdminPassword
        }
      ] : [])
    }
    template: {
      terminationGracePeriodSeconds: backendTerminationGracePeriodSeconds
      containers: [
        {
          name: 'backend'
          image: backendImage
          resources: {
            cpu: backendCpu
            memory: backendMemory
          }
          env: concat([
            {
              name: 'ASPNETCORE_ENVIRONMENT'
              value: 'Production'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              secretRef: 'backend-application-insights'
            }
            {
              name: 'BACKEND_EXPECTED_INSTANCE_COUNT'
              value: string(backendExpectedInstanceCount)
            }
            {
              name: 'DATABASE_CONNECTION_STRING'
              secretRef: 'backend-database-connection'
            }
            {
              name: 'BLOB_CONNECTION_STRING'
              secretRef: 'backend-blob-connection'
            }
            {
              name: 'AZURE_BLOB_STORAGE_CONTAINER_NAME'
              value: frameContainerName
            }
            {
              name: 'SERVICEBUS_CONNECTION_STRING'
              secretRef: 'backend-servicebus-connection'
            }
            {
              name: 'AZURE_SERVICE_BUS_FRAME_QUEUE_NAME'
              value: frameQueue.name
            }
            {
              name: 'REDIS_CONNECTION_STRING'
              secretRef: 'backend-redis-connection'
            }
            {
              name: 'AZURE_SIGNALR_CONNECTION_STRING'
              secretRef: 'backend-signalr-connection'
            }
            {
              name: 'Worker__AuthMode'
              value: 'entra_id'
            }
            {
              name: 'Worker__Entra__Authority'
              value: workerEntraAuthority
            }
            {
              name: 'Worker__Entra__Audience'
              value: workerEntraAudience
            }
            {
              name: 'Worker__Entra__ValidIssuer'
              value: workerEntraValidIssuer
            }
            {
              name: 'OUTBOX_BATCH_SIZE'
              value: string(outboxBatchSize)
            }
            {
              name: 'OUTBOX_POLL_INTERVAL_MS'
              value: string(outboxPollIntervalMs)
            }
            {
              name: 'OUTBOX_LEASE_SECONDS'
              value: string(outboxLeaseSeconds)
            }
            {
              name: 'FRAME_BLOB_RETENTION_DAYS'
              value: string(frameBlobRetentionDays)
            }
            {
              name: 'Cors__AllowedOrigins__0'
              value: frontendOrigin
            }
          ], bootstrapAdminConfigured ? [
            {
              name: 'ADMIN_ID'
              secretRef: 'initial-admin-id'
            }
            {
              name: 'ADMIN_PASSWORD'
              secretRef: 'initial-admin-password'
            }
          ] : [])
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/live'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: backendMinInstances
        maxReplicas: backendMaxInstances
        rules: [
          {
            name: 'http-concurrent-requests'
            http: {
              metadata: {
                concurrentRequests: string(backendHttpConcurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

resource workerApp 'Microsoft.App/containerApps@2025-01-01' = if (deployWorkloads) {
  name: workerAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: tags
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        transport: 'http'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        customDomains: workerCustomDomains
      }
      secrets: [
        {
          name: 'worker-blob-connection'
          value: workerBlobConnectionString
        }
        {
          name: 'worker-servicebus-connection'
          value: workerReceiverRule.listKeys().primaryConnectionString
        }
        {
          name: 'worker-scaler-servicebus-connection'
          value: workerScalerRule.listKeys().primaryConnectionString
        }
        {
          name: 'redis-connection'
          value: redisConnectionString
        }
      ]
    }
    template: {
      terminationGracePeriodSeconds: workerTerminationGracePeriodSeconds
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: {
            cpu: workerCpu
            memory: workerMemory
          }
          env: [
            {
              name: 'WORKER_ENVIRONMENT'
              value: 'production'
            }
            {
              name: 'WORKER_AUTH_MODE'
              value: 'entra_id'
            }
            {
              name: 'WORKER_BACKEND_BASE_URL'
              value: 'https://${backendContainerApp!.properties.configuration.ingress.fqdn}'
            }
            {
              name: 'WORKER_BACKEND_HEALTH_URL'
              value: 'https://${backendContainerApp!.properties.configuration.ingress.fqdn}/health/ready'
            }
            {
              name: 'WORKER_BACKEND_TOKEN_SCOPE'
              value: workerBackendTokenScope
            }
            {
              name: 'AZURE_SERVICE_BUS_CONNECTION_STRING'
              secretRef: 'worker-servicebus-connection'
            }
            {
              name: 'AZURE_SERVICE_BUS_FRAME_QUEUE_NAME'
              value: frameQueue.name
            }
            {
              name: 'AZURE_BLOB_STORAGE_CONNECTION_STRING'
              secretRef: 'worker-blob-connection'
            }
            {
              name: 'AZURE_BLOB_STORAGE_CONTAINER_NAME'
              value: frameContainerName
            }
            {
              name: 'REDIS_CONNECTION_STRING'
              secretRef: 'redis-connection'
            }
            {
              name: 'REDIS_CLUSTER_MODE'
              value: 'true'
            }
            {
              name: 'WORKER_SESSION_CONCURRENCY'
              value: string(workerSessionConcurrency)
            }
            {
              name: 'WORKER_MAX_DELIVERY_COUNT'
              value: string(serviceBusMaxDeliveryCount)
            }
            {
              name: 'WORKER_SHUTDOWN_TIMEOUT_SECONDS'
              value: string(workerShutdownTimeoutSeconds)
            }
            {
              name: 'WORKER_HEALTH_PORT'
              value: '8000'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/live'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 20
            }
          ]
        }
      ]
      scale: {
        minReplicas: workerMinReplicas
        maxReplicas: workerMaxReplicas
        pollingInterval: workerScalingPollingIntervalSeconds
        rules: [
          {
            name: 'servicebus-active-message-backlog'
            custom: {
              type: 'azure-servicebus'
              metadata: {
                queueName: frameQueue.name
                namespace: serviceBusNamespace.name
                messageCount: string(workerScaleQueueThreshold)
              }
              auth: [
                {
                  triggerParameter: 'connection'
                  secretRef: 'worker-scaler-servicebus-connection'
                }
              ]
            }
          }
        ]
      }
    }
  }
}

output containerImageRegistry string = containerImageRegistry
output frontendImageReference string = frontendImage
output backendImageReference string = backendImage
output workerImageReference string = workerImage
output containerEnvironmentName string = containerEnvironment.name
output containerEnvironmentStaticIp string = containerEnvironment.properties.staticIp
output frontendContainerAppName string = deployWorkloads && deployFrontend ? frontendContainerApp!.name : ''
output frontendContainerAppFqdn string = deployWorkloads && deployFrontend ? frontendContainerApp!.properties.configuration.ingress.fqdn : ''
output frontendCustomDomainVerificationId string = deployWorkloads && deployFrontend ? frontendContainerApp!.properties.customDomainVerificationId : ''
output backendContainerAppName string = deployWorkloads ? backendContainerApp!.name : ''
output backendContainerAppFqdn string = deployWorkloads ? backendContainerApp!.properties.configuration.ingress.fqdn : ''
output backendCustomDomainVerificationId string = deployWorkloads ? backendContainerApp!.properties.customDomainVerificationId : ''
output workerContainerAppName string = deployWorkloads ? workerApp!.name : ''
output workerContainerAppFqdn string = deployWorkloads ? workerApp!.properties.configuration.ingress.fqdn : ''
output workerCustomDomainVerificationId string = deployWorkloads ? workerApp!.properties.customDomainVerificationId : ''
output customDomainBindingStage string = customDomainBindingStage
output postgresServerHost string = '${postgres.name}.postgres.database.azure.com'
output redisHost string = '${redis.name}.redis.cache.windows.net'
output serviceBusNamespace string = serviceBusNamespace.name
output frameQueueName string = frameQueue.name
output logAnalyticsWorkspaceId string = logAnalytics.properties.customerId
