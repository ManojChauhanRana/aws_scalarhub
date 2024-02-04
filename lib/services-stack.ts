// Import necessary modules from the AWS CDK library
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
// Import the Construct class from the 'constructs' module
import { Construct } from "constructs";
// Import the SharedService construct for creating shared services
import { SharedService } from "./constructs/shared-service";
// Import IAM module for working with IAM roles
import * as iam from "aws-cdk-lib/aws-iam";
// Import path module for file path operations
import * as path from "path";
// Import the ApplicationService construct for creating application services
import { ApplicationService } from "./constructs/application-service";
// Import the TenantOnboarding construct for creating tenant onboarding service
import { TenantOnboarding } from "./constructs/tenant-onboarding";

// Define the properties interface for the ServicesStack
export interface ServicesStackProps extends StackProps {
    readonly internalNLBApiDomain: string; // Internal NLB (Network Load Balancer) API domain
    readonly eksClusterName: string; // Name of the EKS (Elastic Kubernetes Service) cluster
    readonly eksClusterOIDCProviderArn: string; // ARN of the EKS cluster's OIDC provider
    readonly codebuildKubectlRoleArn: string; // ARN of the CodeBuild Kubectl role
    readonly appSiteDistributionId: string; // ID of the application site distribution (CloudFront)
    readonly appSiteCloudFrontDomain: string; // Domain of the application site (CloudFront)
    readonly sharedServiceAccountName: string; // Name of the shared service account
    readonly appHostedZoneId?: string; // Optional hosted zone ID for the application
    readonly customDomain?: string; // Optional custom domain for the application
}

// Define the ServicesStack class, extending Stack
export class ServicesStack extends Stack {
    constructor(scope: Construct, id: string, props: ServicesStackProps) {
        // Call the constructor of the base class (Stack)
        super(scope, id, props);

        // Get the CodeBuild Kubectl role from its ARN
        const role = iam.Role.fromRoleArn(this, "CodebuildKubectlRole", props.codebuildKubectlRoleArn);

        // Create shared services

        // Tenant Management Service
        const tenantMgmtSvc = new SharedService(this, "TenantManagementService", {
            internalApiDomain: props.internalNLBApiDomain,
            eksClusterName: props.eksClusterName,
            codebuildKubectlRole: role,
            name: "TenantManagement",
            ecrImageName: "tenant-mgmt",
            sharedServiceAccountName: props.sharedServiceAccountName,
            assetDirectory: path.join(__dirname, "..", "services", "shared-services", "tenant-management-service")
        });
        // Output the repository URL for Tenant Management Service
        new CfnOutput(this, "TenantManagementRepository", {
            value: tenantMgmtSvc.codeRepositoryUrl
        });

        // Tenant Registration Service
        const tenantRegSvc = new SharedService(this, "TenantRegistrationService", {
            internalApiDomain: props.internalNLBApiDomain,
            eksClusterName: props.eksClusterName,
            codebuildKubectlRole: role,
            name: "TenantRegistration",
            ecrImageName: "tenant-reg",
            sharedServiceAccountName: props.sharedServiceAccountName,
            assetDirectory: path.join(__dirname, "..", "services", "shared-services", "tenant-registration-service")
        });
        // Output the repository URL for Tenant Registration Service
        new CfnOutput(this, "TenantRegistrationRepository", {
            value: tenantRegSvc.codeRepositoryUrl
        });

        // User Management Service
        const userMgmtSvc = new SharedService(this, "UserManagementService", {
            internalApiDomain: props.internalNLBApiDomain,
            eksClusterName: props.eksClusterName,
            codebuildKubectlRole: role,
            name: "UserManagement",
            ecrImageName: "user-mgmt",
            sharedServiceAccountName: props.sharedServiceAccountName,
            assetDirectory: path.join(__dirname, "..", "services", "shared-services", "user-management-service")
        });
        // Output the repository URL for User Management Service
        new CfnOutput(this, "UserManagementRepository", {
            value: userMgmtSvc.codeRepositoryUrl
        });

        // Create application services

        // Product Service
        const productSvc = new ApplicationService(this, "ProductService", {
            internalApiDomain: props.internalNLBApiDomain,
            eksClusterName: props.eksClusterName,
            codebuildKubectlRole: role,
            name: "ProductService",
            ecrImageName: "product-svc",
            serviceUrlPrefix: "products",
            assetDirectory: path.join(__dirname, "..", "services", "application-services", "product-service")
        });
        // Output the repository URL for Product Service
        new CfnOutput(this, "ProductServiceRepository", {
            value: productSvc.codeRepositoryUrl
        });

        // Order Service
        const orderSvc = new ApplicationService(this, "OrderService", {
            internalApiDomain: props.internalNLBApiDomain,
            eksClusterName: props.eksClusterName,
            codebuildKubectlRole: role,
            name: "OrderService",
            ecrImageName: "order-svc",
            serviceUrlPrefix: "orders",
            assetDirectory: path.join(__dirname, "..", "services", "application-services", "order-service")
        });
        // Output the repository URL for Order Service
        new CfnOutput(this, "OrderServiceRepository", {
            value: orderSvc.codeRepositoryUrl
        });

        // Create Tenant Onboarding Service
        const onboardingSvc = new TenantOnboarding(this, "TenantOnboarding", {
            appSiteCloudFrontDomain: props.appSiteCloudFrontDomain,
            appSiteDistributionId: props.appSiteDistributionId,
            codebuildKubectlRole: role,
            eksClusterOIDCProviderArn: props.eksClusterOIDCProviderArn,
            eksClusterName: props.eksClusterName,
            applicationServiceBuildProjectNames: ["ProductService", "OrderService"],
            onboardingProjectName: "TenantOnboardingProject",
            deletionProjectName: "TenantDeletionProject",
            appSiteHostedZoneId: props.appHostedZoneId,
            appSiteCustomDomain: props.customDomain ? `app.${props.customDomain!}` : undefined,
            assetDirectory: path.join(__dirname, "..", "services", "tenant-onboarding"),
        });
        // Output the repository URL for Tenant Onboarding Service
        new CfnOutput(this, "TenantOnboardingRepository", {
            value: onboardingSvc.repositoryUrl
        });
    }
}
