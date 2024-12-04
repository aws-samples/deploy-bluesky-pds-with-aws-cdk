#!/usr/bin/env node
import {
  App,
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_ecs_patterns as patterns,
  aws_elasticloadbalancingv2 as elb,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';

enum Mode {
  PROD = 'Production',
  TEST = 'Test',
}

interface BlueskyPdsInfraStackProps extends StackProps {
  domainName: string;
  domainZone: string;
  rootDomain: string;
  mode: Mode;
}

class BlueskyPdsInfraStack extends Stack {
  constructor(parent: App, name: string, props: BlueskyPdsInfraStackProps) {
    super(parent, name, props);

    // TODO add a 'production' mode for the template
    // that removes all the 'DESTROY' removal policies,
    // so that a production stack doesn't lose data
    // It's nice for testing to wipe everything clean.

    // Network infrastructure
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: props.domainName.replace(/\./g, '-'),
      vpc,
    });
    const domainZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.domainZone,
    });

    // Resources for the PDS application
    const adminPassword = new secretsmanager.Secret(this, 'AdminPassword', {
      generateSecretString: {
        passwordLength: 16,
      },
    });
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      generateSecretString: {
        passwordLength: 16,
      },
    });
    const rotationKey = new kms.Key(this, 'RotationKey', {
      keySpec: kms.KeySpec.ECC_SECG_P256K1,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    // TODO mechanism for rotating the password, JWT, and rotation key

    const blobBucket = new s3.Bucket(this, 'BlobStorage', {
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      autoDeleteObjects: props.mode === Mode.TEST,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    const dataBackupBucket = new s3.Bucket(this, 'DataBackupStorage', {
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      autoDeleteObjects: props.mode === Mode.TEST,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // Control access to the buckets
    const s3Endpoint = vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    const s3EndpointPolicy = new iam.PolicyStatement({
      actions: ['s3:*'],
      effect: iam.Effect.ALLOW,
      principals: [new iam.AnyPrincipal()],
      resources: [
        // Only these buckets can be accessed within the VPC
        blobBucket.bucketArn,
        blobBucket.arnForObjects('*'),
        dataBackupBucket.bucketArn,
        dataBackupBucket.arnForObjects('*'),
        // ECR
        `arn:${this.partition}:s3:::prod-${this.region}-starport-layer-bucket`,
        `arn:${this.partition}:s3:::prod-${this.region}-starport-layer-bucket/*`,
      ],
    });
    s3Endpoint.addToPolicy(s3EndpointPolicy);

    // In production mode, enforce that access to objects is only through the VPC endpoint
    if (props.mode === Mode.PROD) {
      const s3BucketPolicy = new iam.PolicyStatement({
        actions: [
          's3:GetObject*',
          's3:DeleteObject*',
          's3:PutObject*',
          's3:Abort*',
        ],
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        resources: ['*'],
        conditions: {
          StringNotEquals: {
            'aws:sourceVpce': s3Endpoint.vpcEndpointId,
          },
        },
      });
      blobBucket.addToResourcePolicy(s3BucketPolicy);
      dataBackupBucket.addToResourcePolicy(s3BucketPolicy);
    }

    // ECR pull-through cache for the PDS image on GHCR
    const githubSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GitHubToken',
      'ecr-pullthroughcache/bluesky-pds-image-github-token'
    );
    new ecr.CfnPullThroughCacheRule(this, 'ContainerImagePullThroughCache', {
      credentialArn: githubSecret.secretArn,
      ecrRepositoryPrefix: 'github-bluesky',
      upstreamRegistryUrl: 'ghcr.io',
    });
    const cacheRepo = new ecr.Repository(this, 'CacheRepo', {
      repositoryName: 'github-bluesky/bluesky-social/pds',
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      emptyOnDelete: true,
    });
    const image = ecs.ContainerImage.fromEcrRepository(cacheRepo, '0.4');

    // Fargate service + load balancer to run PDS container image
    const service = new patterns.ApplicationLoadBalancedFargateService(
      this,
      'Service',
      {
        cluster,
        serviceName: props.domainName.replace(/\./g, '-'),
        desiredCount: 1,
        domainName: props.domainName,
        domainZone,
        protocol: ApplicationProtocol.HTTPS,
        redirectHTTP: true,
        assignPublicIp: true,
        propagateTags: ecs.PropagatedTagSource.SERVICE,
        // PDS server configuration
        taskImageOptions: {
          containerName: 'pds',
          image,
          containerPort: 3000,
          logDriver: ecs.LogDriver.awsLogs({
            streamPrefix: 'PDSService',
            logGroup: new logs.LogGroup(this, 'ServiceLogGroup', {
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy:
                props.mode === Mode.TEST
                  ? RemovalPolicy.DESTROY
                  : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
            }),
          }),
          environment: {
            // TODO OAuth config
            PDS_HOSTNAME: props.domainName,
            PDS_PORT: '3000',
            PDS_DATA_DIRECTORY: '/pds',
            PDS_PLC_ROTATION_KEY_KMS_KEY_ID: rotationKey.keyId,
            AWS_REGION: this.region,
            AWS_DEFAULT_REGION: this.region,
            PDS_BLOBSTORE_S3_BUCKET: blobBucket.bucketName,
            PDS_BLOBSTORE_S3_REGION: this.region,
            PDS_BLOBSTORE_DISK_LOCATION: '',
            PDS_BLOB_UPLOAD_LIMIT: '52428800',
            PDS_DID_PLC_URL: 'https://plc.directory',
            PDS_BSKY_APP_VIEW_URL: 'https://api.bsky.app',
            PDS_BSKY_APP_VIEW_DID: 'did:web:api.bsky.app',
            PDS_REPORT_SERVICE_URL: 'https://mod.bsky.app',
            PDS_REPORT_SERVICE_DID: 'did:plc:ar7c4by46qjdydhdevvrndac',
            PDS_CRAWLERS: 'https://bsky.network',
            PDS_SERVICE_HANDLE_DOMAINS: '.' + props.rootDomain,
            LOG_ENABLED: 'true',
          },
          secrets: {
            PDS_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword),
            PDS_JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
          },
        },
        healthCheck: {
          command: [
            'CMD-SHELL',
            "node -e 'fetch(`http://localhost:3000/xrpc/_health`).then(()=>process.exitCode = 0).catch(()=>process.exitCode = 1)'",
          ],
        },
        // PDS min system requirements: 1 CPU core, 1 GB memory, 20 GB disk
        cpu: 1024,
        memoryLimitMiB: 2048, // lowest mem value allowed in Fargate for 1 CPU
        // Only let 1 PDS instance run at a time.
        // Deployments will take down the old task before starting a new one
        maxHealthyPercent: 100,
        minHealthyPercent: 0,
        circuitBreaker: {
          enable: true,
          rollback: true,
        },
        // Enable running pdsadmin in the container
        enableExecuteCommand: true,
      }
    );

    service.targetGroup.configureHealthCheck({
      path: '/xrpc/_health',
    });

    // Add sidecar container that backs up and restores the PDS data to/from S3
    const sidecar = service.taskDefinition.addContainer('SyncContainer', {
      containerName: 's3_sync',
      image: ecs.ContainerImage.fromAsset('./pds-data-backup', {
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'PDSS3Sync',
        logGroup: new logs.LogGroup(this, 'PDSS3SyncLogGroup', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy:
            props.mode === Mode.TEST
              ? RemovalPolicy.DESTROY
              : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        }),
      }),
      environment: {
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        S3_PATH: `s3://${dataBackupBucket.bucketName}/pds-backup`,
        LOCAL_PATH: '/sync',
      },
      healthCheck: {
        command: ['CMD', '/healthcheck.sh'],
      },
      stopTimeout: Duration.minutes(1),
    });

    // Create a volume for the PDS data
    service.taskDefinition.addVolume({
      name: 'pds-data',
      host: {},
    });
    sidecar.addMountPoints({
      containerPath: '/sync',
      readOnly: false,
      sourceVolume: 'pds-data',
    });
    service.taskDefinition.findContainer('pds')!.addMountPoints({
      containerPath: '/pds',
      readOnly: false,
      sourceVolume: 'pds-data',
    });

    // Ensure that databases have been restored in the sidecar container before starting PDS
    service.taskDefinition.findContainer('pds')!.addContainerDependencies({
      container: sidecar,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    // Grant ECR pull-through cache permissions
    service.service.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchImportUpstreamImage'],
        resources: [cacheRepo.repositoryArn],
      })
    );

    // Permissions needed by containers
    dataBackupBucket.grantReadWrite(service.service.taskDefinition.taskRole);
    blobBucket.grantReadWrite(service.service.taskDefinition.taskRole);
    rotationKey.grant(
      service.service.taskDefinition.taskRole,
      'kms:GetPublicKey',
      'kms:Sign'
    );

    // Alarms
    const topic = sns.Topic.fromTopicArn(
      this,
      'AlarmTopic',
      Stack.of(this).formatArn({
        service: 'sns',
        resource: 'bluesky-pds-notifications',
        arnFormat: ArnFormat.NO_RESOURCE_NAME,
      })
    );

    const unhealthyAlarm = new cloudwatch.Alarm(
      this,
      'TargetGroupUnhealthyHosts',
      {
        alarmName: this.stackName + '-Unhealthy-Hosts',
        metric: service.targetGroup.metrics.unhealthyHostCount(),
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 2,
      }
    );
    unhealthyAlarm.addAlarmAction(new cw_actions.SnsAction(topic));

    const noHostsAlarm = new cloudwatch.Alarm(
      this,
      'TargetGroupNoHealthyHosts',
      {
        alarmName: this.stackName + '-No-Healthy-Hosts',
        metric: service.targetGroup.metrics.healthyHostCount({
          statistic: cloudwatch.Stats.MINIMUM,
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }
    );
    noHostsAlarm.addAlarmAction(new cw_actions.SnsAction(topic));

    const tooManyHostsAlarm = new cloudwatch.Alarm(
      this,
      'TargetGroupTooManyHealthyHosts',
      {
        alarmName: this.stackName + '-Too-Many-Healthy-Hosts',
        metric: service.targetGroup.metrics.healthyHostCount({
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 1,
      }
    );
    tooManyHostsAlarm.addAlarmAction(new cw_actions.SnsAction(topic));

    const faultAlarm = new cloudwatch.Alarm(this, 'TargetGroup5xx', {
      alarmName: this.stackName + '-Http-500',
      metric: service.targetGroup.metrics.httpCodeTarget(
        elb.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: Duration.minutes(1) }
      ),
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 1,
    });
    faultAlarm.addAlarmAction(new cw_actions.SnsAction(topic));
  }
}

const app = new App();
new BlueskyPdsInfraStack(app, 'BlueskyPdsInfra', {
  mode: Mode.TEST,
  domainName: 'pds.clare.dev',
  domainZone: 'pds.clare.dev',
  rootDomain: 'clare.dev',
  env: { account: process.env['CDK_DEFAULT_ACCOUNT'], region: 'us-east-2' },
  tags: {
    project: 'bluesky-pds',
  },
});
app.synth();
