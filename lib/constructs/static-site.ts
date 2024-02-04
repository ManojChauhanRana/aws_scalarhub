import { RemovalPolicy, Stack } from 'aws-cdk-lib'; // Import necessary CDK constructs and modules
import { Construct } from "constructs"; // Import Construct from 'constructs' module
import * as codecommit from 'aws-cdk-lib/aws-codecommit'; // Import CodeCommit constructs from CDK
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'; // Import CodePipeline constructs from CDK
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions'; // Import CodePipeline actions from CDK
import * as codebuild from 'aws-cdk-lib/aws-codebuild'; // Import CodeBuild constructs from CDK
import * as s3 from 'aws-cdk-lib/aws-s3'; // Import S3 constructs from CDK
import * as iam from 'aws-cdk-lib/aws-iam'; // Import IAM constructs from CDK
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'; // Import CloudFront constructs from CDK
import * as acm from 'aws-cdk-lib/aws-certificatemanager'; // Import ACM constructs from CDK
import * as route53 from 'aws-cdk-lib/aws-route53'; // Import Route 53 constructs from CDK
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'; // Import CloudFront origins from CDK
import * as alias from 'aws-cdk-lib/aws-route53-targets'; // Import Route 53 targets from CDK
import { Cognito } from './cognito'; // Import the Cognito construct from a local file

// Define the properties for the StaticSite construct
export interface StaticSiteProps {
    readonly name: string // Name of the site
    readonly assetDirectory: string // Directory containing the site's assets
    readonly allowedMethods: string[] // Allowed HTTP methods
    readonly createCognitoUserPool: boolean // Whether to create a Cognito User Pool
    readonly siteConfigurationGenerator: (siteDomain: string, cognitoResources?: Cognito) => Record<string, string | number | boolean>; // Function to generate site configuration
    
    readonly customDomain?: string // Custom domain for the site
    readonly certDomain?: string // Domain for SSL certificate
    readonly hostedZone?: route53.IHostedZone // Hosted zone for the domain
    readonly defaultBranchName?: string // Default branch name for the repository
    readonly cognitoProps?: { // Cognito properties if creating a User Pool
        adminUserEmail: string // Email address of the admin user
        emailSubjectGenerator?: (siteName: string) => string // Function to generate email subject
        emailBodyGenerator?: (siteDomain: string) => string // Function to generate email body
    }
}

// Default email subject generator function
const defaultEmailSubjectGenerator = (siteName: string) => `${siteName} User Created`;
// Default email body generator function
const defaultEmailBodyGenerator = (siteDomain: string) => `Your username is {username} and temporary password is {####}. Please login here: https://${siteDomain}`;

// Define the StaticSite construct
export class StaticSite extends Construct {

    readonly repositoryUrl: string; // URL of the repository
    readonly siteDomain: string; // Domain of the site
    readonly cloudfrontDistribution: cloudfront.Distribution; // CloudFront distribution
    readonly siteBucket: s3.Bucket; // S3 bucket for the site

    constructor(scope: Construct, id: string, props: StaticSiteProps) {
        super(scope, id); // Call the parent constructor

        const defaultBranchName = props.defaultBranchName ?? "main"; // Get default branch name or use 'main'
        const useCustomDomain = props.customDomain ? true : false; // Check if custom domain is provided

        // Validate custom domain configuration
        if (useCustomDomain && !props.hostedZone) {
            throw new Error(`HostedZone cannot be empty for the custom domain '${props.customDomain}'`);
        }
        // Validate Cognito configuration
        if (props.createCognitoUserPool && !props.cognitoProps) {
            throw new Error(`Cognito configuration is required when creating Cognito UserPool for the site '${props.name}'`);
        }

        // Create a CodeCommit repository
        const repository = new codecommit.Repository(this, `${id}Repository`, {
            repositoryName: props.name,
            description: `Repository with code for ${props.name}`,
            code: codecommit.Code.fromDirectory(props.assetDirectory, defaultBranchName)
        });
        repository.applyRemovalPolicy(RemovalPolicy.DESTROY); // Apply removal policy to the repository
        this.repositoryUrl = repository.repositoryCloneUrlHttp; // Set repository URL

        // Create the static site components
        const { distribution, appBucket } = this.createStaticSite(id, props.allowedMethods, useCustomDomain, props.customDomain, props.certDomain, props.hostedZone);
        this.cloudfrontDistribution = distribution; // Set CloudFront distribution
        this.siteBucket = appBucket; // Set S3 bucket
        this.siteDomain = useCustomDomain ? props.customDomain! : distribution.domainName; // Set site domain

        // Create Cognito resources if needed
        const cognitoResources =
            props.createCognitoUserPool ?
                new Cognito(this, "Cognito", {
                    adminUserEmailAddress: props.cognitoProps!.adminUserEmail,
                    userPoolName: `${props.name}UserPool`,
                    callbackUrl: `https://${this.siteDomain}`,
                    signoutUrl: `https://${this.siteDomain}/signout`,
                    inviteEmailSubject: (props.cognitoProps!.emailSubjectGenerator || defaultEmailSubjectGenerator)(props.name),
                    inviteEmailBody: (props.cognitoProps?.emailBodyGenerator || defaultEmailBodyGenerator)(this.siteDomain)
                }) :
                undefined;

        // Generate site configuration
        const siteConfig = props.siteConfigurationGenerator(this.siteDomain, cognitoResources);

        // Create CI/CD pipeline for the static site
        this.createCICDForStaticSite(id, repository, defaultBranchName, distribution.distributionId, siteConfig, appBucket);

    }

