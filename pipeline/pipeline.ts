#!/usr/bin/env node
import { App, Stack, StackProps } from 'aws-cdk-lib';
import {
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codestarconnections as connections,
  aws_codestarnotifications as notifications,
  aws_codepipeline_actions as actions,
  aws_iam as iam,
} from 'aws-cdk-lib';

/**
 * Pipeline that deploys the Bluesky PDS and associated infrastructure.
 * [GitHub source] -> [Deploy CloudFormation stack]
 */
class BlueskyPdsPipelineStack extends Stack {
  constructor(parent: App, name: string, props?: StackProps) {
    super(parent, name, props);

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'bluesky-pds',
      restartExecutionOnUpdate: true,
    });

    new notifications.CfnNotificationRule(this, 'PipelineNotifications', {
      name: pipeline.pipelineName,
      detailType: 'FULL',
      resource: pipeline.pipelineArn,
      eventTypeIds: ['codepipeline-pipeline-pipeline-execution-failed'],
      targets: [
        {
          targetType: 'SNS',
          targetAddress: Stack.of(this).formatArn({
            service: 'sns',
            resource: 'bluesky-pds-notifications',
          }),
        },
      ],
    });

    // Source
    const sourceOutput = new codepipeline.Artifact('SourceArtifact');
    const githubConnection = new connections.CfnConnection(
      this,
      'GitHubConnection',
      {
        connectionName: 'bluesky-pds',
        providerType: 'GitHub',
      }
    );
    const sourceAction = new actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHubSource',
      owner: 'clareliguori',
      repo: 'bluesky-pds-cdk',
      connectionArn: githubConnection.attrConnectionArn,
      output: sourceOutput,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    // Update pipeline
    // This pipeline stage uses CodeBuild to self-mutate the pipeline by re-deploying the pipeline's CDK code
    // If the pipeline changes, it will automatically start again
    const pipelineProject = new codebuild.PipelineProject(
      this,
      'UpdatePipeline',
      {
        buildSpec: codebuild.BuildSpec.fromObjectToYaml({
          version: '0.2',
          phases: {
            install: {
              'runtime-versions': {
                nodejs: 'latest',
              },
              commands: ['npm install -g aws-cdk'],
            },
            build: {
              commands: [
                'cd $CODEBUILD_SRC_DIR/pipeline',
                'npm ci',
                'npm run build',
                `cdk deploy --app 'node src/pipeline.js' --require-approval=never`,
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
          'cloudformation:*',
          'codebuild:*',
          'codepipeline:*',
          's3:*',
          'kms:*',
          'codestar-notifications:*',
          'codestar-connections:*',
          'iam:*',
          'events:*',
          'ssm:*',
        ],
        resources: ['*'],
      })
    );
    const pipelineBuildAction = new actions.CodeBuildAction({
      actionName: 'DeployPipeline',
      project: pipelineProject,
      input: sourceOutput,
    });
    pipeline.addStage({
      stageName: 'SyncPipeline',
      actions: [pipelineBuildAction],
    });

    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 'latest',
            },
            commands: ['npm install -g aws-cdk'],
          },
          build: {
            commands: [
              'cd $CODEBUILD_SRC_DIR/infra',
              'npm ci',
              'npm run build',
              `cdk deploy --app 'node src/service.js' --require-approval=never`,
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
        actions: ['*'],
        resources: ['*'],
      })
    );
    const deployAction = new actions.CodeBuildAction({
      actionName: 'Deploy',
      project: deployProject,
      input: sourceOutput,
    });
    pipeline.addStage({
      stageName: 'Deploy',
      actions: [deployAction],
    });
  }
}

const app = new App();
new BlueskyPdsPipelineStack(app, 'BlueskyPdsPipelinePipeline', {
  env: { account: process.env['CDK_DEFAULT_ACCOUNT'], region: 'us-east-2' },
  tags: {
    project: 'bluesky-pds',
  },
});
app.synth();