// Import necessary modules from the AWS CDK library
import { Arn, CfnJson, Duration, Stack, StackProps } from 'aws-cdk-lib';
// Import modules for specific AWS services
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
// Import the Construct class from 'constructs' module
import { Construct } from 'constructs';
// Import modules for Amazon EKS (Elastic Kubernetes Service)
import * as eks from 'aws-cdk-lib/aws-eks';

// Import YAML, fs, and path modules for file operations
import * as YAML from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

// Define interface for EKSClusterStack properties, extending StackProps
export interface EKSClusterStackProps extends StackProps {
    readonly clusterName: string; // Cluster name
    readonly tenantOnboardingProjectName: string; // Name of project for tenant onboarding
    readonly tenantDeletionProjectName: string; // Name of project for tenant deletion
    readonly ingressControllerName: string; // Name of ingress controller
    readonly sharedServiceAccountName: string; // Name of shared service account
    readonly kubecostToken?: string; // Optional Kubecost token
    readonly customDomain?: string; // Optional custom domain
    readonly hostedZoneId?: string; // Optional hosted zone ID
}

// Define the EKSClusterStack class, extending Stack
export class EKSClusterStack extends Stack {

    // Declare class properties
    readonly codebuildKubectlRoleArn: string; // ARN of the CodeBuild Kubectl role
    readonly vpc: ec2.Vpc; // VPC
    readonly openIdConnectProviderArn: string; // ARN of the OpenID Connect provider
    readonly nlbDomain: string; // NLB (Network Load Balancer) domain

    // Constructor method
    constructor(scope: Construct, id: string, props: EKSClusterStackProps) {
        // Call the constructor of the base class (Stack)
        super(scope, id, props);

        // Create a VPC
        this.vpc = new ec2.Vpc(this, "EKSVpc", {
            cidr: "192.168.0.0/16",
            maxAzs: 2,
            vpcName: "EKS SaaS Vpc",
        });

        // Create security groups for control plane and node instances
        const ctrlPlaneSecurityGroup = new ec2.SecurityGroup(this, "ControlPlaneSecurityGroup", {
            vpc: this.vpc,
            allowAllOutbound: false,
            securityGroupName: "eks-saas-ctrl-plane-security-group",
            description: "EKS SaaS control plane security group with recommended traffic rules"
        });
        const nodeSecurityGroup = new ec2.SecurityGroup(this, "NodeSecurityGroup", {
            vpc: this.vpc,
            allowAllOutbound: true,
            securityGroupName: "eks-saas-mng-node-security-group",
            description: "EKS SaaS node group security group with recommended traffic rules + NLB target group health check access"
        });

        // Configure security group rules
        ctrlPlaneSecurityGroup.addIngressRule(nodeSecurityGroup, ec2.Port.tcp(443));
        ctrlPlaneSecurityGroup.addEgressRule(nodeSecurityGroup, ec2.Port.tcp(443)); // needed for nginx-ingress admission controller
        ctrlPlaneSecurityGroup.addEgressRule(nodeSecurityGroup, ec2.Port.tcpRange(1025, 65535));

        nodeSecurityGroup.addIngressRule(nodeSecurityGroup, ec2.Port.allTraffic());
        nodeSecurityGroup.addIngressRule(ctrlPlaneSecurityGroup, ec2.Port.tcp(443));
        nodeSecurityGroup.addIngressRule(ctrlPlaneSecurityGroup, ec2.Port.tcpRange(1025, 65535));
        nodeSecurityGroup.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcpRange(1025, 65535), "Needed for the NLB target group health checks");

        // Create an IAM role for cluster admin
        const clusterAdmin = new iam.Role(this, 'AdminRole', {
            assumedBy: new iam.AccountRootPrincipal(),
        });