    // Function to create the static site components
    private createStaticSite(
        id: string,
        allowedMethods: string[],
        useCustomDomain: boolean,
        customDomain?: string,
        certDomain?: string,
        hostedZone?: route53.IHostedZone) {

        // Create an Origin Access Identity for CloudFront
        const oai = new cloudfront.OriginAccessIdentity(this, `${id}OriginAccessIdentity`, {
            comment: "Special CloudFront user to fetch S3 contents",
        });

        let siteCertificate = undefined;
        let domainNamesToUse = undefined;

        // Configure SSL certificate and domain names if using custom domain
        if (useCustomDomain) {
            siteCertificate = new acm.DnsValidatedCertificate(this, `${id}Certificate`, {
                domainName: certDomain ?? customDomain!,
                hostedZone: hostedZone!,
                region: 'us-east-1',
            });

            domainNamesToUse = new Array<string>(certDomain ?? customDomain!);
        }

        // Create an S3 bucket for the site
        const appBucket = new s3.Bucket(this, `${id}Bucket`, {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });

        // Add permissions for CloudFront to access the S3 bucket
        appBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                resources: [
                    appBucket.arnForObjects("*")
                ],
                actions: [
                    "s3:GetObject"
                ],
                principals: [
                    new iam.CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId)
                ]
            })
        );

        // Create a CloudFront distribution
        const distribution = new cloudfront.Distribution(this, `${id}Distribution`, {
            defaultBehavior: {
                origin: new origins.S3Origin(appBucket, {
                    originAccessIdentity: oai,
                }),
                allowedMethods: { methods: allowedMethods },
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                compress: true,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
            },
            certificate: siteCertificate,
            defaultRootObject: 'index.html',
            domainNames: domainNamesToUse,
            enabled: true,
            errorResponses: [
                { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
                { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' }
            ],
            httpVersion: cloudfront.HttpVersion.HTTP2,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2018,
        });

        // Create DNS record for the custom domain
        if (useCustomDomain) {
            new route53.ARecord(this, `${id}AliasRecord`, {
                zone: hostedZone!,
                recordName: certDomain ?? customDomain!,
                target: route53.RecordTarget.fromAlias(new alias.CloudFrontTarget(distribution))
            });
        }

        return { distribution, appBucket };
    }

    // Function to create CI/CD pipeline for the static site
    private createCICDForStaticSite(
        id: string,
        repo: codecommit.Repository,
        branchName: string,
        cloudfrontDistributionId: string,
        siteConfig: Record<string, string | number | boolean>,
        bucket: s3.Bucket) {

        // Create a CodePipeline
        const pipeline = new codepipeline.Pipeline(this, `${id}CodePipeline`, {
            crossAccountKeys: false,
            artifactBucket: new s3.Bucket(this, `${id}CodePipelineBucket`, {
                autoDeleteObjects: true,
                removalPolicy: RemovalPolicy.DESTROY
            })
        });
        const sourceArtifact = new codepipeline.Artifact(); // Create source artifact

        // Add source stage to the pipeline
        pipeline.addStage({
            stageName: "Source",
            actions: [
                new actions.CodeCommitSourceAction({
                    actionName: "Checkout",
                    repository: repo,
                    output: sourceArtifact,
                    branch: branchName,
                })
            ]
        });

        // Create a CodeBuild project for building the site
        const buildProject = new codebuild.PipelineProject(this, `${id}AngularBuildProject`, {
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            "npm install --force"
                        ]
                    },
                    build: {
                        commands: [
                            `echo 'export const environment = ${JSON.stringify(siteConfig)}' > ./src/environments/environment.prod.ts`,
                            `echo 'export const environment = ${JSON.stringify(siteConfig)}' > ./src/environments/environment.ts`,
                            "npm run build"
                        ]
                    },
                },
                artifacts: {
                    files: [
                        "**/*"
                    ],
                    "base-directory": "dist"
                },
            }),
            environmentVariables: {
            },
        });

        const buildOutput = new codepipeline.Artifact(); // Create build output artifact

        // Add build stage to the pipeline
        pipeline.addStage({
            stageName: "Build",
            actions: [
                new actions.CodeBuildAction({
                    actionName: "CompileNgSite",
                    input: sourceArtifact,
                    project: buildProject,
                    outputs: [
                        buildOutput
                    ]
                })
            ]
        });

        // Create a CodeBuild project for invalidating CloudFront cache
        const invalidateBuildProject = new codebuild.PipelineProject(this, `${id}InvalidateProject`, {
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    build: {
                        commands: [
                            'aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_ID} --paths "/*"',
                        ],
                    },
                },
            }),
            environmentVariables: {
                CLOUDFRONT_ID: { value: cloudfrontDistributionId },
            },
        });

        const distributionArn = `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${cloudfrontDistributionId}`;
        invalidateBuildProject.addToRolePolicy(new iam.PolicyStatement({
            resources: [distributionArn],
            actions: [
                'cloudfront:CreateInvalidation'
            ]
        }));

        // Add deploy stage to the pipeline
        pipeline.addStage({
            stageName: "Deploy",
            actions: [
                new actions.S3DeployAction({
                    actionName: "CopyToS3",
                    bucket: bucket,
                    input: buildOutput,
                    cacheControl: [actions.CacheControl.fromString("no-store")],
                    runOrder: 1
                }),
                new actions.CodeBuildAction({
                    actionName: "InvalidateCloudFront",
                    input: buildOutput,
                    project: invalidateBuildProject,
                    runOrder: 2
                })
            ]
        });

        // Add permissions for pipeline to start builds
        pipeline.addToRolePolicy(new iam.PolicyStatement({
            actions: ["codebuild:StartBuild"],
            resources: [buildProject.projectArn, invalidateBuildProject.projectArn],
            effect: iam.Effect.ALLOW
        }));
    }
}
