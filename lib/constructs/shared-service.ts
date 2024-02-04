// Import necessary modules
import { Construct } from "constructs";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

// Define properties interface for SharedService
export interface SharedServiceProps {
    readonly name: string; // Name of the shared service
    readonly assetDirectory: string; // Directory containing the service assets
    readonly ecrImageName: string; // Name of the ECR image
    readonly eksClusterName: string; // Name of the EKS cluster
    readonly internalApiDomain: string; // Internal API domain
    readonly sharedServiceAccountName: string; // Name of the shared service account
    readonly codebuildKubectlRole: iam.IRole; // IAM role for CodeBuild

    readonly defaultBranchName?: string; // Default branch name (optional)
}

// Define SharedService class
export class SharedService extends Construct {
    readonly codeRepositoryUrl: string; // URL of the code repository

    constructor(scope: Construct, id: string, props: SharedServiceProps) {
        super(scope, id);

        // Set default branch name if not provided
        const defaultBranchName = props.defaultBranchName ?? "main";

        // Create CodeCommit repository
        const sourceRepo = new codecommit.Repository(this, `${id}Repository`, {
            repositoryName: props.name,
            description: `Repository with code for ${props.name}`,
            code: codecommit.Code.fromDirectory(props.assetDirectory, defaultBranchName)
        });
        sourceRepo.applyRemovalPolicy(RemovalPolicy.DESTROY); // Ensure repository is destroyed when stack is deleted
        this.codeRepositoryUrl = sourceRepo.repositoryCloneUrlHttp; // Set repository URL

        // Create ECR repository
        const containerRepo = new ecr.Repository(this, `${id}ECR`, {
            repositoryName: props.ecrImageName,
            imageScanOnPush: true,
            imageTagMutability: ecr.TagMutability.MUTABLE,
            removalPolicy: RemovalPolicy.RETAIN, // Retain repository data after deletion for custom cleanup
        });

        // Create custom resource for deleting ECR repository
        new cr.AwsCustomResource(this, "ECRRepoDeletion", {
            onDelete: {
                service: 'ECR',
                action: 'deleteRepository',
                parameters: {
                    repositoryName: containerRepo.repositoryName,
                    force: true
                },
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [containerRepo.repositoryArn] }),
        });

        // Create CodeBuild project for deploying to EKS
        const project = new codebuild.Project(this, `${id}EKSDeployProject`, {
            projectName: `${props.name}`,
            source: codebuild.Source.codeCommit({ repository: sourceRepo }),
            role: props.codebuildKubectlRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
                privileged: true
            },
            environmentVariables: {
                CLUSTER_NAME: {
                    value: `${props.eksClusterName}`,
                },
                ECR_REPO_URI: {
                    value: `${containerRepo.repositoryUri}`,
                },
                AWS_REGION: {
                    value: Stack.of(this).region
                },
                AWS_ACCOUNT: {
                    value: Stack.of(this).account
                },
                SEVICE_IMAGE_NAME: {
                    value: props.ecrImageName
                }
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            `export API_HOST=$(echo '${props.internalApiDomain || ""}' | awk '{print tolower($0)}')`,
                            'export IMAGE_TAG=$CODEBUILD_RESOLVED_SOURCE_VERSION',
                            'echo $IMAGE_TAG',
                            'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
                            'chmod +x ./kubectl',
                        ]
                    },
                    pre_build: {
                        commands: [
                            'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI',
                            'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws',
                        ],
                    },
                    build: {
                        commands: [
                            "docker build -t $SEVICE_IMAGE_NAME:$IMAGE_TAG .",
                            "docker tag $SEVICE_IMAGE_NAME:$IMAGE_TAG $ECR_REPO_URI:latest",
                            "docker tag $SEVICE_IMAGE_NAME:$IMAGE_TAG $ECR_REPO_URI:$IMAGE_TAG",
                            "docker push $ECR_REPO_URI:latest",
                            "docker push $ECR_REPO_URI:$IMAGE_TAG",
                        ],
                    },
                    post_build: {
                        commands: [
                            "aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME",
                            'echo "  value: $API_HOST" >> kubernetes/host-patch.yaml',
                            `echo "  value: ${props.sharedServiceAccountName}" >> kubernetes/svc-acc-patch.yaml`,
                            'echo "  newName: $ECR_REPO_URI" >> kubernetes/kustomization.yaml',
                            'echo "  newTag: $IMAGE_TAG" >> kubernetes/kustomization.yaml',
                            "kubectl apply -k kubernetes/"
                        ]
                    },
                },
            }),
        });

        // Trigger build on commit
        sourceRepo.onCommit("OnCommit", {
            target: new targets.CodeBuildProject(project),
            branches: [
                defaultBranchName
            ]
        });

        // Grant permissions
        sourceRepo.grantPull(project.role!);
        containerRepo.grantPullPush(project.role!);

        // Create custom resource to trigger initial build
        const buildTriggerResource = new cr.AwsCustomResource(this, "SharedSvcIntialBuild", {
            onCreate: {
                service: "CodeBuild",
                action: "startBuild",
                parameters: {
                    projectName: project.projectName,
                },
                physicalResourceId: cr.PhysicalResourceId.of(`InitialSharedSvcDeploy-${props.name}`),
                outputPaths: ["build.id", "build.buildNumber"]
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [project.projectArn] }),
        });
        buildTriggerResource.node.addDependency(project);
    }
}
