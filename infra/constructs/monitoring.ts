import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_elasticloadbalancingv2 as elb,
  aws_logs as logs,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Compute } from './compute';
import { CommonProps } from '../types';

export interface MonitoringProps extends CommonProps {
  readonly compute: Compute;
}

/**
 * The AWS resources used by the PDS application and sidecar containers
 */
export class Monitoring extends Construct {
  constructor(parent: Construct, name: string, props: MonitoringProps) {
    super(parent, name);

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
        alarmName: Stack.of(this).stackName + '-Unhealthy-Hosts',
        metric: props.compute.targetGroup.metrics.unhealthyHostCount({
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
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
        alarmName: Stack.of(this).stackName + '-No-Healthy-Hosts',
        metric: props.compute.targetGroup.metrics.healthyHostCount({
          statistic: cloudwatch.Stats.MINIMUM,
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }
    );
    noHostsAlarm.addAlarmAction(new cw_actions.SnsAction(topic));
    // On stack creation, don't create the alarm until the service has been deployed at least once.
    // This prevents noisy alarms during the first deployment
    noHostsAlarm.node.addDependency(props.compute.service);

    const tooManyHostsAlarm = new cloudwatch.Alarm(
      this,
      'TargetGroupTooManyHealthyHosts',
      {
        alarmName: Stack.of(this).stackName + '-Too-Many-Healthy-Hosts',
        metric: props.compute.targetGroup.metrics.healthyHostCount({
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
      alarmName: Stack.of(this).stackName + '-Http-500',
      metric: props.compute.targetGroup.metrics.httpCodeTarget(
        elb.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: Duration.minutes(1) }
      ),
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 2,
    });
    faultAlarm.addAlarmAction(new cw_actions.SnsAction(topic));

    // Metric filters feed into the same metric, to capture
    // structured logs (PDS) and unstructured logs (sidecars).
    // Only alarm on server errors (5xx), not client errors (4xx) from bots.
    const errorStructuredLogsMetricFilter =
      props.compute.pdsLogGroup.addMetricFilter('StructuredLogErrorFilter', {
        filterPattern: logs.FilterPattern.literal(
          '{ $.err.type = "*" && $.err.statusCode >= 500 }'
        ),
        metricName: 'PDSLogErrors',
        metricNamespace: props.domainName.replace(/\./g, '-'),
      });
    props.compute.litestreamLogGroup.addMetricFilter(
      'LitestreamLogErrorFilter',
      {
        filterPattern: logs.FilterPattern.anyTerm('[ERROR]'),
        metricName: 'PDSLogErrors',
        metricNamespace: props.domainName.replace(/\./g, '-'),
      }
    );
    props.compute.fileBackupLogGroup.addMetricFilter(
      'FileBackupLogErrorFilter',
      {
        filterPattern: logs.FilterPattern.anyTerm('[ERROR]'),
        metricName: 'PDSLogErrors',
        metricNamespace: props.domainName.replace(/\./g, '-'),
      }
    );
    const logErrorsAlarm = new cloudwatch.Alarm(this, 'LogErrors', {
      alarmName: Stack.of(this).stackName + '-Log-Errors',
      alarmDescription: 'Errors found in the logs',
      metric: errorStructuredLogsMetricFilter.metric({
        statistic: cloudwatch.Stats.SUM,
        period: Duration.minutes(1),
      }),
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    logErrorsAlarm.addAlarmAction(new cw_actions.SnsAction(topic));

    // TODO custom dashboard

    // TODO: add a monitoring canary?
  }
}
