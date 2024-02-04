// Import necessary modules
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito'

// Define properties interface for Cognito
export interface CognitoProps {
    readonly adminUserEmailAddress: string; // Email address of the admin user
    readonly userPoolName: string; // Name of the user pool

    readonly customAttributes?: { [key: string]: { value: boolean | number | string, mutable: boolean } }; // Custom attributes for the user pool
    readonly callbackUrl?: string; // Callback URL for OAuth
    readonly signoutUrl?: string; // Sign-out URL for OAuth
    readonly inviteEmailSubject?: string; // Subject for invitation email
    readonly inviteEmailBody?: string; // Body for invitation email
}

// Define Cognito class
export class Cognito extends Construct {
    readonly appClientId: string; // Client ID of the user pool client
    readonly authServerUrl: string; // URL of the authentication server
    readonly userPoolId: string; // ID of the user pool

    constructor(scope: Construct, id: string, props: CognitoProps) {
        super(scope, id);

        // Extract callback and sign-out URLs if provided
        const callbackUrls = props.callbackUrl ? [props.callbackUrl!] : undefined;
        const signoutUrls = props.signoutUrl ? [props.signoutUrl!] : undefined;

        // Map custom attributes to Cognito attribute types
        let customAttributes: { [key: string]: cognito.ICustomAttribute } | undefined = undefined;
        if (props.customAttributes) {
            customAttributes = {};
            Object.keys(props.customAttributes!).forEach(key => {
                const item = props.customAttributes![key];
                switch (typeof (item.value)) {
                    case "boolean":
                        customAttributes![key] = new cognito.BooleanAttribute({ mutable: item.mutable });
                        break;
                    case "number":
                        customAttributes![key] = new cognito.NumberAttribute({ mutable: item.mutable });
                        break;
                    case "string":
                        customAttributes![key] = new cognito.StringAttribute({ mutable: item.mutable });
                        break;
                }
            });
        }

        // Create user pool
        const userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: props.userPoolName,
            selfSignUpEnabled: false,
            userInvitation: {
                emailBody: props.inviteEmailBody,
                emailSubject: props.inviteEmailSubject
            },
            passwordPolicy: {
                minLength: 8,
                requireDigits: true,
                requireLowercase: true,
                requireUppercase: true,
                requireSymbols: false,
                tempPasswordValidity: Duration.days(7),
            },
            signInAliases: {
                email: true,
                username: false
            },
            autoVerify: {
                email: true
            },
            customAttributes: customAttributes,
            accountRecovery: cognito.AccountRecovery.NONE,
            mfa: cognito.Mfa.OFF,
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.userPoolId = userPool.userPoolId;

        // Create user pool client
        const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
            userPool: userPool,
            disableOAuth: false,
            oAuth: {
                flows: {
                    clientCredentials: false,
                    implicitCodeGrant: true,
                    authorizationCodeGrant: true
                },
                scopes: [
                    cognito.OAuthScope.PHONE,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE
                ],
                callbackUrls: callbackUrls,
                logoutUrls: signoutUrls,
            },
            generateSecret: false,
            authFlows: {
                adminUserPassword: true,
                custom: true,
                userPassword: true,
                userSrp: true,
            },
            preventUserExistenceErrors: true,
            refreshTokenValidity: Duration.days(30),
            supportedIdentityProviders: [
                cognito.UserPoolClientIdentityProvider.COGNITO
            ]
        });

        // Set client ID and authentication server URL
        this.appClientId = userPoolClient.userPoolClientId;
        this.authServerUrl = userPool.userPoolProviderUrl;

        // Add a domain to the user pool client
        userPool.addDomain(`${id}-Domain`, {
            cognitoDomain: {
                domainPrefix: this.appClientId
            }
        });

        // Define user attributes for the admin user
        const userAttributes = [
            { name: "email", value: props.adminUserEmailAddress },
            { name: "email_verified", value: "true" }
        ];

        // Add custom attributes to user attributes
        if (props.customAttributes) {
            Object.keys(props.customAttributes!).forEach(key => {
                userAttributes.push({ name: `custom:${key}`, value: props.customAttributes![key].value.toString() });
            })
        }

        // Create admin user
        const admin = new cognito.CfnUserPoolUser(this, 'AdminUser', {
            userPoolId: userPool.userPoolId,
            username: props.adminUserEmailAddress,
            userAttributes: userAttributes,
            desiredDeliveryMediums: [
                "EMAIL"
            ],
            forceAliasCreation: true
        });
    }
}
