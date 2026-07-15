@description('Existing Azure Container Apps managed environment name created by main.bicep.')
param containerEnvironmentName string

@description('Azure region of the existing managed environment.')
param location string = resourceGroup().location

@description('Set true only after Cloudflare A/TXT records resolve to the outputs of main.bicep and main.bicep has been deployed with customDomainBindingStage=DnsValidated.')
param dnsHandoffAndUnsecuredBindingsConfirmed bool = false

@description('Frontend custom hostname already attached to the independent Frontend Container App without a certificate.')
param frontendHostname string = 'awaver.4rnay.net'

@description('API and SignalR custom hostname already attached to the Backend Container App without a certificate.')
param backendHostname string = 'api.awaver.4rnay.net'

@description('Health-only custom hostname already attached to the Worker Container App without a certificate.')
param workerHealthHostname string = 'worker.api.awaver.4rnay.net'

@description('Managed certificate resource name consumed by main.bicep when customDomainBindingStage=Secured.')
param frontendManagedCertificateName string = 'awaver-frontend-managed'

@description('Managed certificate resource name consumed by main.bicep when customDomainBindingStage=Secured.')
param backendManagedCertificateName string = 'awaver-backend-managed'

@description('Managed certificate resource name consumed by main.bicep when customDomainBindingStage=Secured.')
param workerManagedCertificateName string = 'awaver-worker-health-managed'

param tags object = {
  workload: 'awakeverify'
  environment: 'nonproduction'
  purpose: 'scheduled-demo-managed-certificates'
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerEnvironmentName
}

// These resources are intentionally separate from main.bicep. HTTP validation requires
// Cloudflare DNS and certificate-free hostname bindings to exist before certificate issuance.
// main.bicep binds awaver.4rnay.net to Frontend, api.awaver.4rnay.net to Backend,
// and worker.api.awaver.4rnay.net to Worker when customDomainBindingStage=Secured.
resource frontendManagedCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (dnsHandoffAndUnsecuredBindingsConfirmed) {
  parent: containerEnvironment
  name: frontendManagedCertificateName
  location: location
  tags: tags
  properties: {
    subjectName: frontendHostname
    domainControlValidation: 'HTTP'
  }
}

resource backendManagedCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (dnsHandoffAndUnsecuredBindingsConfirmed) {
  parent: containerEnvironment
  name: backendManagedCertificateName
  location: location
  tags: tags
  properties: {
    subjectName: backendHostname
    domainControlValidation: 'HTTP'
  }
}

resource workerManagedCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (dnsHandoffAndUnsecuredBindingsConfirmed) {
  parent: containerEnvironment
  name: workerManagedCertificateName
  location: location
  tags: tags
  properties: {
    subjectName: workerHealthHostname
    domainControlValidation: 'HTTP'
  }
}

output certificateCreationRequested bool = dnsHandoffAndUnsecuredBindingsConfirmed
output frontendManagedCertificateId string = dnsHandoffAndUnsecuredBindingsConfirmed ? frontendManagedCertificate.id : ''
output backendManagedCertificateId string = dnsHandoffAndUnsecuredBindingsConfirmed ? backendManagedCertificate.id : ''
output workerManagedCertificateId string = dnsHandoffAndUnsecuredBindingsConfirmed ? workerManagedCertificate.id : ''
