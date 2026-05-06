#!/usr/bin/env node
import { App, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import {
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codestarconnections as connections,
  aws_codestarnotifications as notifications,
  aws_codepipeline_actions as actions,
  aws_iam as iam,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";

/**
 * Pipeline that deploys a Bluesky PDS and associated infrastructure.
 * [GitHub source] -> [Deploy CloudFormation stack]
 */
class BlueskyPdsPipelineStack extends Stack {
  constructor(parent: App, name: string, props?: StackProps) {
    super(parent, name, props);

    const artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "clean-up-old-artifacts",
          expiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: "bluesky-pds",
      restartExecutionOnUpdate: true,
      pipelineType: codepipeline.PipelineType.V1,
      artifactBucket,
    });

    new notifications.CfnNotificationRule(this, "PipelineNotifications", {
      name: pipeline.pipelineName,
      detailType: "FULL",
      resource: pipeline.pipelineArn,
      eventTypeIds: ["codepipeline-pipeline-pipeline-execution-failed"],
      targets: [
        {
          targetType: "SNS",
          targetAddress: Stack.of(this).formatArn({
            service: "sns",
            resource: "bluesky-pds-notifications",
          }),
        },
      ],
    });

    // Source
    const sourceOutput = new codepipeline.Artifact("SourceArtifact");
    const githubConnection = new connections.CfnConnection(
      this,
      "GitHubConnection",
      {
        connectionName: "bluesky-pds",
        providerType: "GitHub",
      }
    );
    const sourceAction = new actions.CodeStarConnectionsSourceAction({
      actionName: "GitHubSource",
      owner: "exampleuser",
      repo: "deploy-bluesky-pds-with-aws-cdk",
      branch: "main",
      connectionArn: githubConnection.attrConnectionArn,
      output: sourceOutput,
    });

    pipeline.addStage({
      stageName: "Source",
      actions: [sourceAction],
    });

    // Update pipeline
    // This pipeline stage uses CodeBuild to self-mutate the pipeline by re-deploying the pipeline's CDK code
    // If the pipeline changes, it will automatically start again
    const pipelineProject = new codebuild.PipelineProject(
      this,
      "UpdatePipeline",
      {
        buildSpec: codebuild.BuildSpec.fromObjectToYaml({
          version: "0.2",
          phases: {
            install: {
              "runtime-versions": {
                nodejs: "latest",
              },
              commands: ["npm install -g aws-cdk"],
            },
            build: {
              commands: [
                "cd $CODEBUILD_SRC_DIR/pipeline",
                "npm ci",
                "npm run build",
                `cdk deploy --app 'node pipeline.js' --require-approval=never`,
              ],
            },
          },
        }),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        },
      }
    );
    pipelineProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:*",
          "codebuild:*",
          "codepipeline:*",
          "s3:*",
          "kms:*",
          "codestar-notifications:*",
          "codestar-connections:*",
          "iam:*",
          "events:*",
          "ssm:*",
        ],
        resources: ["*"],
      })
    );
    const pipelineBuildAction = new actions.CodeBuildAction({
      actionName: "DeployPipeline",
      project: pipelineProject,
      input: sourceOutput,
    });
    pipeline.addStage({
      stageName: "SyncPipeline",
      actions: [pipelineBuildAction],
    });

    const deployProject = new codebuild.PipelineProject(this, "DeployProject", {
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": {
              nodejs: "latest",
            },
            commands: ["npm install -g aws-cdk"],
          },
          pre_build: {
            commands: [
              "aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws",
            ],
          },
          build: {
            commands: [
              "cd $CODEBUILD_SRC_DIR/infra",
              "npm ci",
              "npm run build",
              `cdk deploy --app 'node service.js' --require-approval=never`,
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        privileged: true,
      },
    });

    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["*"],
        resources: ["*"],
      })
    );
    const deployAction = new actions.CodeBuildAction({
      actionName: "Deploy",
      project: deployProject,
      input: sourceOutput,
    });
    pipeline.addStage({
      stageName: "Deploy",
      actions: [deployAction],
    });

    const testProject = new codebuild.PipelineProject(this, "TestProject", {
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        "./tests/integ-tests.yaml"
      ),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
    });

    const pdsPassword = secretsmanager.Secret.fromSecretNameV2(
      this,
      "PdsPassword",
      "PdsCredentials"
    );
    pdsPassword.grantRead(testProject);

    const testAction = new actions.CodeBuildAction({
      actionName: "IntegTests",
      project: testProject,
      input: sourceOutput,
    });
    pipeline.addStage({
      stageName: "Tests",
      actions: [testAction],
    });
  }
}

const app = new App();
new BlueskyPdsPipelineStack(app, "BlueskyPdsPipeline", {
  env: { account: process.env["CDK_DEFAULT_ACCOUNT"], region: "us-east-2" },
  tags: {
    project: "bluesky-pds-pipeline",
  },
});
app.synth();
