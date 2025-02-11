import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elb,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AppResources } from './app-resources';
import { Network } from './network';
import { CommonProps, Mode } from '../types';

export interface ComputeProps extends CommonProps {
  readonly appResources: AppResources;
  readonly network: Network;
}

/**
 * The underlying compute and load balancer infrastructure for the Bluesky PDS application,
 * running in containers.
 */
export class Compute extends Construct {
  public readonly service: ecs.BaseService;
  public readonly targetGroup: elb.ApplicationTargetGroup;
  public readonly pdsLogGroup: logs.LogGroup;
  public readonly litestreamLogGroup: logs.LogGroup;
  public readonly fileBackupLogGroup: logs.LogGroup;

  constructor(parent: Construct, name: string, props: ComputeProps) {
    super(parent, name);

    new CfnOutput(this, 'ServiceURL', {
      value: `https://${props.domainName}`,
    });

    // Docker images to build
    const pdsImage = ecs.ContainerImage.fromAsset('./pds', {
      platform: ecr_assets.Platform.LINUX_AMD64,
    });
    const pdsLitestreamImage = ecs.ContainerImage.fromAsset(
      './pds-litestream',
      {
        platform: ecr_assets.Platform.LINUX_AMD64,
      }
    );
    const pdsFileBackupImage = ecs.ContainerImage.fromAsset(
      './pds-s3-file-sync',
      {
        platform: ecr_assets.Platform.LINUX_AMD64,
      }
    );

    // Logging
    this.pdsLogGroup = new logs.LogGroup(this, 'ServiceLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    this.litestreamLogGroup = new logs.LogGroup(this, 'LitestreamLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    this.fileBackupLogGroup = new logs.LogGroup(this, 'FileBackupLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        props.mode === Mode.TEST
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    // Load balancer
    // amazonq-ignore-next-line
    const loadBalancer = new elb.ApplicationLoadBalancer(this, 'LB', {
      vpc: props.network.vpc,
      internetFacing: true,
    });

    const listener = loadBalancer.addListener('PublicListener', {
      protocol: elb.ApplicationProtocol.HTTPS,
      open: true,
      certificates: [props.network.certificate],
      // allow-list paths to block traffic crawling for exploits
      defaultAction: elb.ListenerAction.fixedResponse(403),
    });

    loadBalancer.addListener('PublicRedirectListener', {
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      open: true,
      defaultAction: elb.ListenerAction.redirect({
        port: '443',
        protocol: elb.ApplicationProtocol.HTTPS,
        permanent: true,
      }),
    });

    this.targetGroup = listener.addTargets('ECS', {
      protocol: elb.ApplicationProtocol.HTTP,
      deregistrationDelay: Duration.minutes(1),
      healthCheck: {
        path: '/xrpc/_health',
      },
      priority: 1,
      conditions: [
        // The only paths that should be forwarded to the PDS container
        elb.ListenerCondition.pathPatterns([
          '/xrpc/*',
          '/.well-known/*',
          '/oauth/*',
          '/@atproto/oauth-provider/*',
          '/tls-check',
        ]),
      ],
    });

    listener.addAction('Home', {
      action: elb.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: 'OK',
      }),
      priority: 2,
      conditions: [elb.ListenerCondition.pathPatterns(['/'])],
    });

    listener.addAction('Robots', {
      action: elb.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: 'User-agent: *\nDisallow: /',
      }),
      priority: 3,
      conditions: [elb.ListenerCondition.pathPatterns(['/robots.txt'])],
    });

    // DNS records
    new route53.ARecord(this, 'DNS', {
      zone: props.network.hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(loadBalancer)
      ),
    });

    // PDS will verify users at endpoints like:
    // https://<userhandle>.pds.example.com/.well-known/atproto-did
    // This wildcard record will route *.pds.example.com to the ALB
    new route53.ARecord(this, 'WildcardDNS', {
      zone: props.network.hostedZone,
      recordName: `*.${props.domainName}`,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(loadBalancer)
      ),
    });

    // Fargate service
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // PDS min system requirements: 1 CPU core, 1 GB memory, 20 GB disk
      cpu: 1024,
      memoryLimitMiB: 2048, // lowest mem value allowed in Fargate for 1 CPU
    });

    const pdsContainer = taskDefinition.addContainer('pds', {
      image: pdsImage,
      healthCheck: {
        command: [
          'CMD-SHELL',
          "node -e 'fetch(`http://localhost:3000/xrpc/_health`).then(()=>process.exitCode = 0).catch(()=>process.exitCode = 1)'",
        ],
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'PDS',
        logGroup: this.pdsLogGroup,
      }),
      environment: {
        PDS_HOSTNAME: props.domainName,
        PDS_PORT: '3000',
        PDS_DATA_DIRECTORY: '/pds',
        PDS_PLC_ROTATION_KEY_KMS_KEY_ID: props.appResources.rotationKey.keyId,
        AWS_REGION: Stack.of(this).region,
        AWS_DEFAULT_REGION: Stack.of(this).region,
        PDS_BLOBSTORE_S3_BUCKET: props.appResources.blobBucket.bucketName,
        PDS_BLOBSTORE_S3_REGION: Stack.of(this).region,
        PDS_BLOBSTORE_DISK_LOCATION: '',
        PDS_BLOB_UPLOAD_LIMIT: '52428800',
        PDS_EMAIL_FROM_ADDRESS: `admin@mail.${props.domainZone}`,
        PDS_DID_PLC_URL: 'https://plc.directory',
        PDS_BSKY_APP_VIEW_URL: 'https://api.bsky.app',
        PDS_BSKY_APP_VIEW_DID: 'did:web:api.bsky.app',
        PDS_REPORT_SERVICE_URL: 'https://mod.bsky.app',
        PDS_REPORT_SERVICE_DID: 'did:plc:ar7c4by46qjdydhdevvrndac',
        PDS_CRAWLERS: 'https://bsky.network',
        PDS_SERVICE_HANDLE_DOMAINS: `.${props.domainName}`,
        LOG_ENABLED: 'true',
        SMTP_HOST: `email-smtp.${Stack.of(this).region}.amazonaws.com`,
      },
      secrets: {
        PDS_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(
          props.appResources.adminPassword
        ),
        PDS_JWT_SECRET: ecs.Secret.fromSecretsManager(
          props.appResources.jwtSecret
        ),
        SMTP_MAIL_USERNAME: ecs.Secret.fromSecretsManager(
          props.appResources.smtpCredentials.secret,
          'username'
        ),
        SMTP_MAIL_PASSWORD: ecs.Secret.fromSecretsManager(
          props.appResources.smtpCredentials.secret,
          'password'
        ),
      },
    });
    pdsContainer.addPortMappings({
      containerPort: 3000,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.network.cluster,
      serviceName: props.domainName.replace(/\./g, '-'),
      desiredCount: 1,
      taskDefinition: taskDefinition,
      assignPublicIp: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      circuitBreaker: {
        enable: true,
        rollback: true,
      },
      // Only let 1 PDS instance run at a time.
      // Deployments will take down the old task before starting a new one
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      // Enable running pdsadmin in the container
      enableExecuteCommand: true,
    });

    this.service.node.addDependency(props.appResources.emailIdentity);
    this.service.node.addDependency(props.appResources.smtpCredentials);

    this.targetGroup.addTarget(this.service);

    // Add sidecar container that backs up and restores PDS databases to/from S3
    const litestreamSidecar = taskDefinition.addContainer(
      'LitestreamContainer',
      {
        containerName: 'litestream',
        image: pdsLitestreamImage,
        logging: ecs.LogDriver.awsLogs({
          streamPrefix: 'Litestream',
          logGroup: this.litestreamLogGroup,
        }),
        environment: {
          AWS_REGION: Stack.of(this).region,
          AWS_DEFAULT_REGION: Stack.of(this).region,
          // CAUTION: changing this value will cause your PDS to lose
          // track of its existing data in the previous bucket path
          S3_PATH: `s3://${props.appResources.dataBackupBucket.bucketName}/litestream-replication`,
          LOCAL_PATH: '/sync',
        },
        healthCheck: {
          command: ['CMD', '/healthcheck.sh'],
        },
        stopTimeout: Duration.minutes(1),
      }
    );

    // Add sidecar container that backs up and restores PDS files to/from S3
    const fileBackupSidecar = taskDefinition.addContainer(
      'FileBackupContainer',
      {
        containerName: 's3-file-sync',
        image: pdsFileBackupImage,
        logging: ecs.LogDriver.awsLogs({
          streamPrefix: 'FileBackup',
          logGroup: this.fileBackupLogGroup,
        }),
        environment: {
          AWS_REGION: Stack.of(this).region,
          AWS_DEFAULT_REGION: Stack.of(this).region,
          // CAUTION: changing this value will cause your PDS to lose
          // track of its existing data in the previous bucket path
          S3_PATH: `s3://${props.appResources.dataBackupBucket.bucketName}/file-backup/actors`,
          LOCAL_PATH: '/sync/actors',
        },
        healthCheck: {
          command: ['CMD', '/healthcheck.sh'],
        },
        stopTimeout: Duration.minutes(1),
      }
    );
    fileBackupSidecar.addContainerDependencies({
      container: litestreamSidecar,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    // Create a volume for the PDS data
    taskDefinition.addVolume({
      name: 'pds-data',
      host: {},
    });
    litestreamSidecar.addMountPoints({
      containerPath: '/sync',
      readOnly: false,
      sourceVolume: 'pds-data',
    });
    fileBackupSidecar.addMountPoints({
      containerPath: '/sync',
      readOnly: false,
      sourceVolume: 'pds-data',
    });
    pdsContainer.addMountPoints({
      containerPath: '/pds',
      readOnly: false,
      sourceVolume: 'pds-data',
    });

    // Ensure that databases and files have been restored in the sidecar container before starting PDS
    pdsContainer.addContainerDependencies(
      {
        container: litestreamSidecar,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
      {
        container: fileBackupSidecar,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      }
    );

    // Permissions needed by containers
    props.appResources.dataBackupBucket.grantReadWrite(taskDefinition.taskRole);
    props.appResources.blobBucket.grantReadWrite(taskDefinition.taskRole);
    props.appResources.rotationKey.grant(
      taskDefinition.taskRole,
      'kms:GetPublicKey',
      'kms:Sign'
    );
  }
}
