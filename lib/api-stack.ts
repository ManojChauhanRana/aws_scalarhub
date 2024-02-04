// Import necessary modules from the AWS CDK library
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
// Import the Construct class from the 'constructs' module
import { Construct } from "constructs";
// Import path module for file path operations
import * as path from "path";
// Import Route 53 module for working with DNS records
import * as route53 from 'aws-cdk-lib/aws-route53';
// Import the StaticSite construct for creating static sites
import { StaticSite } from "./constructs/static-site";
// Import CloudFront Distribution module
import { Distribution } from "aws-cdk-lib/aws-cloudfront";

// Define the properties interface for the StaticSitesStack
export interface StaticSitesStackProps extends StackProps {
    readonly apiUrl: string; // URL of the API endpoint
    readonly saasAdminEmail: string; // Admin email for SAAS application

    readonly usingKubeCost: boolean; // Indicates if KubeCost is being used

    readonly customBaseDomain?: string; // Optional custom base domain for the static sites
    readonly hostedZoneId?: string; // Optional hosted zone ID for Route 53
}

// Define the StaticSitesStack class, extending Stack
export class StaticSitesStack extends Stack {

    readonly applicationSiteDistribution: Distribution; // CloudFront distribution for the application site

    constructor(scope: Construct, id: string, props: StaticSitesStackProps) {
        // Call the constructor of the base class (Stack)
        super(scope, id, props);

        // Check if a custom domain is being used
        const useCustomDomain = props.customBaseDomain ? true : false;
        // Validate if a hosted zone ID is provided when using a custom domain
        if (useCustomDomain && !props.hostedZoneId) {
            throw new Error("HostedZoneId must be specified when using a custom domain for static sites.");
        }

        // Get the hosted zone based on whether a custom domain is being used
        const hostedZone = useCustomDomain ? route53.PublicHostedZone.fromHostedZoneAttributes(this, 'PublicHostedZone', {
            hostedZoneId: props.hostedZoneId!,
            zoneName: props.customBaseDomain!
        }) : undefined;


        // Create landing site
        const landingSite = new StaticSite(this, "LandingSite", {
            name: "LandingSite",
            assetDirectory: path.join(path.dirname(__filename), "..", "clients", "Landing"),
            allowedMethods: ["GET", "HEAD", "OPTIONS"],
            createCognitoUserPool: false,
            siteConfigurationGenerator: (siteDomain, _) => ({
                production: true,
                apiUrl: props.apiUrl,
                domain: siteDomain,
                usingCustomDomain: useCustomDomain,
            }),
            customDomain: useCustomDomain ? `landing.${props.customBaseDomain!}` : undefined,
            hostedZone: hostedZone
        });

        // Output the repository URL and URL of the landing site
        new CfnOutput(this, `LandingSiteRepository`, {
            value: landingSite.repositoryUrl
        });
        new CfnOutput(this, `LandingSiteUrl`, {
            value: `https://${landingSite.siteDomain}`
        });


        // Create admin site
        const adminSite = new StaticSite(this, "AdminSite", {
            name: "AdminSite",
            assetDirectory: path.join(path.dirname(__filename), "..", "clients", "Admin"),
            allowedMethods: ["GET", "HEAD", "OPTIONS"],
            createCognitoUserPool: true,
            cognitoProps: {
                adminUserEmail: props.saasAdminEmail
            },
            siteConfigurationGenerator: (siteDomain, cognito) => ({
                production: true,
                clientId: cognito!.appClientId,
                issuer: cognito!.authServerUrl,
                customDomain: cognito!.appClientId,
                apiUrl: props.apiUrl,
                domain: siteDomain,
                usingCustomDomain: useCustomDomain,
                usingKubeCost: props.usingKubeCost,
                kubecostUI: props.usingKubeCost ? `${props.apiUrl}/kubecost` : ""
            }),
            customDomain: useCustomDomain ? `admin.${props.customBaseDomain!}` : undefined,
            hostedZone: hostedZone
        });
        // Output the repository URL and URL of the admin site
        new CfnOutput(this, `AdminSiteRepository`, {
            value: adminSite.repositoryUrl
        });
        new CfnOutput(this, `AdminSiteUrl`, {
            value: `https://${adminSite.siteDomain}`
        });


        // Create application site
        const applicationSite = new StaticSite(this, "ApplicationSite", {
            name: "ApplicationSite",
            assetDirectory: path.join(path.dirname(__filename), "..", "clients", "Application"),
            allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
            createCognitoUserPool: false,
            siteConfigurationGenerator: (siteDomain, _) => ({
                production: true,
                apiUrl: props.apiUrl,
                domain: siteDomain,
                usingCustomDomain: useCustomDomain,
            }),
            customDomain: useCustomDomain ? `app.${props.customBaseDomain!}` : undefined,
            certDomain: useCustomDomain ? `*.app.${props.customBaseDomain!}` : undefined,
            hostedZone: hostedZone
        });

        // Set the CloudFront distribution for the application site
        this.applicationSiteDistribution = applicationSite.cloudfrontDistribution;
        // Output the repository URL of the application site
        new CfnOutput(this, `ApplicationSiteRepository`, {
            value: applicationSite.repositoryUrl
        });
    }
}