        // Create the EKS cluster
        const cluster = new eks.Cluster(this, "SaaSCluster", {
            version: eks.KubernetesVersion.V1_27,
            mastersRole: clusterAdmin,
            clusterName: props.clusterName,
            defaultCapacity: 0,
            vpc: this.vpc,
            vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_NAT }],
            securityGroup: ctrlPlaneSecurityGroup,
        });

        // Create a role for the VPC CNI service account
        const vpcCniSvcAccountRole = new iam.Role(this, 'VpcCniSvcAccountRole', {
            assumedBy: new iam.OpenIdConnectPrincipal(cluster.openIdConnectProvider).withConditions({
                StringEquals: new CfnJson(this, 'VpcCniSvcAccountRoleCondition', {
                    value: {
                        [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]: "sts.amazonaws.com",
                        [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]: "system:serviceaccount:kube-system:aws-node"
                    },
                }),
            }),
        });
        vpcCniSvcAccountRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKS_CNI_Policy"));

        // Add the VPC CNI plugin
        const vpcCniPlugin = new eks.CfnAddon(this, "VpcCniPlugin", {
            addonName: "vpc-cni",
            clusterName: props.clusterName,
            resolveConflicts: "OVERWRITE",
            serviceAccountRoleArn: vpcCniSvcAccountRole.roleArn
        });

        // Create a role for the EKS node instances
        const nodeRole = new iam.Role(this, "EKSNodeRole", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com")
        });
        this.addNodeIAMRolePolicies(nodeRole);

        // Create a launch template for node instances
        const nodeLaunchTemplate = new ec2.LaunchTemplate(this, "saas-mng-lt", {
            securityGroup: nodeSecurityGroup,
        });

        // Add a node group to the cluster
        const nodegroup = cluster.addNodegroupCapacity("saas-mng", {
            nodegroupName: "saas-managed-nodegroup",
            amiType: eks.NodegroupAmiType.AL2_X86_64,
            capacityType: eks.CapacityType.ON_DEMAND,
            nodeRole: nodeRole,
            minSize: 1,
            desiredSize: 2,
            maxSize: 4,
            instanceTypes: [new ec2.InstanceType("m5.large")],
            subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
            launchTemplateSpec: {
                id: nodeLaunchTemplate.launchTemplateId!
            },
        });
        nodegroup.node.addDependency(vpcCniPlugin);

        // Create a role for CodeBuild with permissions to interact with EKS
        const codebuildKubectlRole = new iam.Role(this, "CodebuildKubectlRole", {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal("codebuild.amazonaws.com"),
                new iam.AccountRootPrincipal(),
            )
        });
        codebuildKubectlRole.addToPolicy(new iam.PolicyStatement({
            actions: ["eks:DescribeCluster"],
            resources: [cluster.clusterArn],
            effect: iam.Effect.ALLOW
        }));
        codebuildKubectlRole.addToPolicy(new iam.PolicyStatement({
            actions: ["ecr-public:GetAuthorizationToken"],
            resources: ['*'],
            effect: iam.Effect.ALLOW
        }));
        codebuildKubectlRole.addToPolicy(new iam.PolicyStatement({
            actions: ["sts:GetServiceBearerToken"],
            resources: ['*'],
            effect: iam.Effect.ALLOW
        }));
        cluster.awsAuth.addMastersRole(codebuildKubectlRole);

        this.codebuildKubectlRoleArn = codebuildKubectlRole.roleArn;
        this.openIdConnectProviderArn = cluster.openIdConnectProvider.openIdConnectProviderArn;

        // Add shared services permissions
        this.addSharedServicesPermissions(cluster, props);

        // Add nginx-ingress
        const nginxValues = fs.readFileSync(path.join(__dirname, "..", "resources", "nginx-ingress-config.yaml"), "utf8")
        const nginxValuesAsRecord = YAML.load(nginxValues) as Record<string, any>;

        const nginxChart = cluster.addHelmChart('IngressController', {
            chart: 'nginx-ingress',
            repository: 'https://helm.nginx.com/stable',
            release: props.ingressControllerName,
            values: {
                controller: {
                    publishService: {
                        enabled: true,
                    },
                    service: {
                        annotations: {
                            'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
                            'service.beta.kubernetes.io/aws-load-balancer-backend-protocol': 'http',
                            'service.beta.kubernetes.io/aws-load-balancer-ssl-ports': '443',
                            'service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout': '3600',
                        },
                        targetPorts: {
                            https: 'http',
                        },
                    },
                },
            },
        });

        nginxChart.node.addDependency(nodegroup);

        this.nlbDomain = new eks.KubernetesObjectValue(this, 'elbAddress', {
            cluster,
            objectType: 'Service',
            objectName: `${props.ingressControllerName}-nginx-ingress-controller`,
            jsonPath: '.status.loadBalancer.ingress[0].hostname',
        }).value;

        // Add primary mergable ingress (for host collision)
        new eks.KubernetesManifest(this, "PrimarySameHostMergableIngress", {
            cluster: cluster,
            overwrite: true,
            manifest: [{
                "apiVersion": "networking.k8s.io/v1",
                "kind": "Ingress",
                "metadata": {
                    "name": "default-primary-mergable-ingress",
                    "namespace": "default",
                    "annotations": {
                        "kubernetes.io/ingress.class": "nginx",
                        "nginx.org/mergeable-ingress-type": "master"
                    }
                },
                "spec": {
                    "rules": [
                        {
                            "host": this.nlbDomain,
                        }
                    ]
                }
            }]
        });
    }

    // Method to add IAM role policies for EKS node instances
    private addNodeIAMRolePolicies(eksNodeRole: iam.Role): void {
        eksNodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSWorkerNodePolicy"));
        eksNodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"));
        eksNodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));
    }

    // Method to add permissions for shared services
    private addSharedServicesPermissions(cluster: eks.Cluster, props: EKSClusterStackProps) {
        const sharedServiceAccount = cluster.addServiceAccount("SaaSServiceAccount", {
            name: props.sharedServiceAccountName,
            namespace: "default",
        });

        sharedServiceAccount.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "dynamodb:GetItem",
                "dynamodb:BatchGetItem",
                "dynamodb:Query",
                "dynamodb:Scan",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:DeleteItem",
                "dynamodb:BatchWriteItem"
            ],
            resources: [
                Arn.format({ service: "dynamodb", resource: "table", resourceName: "Tenant" }, this),
            ],
            effect: iam.Effect.ALLOW
        }));
        sharedServiceAccount.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ["codebuild:StartBuild"],
            resources: [
                Arn.format({ service: "codebuild", resource: "project", resourceName: props.tenantOnboardingProjectName }, this),
                Arn.format({ service: "codebuild", resource: "project", resourceName: props.tenantDeletionProjectName }, this),
            ],
            effect: iam.Effect.ALLOW
        }));
        sharedServiceAccount.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "cognito-idp:ListUsers"
            ],
            resources: [
                Arn.format({ service: "cognito-idp", resource: "userpool", resourceName: "*" }, this),
            ],
            effect: iam.Effect.ALLOW
        }));
    }
}
