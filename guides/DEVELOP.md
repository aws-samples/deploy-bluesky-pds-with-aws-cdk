# Development guide

This repository contains a Docker Compose file for starting up the PDS container and the sidecar container locally for testing.

Edit `infra/compose-up.sh` and fill in S3 bucket names and a KMS key ID that can be used for testing.
I do not recommend filling in the buckets and key you intend to use for your production PDS server here!

```bash
cd infra/

# Start it up:
./compose-up.sh

# Shut it down
docker compose down -v
```

## GitHub Actions setup

The "Docker Images Build" CI job pulls base images from Amazon ECR Public.
Anonymous pulls from GitHub-hosted runners are often rate-limited, so the job logs in to ECR Public
when the `ECR_PUBLIC_ROLE_ARN` secret is set. To set it up:

1. Deploy a least-privilege IAM role that GitHub Actions can assume with OIDC.
   If the AWS account already has a GitHub OIDC provider, also pass `OIDCProviderArn=<provider ARN>`.

```bash
aws cloudformation deploy \
    --template-file guides/github-actions-authentication.yaml \
    --stack-name github-bluesky-pds-ci-identity-provider \
    --parameter-overrides GitHubOrg=aws-samples RepositoryName=deploy-bluesky-pds-with-aws-cdk \
    --capabilities CAPABILITY_IAM \
    --region us-east-1

aws cloudformation describe-stacks \
    --stack-name github-bluesky-pds-ci-identity-provider \
    --query "Stacks[0].Outputs[?OutputKey=='Role'].OutputValue" \
    --output text \
    --region us-east-1
```

2. Store the role ARN as a repository secret named `ECR_PUBLIC_ROLE_ARN`, both as an Actions secret
   and as a Dependabot secret, so that Dependabot pull requests can log in too.
   Pull requests from forks don't get secrets, so they keep pulling anonymously.
