// Import necessary modules
import { Construct } from "constructs";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

// Define properties interface for ApplicationService
export interface ApplicationServiceProps {
    readonly name: string; // Name of the service
    readonly assetDirectory: string; // Directory containing the service assets
    readonly ecrImageName: string; // Name of the ECR image
    readonly eksClusterName: string; // Name of the EKS cluster
    readonly codebuildKubectlRole: iam.IRole; // IAM role for CodeBuild with kubectl permissions
    readonly internalApiDomain: string; // Internal API domain
    readonly serviceUrlPrefix: string; // Prefix for service URLs
    readonly defaultBranchName?: string; // Optional default branch name for the repository
}

// Define ApplicationService class
export class ApplicationService extends Construct {

    readonly codeRepositoryUrl: string; // URL of the code repository

    constructor(scope: Construct, id: string, props: ApplicationServiceProps) {
        super(scope, id);

        // Set default branch name or use "main" as default
        const defaultBranchName = props.defaultBranchName ?? "main";

        // Create CodeCommit repository for the service
        const sourceRepo = new codecommit.Repository(this, `${id}Repository`, {
            repositoryName: props.name,
            description: `Repository with code for ${props.name}`,
            code: codecommit.Code.fromDirectory(props.assetDirectory, defaultBranchName)
        });
        this.codeRepositoryUrl = sourceRepo.repositoryCloneUrlHttp; // Get the repository URL

        // Create ECR repository for the service's container image
        const containerRepo = new ecr.Repository(this, `${id}ECR`, {
            repositoryName: props.ecrImageName,
            imageScanOnPush: true,
            imageTagMutability: ecr.TagMutability.MUTABLE,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // Configure deletion of ECR repository using a custom resource
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
                // Define environment variables for the build
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
                },
                SERVICE_URL_PREFIX: {
                    value: props.serviceUrlPrefix
                }
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                // Define build specification
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            // Commands to install necessary tools
                            `export API_HOST=$(echo '${props.internalApiDomain || ""}' | awk '{print tolower($0)}')`,
                            'export IMAGE_TAG=$CODEBUILD_RESOLVED_SOURCE_VERSION',
                            'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
                            'chmod +x ./kubectl',
                        ]
                    },
                    pre_build: {
                        commands: [
                            // Commands to authenticate Docker with ECR
                            'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI',
                            'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws',
                        ],
                    },
                    build: {
                        commands: [
                            // Commands to build and push Docker image to ECR
                            "docker build -t $SEVICE_IMAGE_NAME:$IMAGE_TAG .",
                            "docker tag $SEVICE_IMAGE_NAME:$IMAGE_TAG $ECR_REPO_URI:latest",
                            "docker tag $SEVICE_IMAGE_NAME:$IMAGE_TAG $ECR_REPO_URI:$IMAGE_TAG",
                            "docker push $ECR_REPO_URI:latest",
                            "docker push $ECR_REPO_URI:$IMAGE_TAG",
                        ],
                    },
                    post_build: {
                        commands: [
                            // Commands to update kubeconfig and apply Kubernetes manifests
                            "aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME",
                            'echo "  newName: $ECR_REPO_URI" >> kubernetes/kustomization.yaml',
                            'echo "  newTag: $IMAGE_TAG" >> kubernetes/kustomization.yaml',
                            'echo "  value: $API_HOST" >> kubernetes/host-patch.yaml',
                            "for res in `kubectl get ns -l saas/tenant=true -o jsonpath='{.items[*].metadata.name}'`; do \
                            cp kubernetes/svc-acc-patch-template.yaml kubernetes/svc-acc-patch.yaml && \
                            cp kubernetes/path-patch-template.yaml kubernetes/path-patch.yaml && \
                            echo \"  value: $res-service-account\" >> kubernetes/svc-acc-patch.yaml && \
                            echo \"  value: /$res/$SERVICE_URL_PREFIX\" >> kubernetes/path-patch.yaml && \
                            kubectl apply -k kubernetes/ -n $res && \
                            rm kubernetes/path-patch.yaml && rm kubernetes/svc-acc-patch.yaml; done"
                        ]
                    },
                },
            }),
        });

        // Trigger CodeBuild project on commit to CodeCommit repository
        sourceRepo.onCommit('OnCommit', {
            target: new targets.CodeBuildProject(project),
            branches: [
                defaultBranchName
            ]
        });

        // Grant permissions to CodeBuild project to pull from CodeCommit and push to ECR
        sourceRepo.grantPull(project.role!);
        containerRepo.grantPullPush(project.role!);

        // Create a custom resource to trigger the initial build when the repository is created
        const buildTriggerResource = new cr.AwsCustomResource(this, "ApplicationSvcIntialBuild", {
            onCreate: {
                service: "CodeBuild",
                action: "startBuild",
                parameters: {
                    projectName: project.projectName,
                },
                physicalResourceId: cr.PhysicalResourceId.of(`InitialAppSvcDeploy-${props.name}`),
                outputPaths: ["build.id", "build.buildNumber"]
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [project.projectArn] }),
        });
        buildTriggerResource.node.addDependency(project);

        // Create CodeBuild project for deploying to tenant namespaces
        const tenantDeployProject = new codebuild.Project(this, `${id}EKSTenantDeployProject`, {
            projectName: `${props.name}TenantDeploy`,
            source: codebuild.Source.codeCommit({ repository: sourceRepo }),
            role: props.codebuildKubectlRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
            },
            environmentVariables: {
                // Define environment variables for tenant deployment
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
                },
                SERVICE_URL_PREFIX: {
                    value: props.serviceUrlPrefix
                },
                TENANT_ID: {
                    value: ""
                }
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                // Define build specification for tenant deployment
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            // Commands to install necessary tools
                            `export API_HOST=$(echo '${props.internalApiDomain || ""}' | awk '{print tolower($0)}')`,
                            'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
                            'chmod +x ./kubectl',
                        ]
                    },
                    build: {
                        commands: [
                            // Commands to update kubeconfig and apply Kubernetes manifests for tenant deployment
                            "aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME",
                            'echo "  newName: $ECR_REPO_URI" >> kubernetes/kustomization.yaml',
                            'echo "  newTag: latest" >> kubernetes/kustomization.yaml',
                            'echo "  value: $API_HOST" >> kubernetes/host-patch.yaml',
                            'cp kubernetes/path-patch-template.yaml kubernetes/path-patch.yaml',
                            "echo \"  value: /$TENANT_ID/$SERVICE_URL_PREFIX\" >> kubernetes/path-patch.yaml",
                            'cp kubernetes/svc-acc-patch-template.yaml kubernetes/svc-acc-patch.yaml',
                            `echo "  value: $TENANT_ID-service-account" >> kubernetes/svc-acc-patch.yaml`,
                            "kubectl apply -k kubernetes/ -n $TENANT_ID",
                        ],
                    },
                },
            }),
        });

        // Grant permissions to CodeBuild project for tenant deployment
        sourceRepo.grantPull(tenantDeployProject.role!);
        containerRepo.grantPull(tenantDeployProject.role!);
    }
}
