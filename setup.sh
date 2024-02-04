#!/bin/bash
# Bash script for setting up a development environment for AWS EKS
# Installing kubectl
echo "Installing kubectl"
# Downloading kubectl binary from Amazon EKS repository and placing it in /usr/local/bin
 curl --silent --location -o /usr/local/bin/kubectl \
  https://s3.us-west-2.amazonaws.com/amazon-eks/1.24.11/2023-03-17/bin/linux/amd64/kubectl

# Making kubectl binary executable
 chmod +x /usr/local/bin/kubectl

# Upgrading AWS CLI
echo "Upgrading AWS CLI"
# Downloading AWS CLI installer and updating the existing installation
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
 ./aws/install --update

# Installing helper tools
echo "Installing helper tools"
# Installing required tools using yum package manager
 yum -y install jq gettext bash-completion moreutils

# Setting up environment variables
# Retrieving AWS account ID and region
export ACCOUNT_ID=$(aws sts get-caller-identity --output text --query Account)
export AWS_REGION=us-east-1

# Note: some time AWS_REGION variable is not fetch the region with command '$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document | jq -r '.region')' 
# so to solve  this error you need to set AWS_REGION by your own (eg: export AWS_REGION=your region).

export AWS_DEFAULT_REGION=$AWS_REGION
# Printing AWS_REGION if set, otherwise printing a message indicating it's not set
test -n "$AWS_REGION" && echo AWS_REGION is "$AWS_REGION" || echo AWS_REGION is not set
# Adding environment variables to ~/.bash_profile for persistence
echo "export ACCOUNT_ID=${ACCOUNT_ID}" | tee -a ~/.bash_profile
echo "export AWS_REGION=${AWS_REGION}" | tee -a ~/.bash_profile
echo "export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION}" | tee -a ~/.bash_profile
# Configuring default AWS region
aws configure set default.region ${AWS_REGION}
aws configure get default.region

# Installing eksctl
echo "Installing eksctl"
# Downloading eksctl binary and moving it to /usr/local/bin
curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" | tar xz -C /tmp
 mv -v /tmp/eksctl /usr/local/bin

# Installing bash completion for eksctl
echo "Installing bash completion for eksctl"
# Configuring bash completion for eksctl
eksctl completion bash >> ~/.bash_completion
. /etc/profile.d/bash_completion.sh
. ~/.bash_completion

# Installing Helm
echo "Installing helm"
# Downloading and running Helm installation script
curl -sSL https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | bash

# Setting up yq function
echo 'yq() {
  docker run --rm -i -v "${PWD}":/workdir mikefarah/yq yq "$@"
}' | tee -a ~/.bashrc && source ~/.bashrc

# Checking for command availability
for command in kubectl jq envsubst aws
do
  which $command &>/dev/null && echo "$command in path" || echo "$command NOT FOUND"
done

# Configuring bash completion for kubectl
kubectl completion bash >>  ~/.bash_completion
. /etc/profile.d/bash_completion.sh
. ~/.bash_completion

# Checking IAM role validity for EKS setup
aws sts get-caller-identity --query Arn | grep eks-ref-arch-admin -q && echo "IAM role valid. You can continue setting up the EKS Cluster." || echo "IAM role NOT valid. Do not proceed with creating the EKS Cluster or you won't be able to authenticate. Ensure you assigned the role to your EC2 instance as detailed in the README.md of the eks-saas repo"
