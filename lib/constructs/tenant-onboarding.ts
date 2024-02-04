import { Construct } from "constructs";
import { Arn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';

// Define the properties required for tenant onboarding
export interface TenantOnboardingProps {
    readonly onboardingProjectName: string; // Name of the onboarding project
    readonly deletionProjectName: string; // Name of the deletion project
    readonly assetDirectory: string; // Directory containing project assets

    readonly eksClusterName: string; // Name of the EKS cluster
    readonly codebuildKubectlRole: iam.IRole; // IAM role for CodeBuild to interact with Kubectl
    readonly eksClusterOIDCProviderArn: string; // ARN of the OIDC provider associated with EKS

    readonly applicationServiceBuildProjectNames: string[]; // Names of application service build projects

    readonly appSiteDistributionId: string; // ID of the CloudFront distribution for the app site
    readonly appSiteCloudFrontDomain: string; // Domain of the CloudFront distribution for the app site
    readonly appSiteCustomDomain?: string; // Custom domain for the app site (optional)
    readonly appSiteHostedZoneId?: string; // Hosted zone ID for the custom domain (optional)

    readonly defaultBranchName?: string; // Default branch name for the repository (optional)
}

// Define the main construct for tenant onboarding
export class TenantOnboarding extends Construct {

    readonly repositoryUrl: string; // URL of the source code repository

    constructor(scope: Construct, id: string, props: TenantOnboardingProps) {
        super(scope, id);

        // Set default branch name if not provided
        const defaultBranchName = props.defaultBranchName ?? "main";

        // Add permissions required for tenant onboarding
        this.addTenantOnboardingPermissions(props.codebuildKubectlRole, props);

        // Create a CodeCommit repository for tenant onboarding
        const sourceRepo = new codecommit.Repository(this, `${id}Repository`, {
            repositoryName: "TenantOnboarding",
            description: `Repository for tenant onboarding`,
            code: codecommit.Code.fromDirectory(props.assetDirectory, defaultBranchName),
        });
        sourceRepo.applyRemovalPolicy(RemovalPolicy.DESTROY);
        this.repositoryUrl = sourceRepo.repositoryCloneUrlHttp;

        // Define CloudFormation parameters for onboarding
        const onboardingCfnParams: { [key: string]: string } = {
            "TenantId": "$TENANT_ID", // Placeholder for Tenant ID
            "CompanyName": '"$COMPANY_NAME"', // Placeholder for Company Name
            "TenantAdminEmail": '"$ADMIN_EMAIL"', // Placeholder for Admin Email
            "AppDistributionId": `"${props.appSiteDistributionId}"`, // CloudFront distribution ID
            "DistributionDomain": `"${props.appSiteCloudFrontDomain}"`, // CloudFront distribution domain
            "EKSClusterName": `"${props.eksClusterName}"`, // EKS cluster name
            "KubectlRoleArn": `"${props.codebuildKubectlRole.roleArn}"`, // ARN of Kubectl IAM role
            "OIDCProviderArn": `"${props.eksClusterOIDCProviderArn}"`, // ARN of EKS OIDC provider
        };
    

        // Construct a string containing CloudFormation parameters from the provided object
const cfnParamString = Object.entries(onboardingCfnParams).map(x => `--parameters ${x[0]}=${x[1]}`).join(" ");

// Create a CodeBuild project for tenant onboarding
const onboardingProject = new codebuild.Project(this, `TenantOnboardingProject`, {
    projectName: `${props.onboardingProjectName}`, // Name of the CodeBuild project
    source: codebuild.Source.codeCommit({ repository: sourceRepo }), // Use CodeCommit as the source
    role: props.codebuildKubectlRole, // IAM role for the CodeBuild project
    environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0, // Build environment
    },
    environmentVariables: {
        // Environment variables for the CodeBuild project
        TENANT_ID: { value: "" }, // Placeholder for Tenant ID
        COMPANY_NAME: { value: "" }, // Placeholder for Company Name
        ADMIN_EMAIL: { value: "" }, // Placeholder for Admin Email
        PLAN: { value: "" }, // Placeholder for Plan
        AWS_ACCOUNT: { value: Stack.of(this).account }, // AWS account ID
        AWS_REGION: { value: Stack.of(this).region }, // AWS region
        APP_SITE_CUSTOM_DOMAIN: { value: props.appSiteCustomDomain ?? "" }, // Custom domain for the app site
        APP_SITE_HOSTED_ZONE: { value: props.appSiteHostedZoneId ?? "" }, // Hosted zone ID for the custom domain
    },
    buildSpec: codebuild.BuildSpec.fromObject({
        // Build specification for the CodeBuild project
        version: '0.2',
        phases: {
            install: {
                commands: [
                    "npm i", // Install dependencies
                ]
            },
            pre_build: {
                commands: [
                    // Pre-build commands (if any)
                ],
            },
            build: {
                commands: [
                    "npm run cdk bootstrap", // Bootstrap AWS CDK
                    `npm run cdk deploy TenantStack-$TENANT_ID -- --require-approval=never ${cfnParamString}` // Deploy AWS CDK stack with CloudFormation parameters
                ],
            },
            post_build: {
                commands: props.applicationServiceBuildProjectNames.map(
                    // Commands to trigger builds for application service projects
                    x => `aws codebuild start-build --project-name ${x}TenantDeploy --environment-variables-override name=TENANT_ID,value=\"$TENANT_ID\",type=PLAINTEXT`)
            },
        },
    }),
});

      // Grant permission for the CodeBuild project to pull from the CodeCommit repository
sourceRepo.grantPull(onboardingProject.role!);

// Create a CodeBuild project for tenant deletion
const tenantDeletionProject = new codebuild.Project(this, 'TenantDeletionProject', {
    projectName: props.deletionProjectName, // Name of the CodeBuild project
    role: props.codebuildKubectlRole, // IAM role for the CodeBuild project
    source: codebuild.Source.codeCommit({ repository: sourceRepo }), // Use CodeCommit as the source
    environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0, // Build environment
    },
    environmentVariables: {
        TENANT_ID: { value: "" }, // Placeholder for Tenant ID
        AWS_ACCOUNT: { value: Stack.of(this).account }, // AWS account ID
        AWS_REGION: { value: Stack.of(this).region } // AWS region
    },
    buildSpec: codebuild.BuildSpec.fromObject({
        // Build specification for the CodeBuild project
        version: '0.2',
        phases: {
            install: {
                commands: [
                    "npm i", // Install dependencies
                ]
            },
            pre_build: {
                commands: [
                    // Pre-build commands (if any)
                ],
            },
            build: {
                commands: [
                    "npm run cdk bootstrap", // Bootstrap AWS CDK
                    `npm run cdk destroy TenantStack-$TENANT_ID -- --require-approval=never -f`, // Destroy AWS CDK stack with force flag
                ],
            },
            post_build: {
                commands: [
                    // Post-build commands (if any)
                ]
            },
        },
    }),
});

// Grant permission for the CodeBuild project to pull from the CodeCommit repository
sourceRepo.grantPull(tenantDeletionProject.role!);
}
    private addTenantOnboardingPermissions(projectRole: iam.IRole, props: TenantOnboardingProps) {
        // TODO: reduce the permission 

        projectRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "route53:*"
            ],
            resources: [
                `arn:${Stack.of(this).partition}:route53:::hostedzone/${props.appSiteHostedZoneId!}`
            ],
            effect: iam.Effect.ALLOW
        }));
        projectRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "route53domains:*",
                "cognito-identity:*",
                "cognito-idp:*",
                "cognito-sync:*",
                "iam:*",
                "s3:*",
                "cloudformation:*",
                "codebuild:StartBuild",
            ],
            resources: [
                "*"
            ],
            effect: iam.Effect.ALLOW
        }));
        projectRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "cloudfront:AssociateAlias",
                "cloudfront:GetDistribution",
                "cloudfront:GetDistributionConfig",
                "cloudfront:UpdateDistribution",
            ],
            resources: [
                Arn.format({ service: "cloudfront", resource: "distribution", resourceName: props.appSiteDistributionId }, Stack.of(this))
            ],
            effect: iam.Effect.ALLOW
        }));
        projectRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "dynamodb:PutItem",
                "dynamodb:DeleteItem",
            ],
            resources: [
                Arn.format({ service: "dynamodb", resource: "table", resourceName: "Tenant" }, Stack.of(this))
            ],
            effect: iam.Effect.ALLOW
        }));
        projectRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "dynamodb:CreateTable",
                "dynamodb:DeleteTable",
            ],
            resources: [
                Arn.format({ service: "dynamodb", resource: "table", resourceName: "Order-*" }, Stack.of(this))
            ],
            effect: iam.Effect.ALLOW
        }));
        projectRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "ssm:GetParameter"
            ],
            resources: [
                Arn.format({ service: "ssm", resource: "parameter", resourceName: "cdk-bootstrap/*"}, Stack.of(this))
            ]
        }))
    }
}