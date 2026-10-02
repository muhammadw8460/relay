import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, type CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, type NodejsFunctionProps, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface RelayStackProps extends StackProps {
  stage: string;
  /** Optional email subscribed to the alarm topic (confirm the subscription email once). */
  alarmEmail?: string;
  /** Probability of a simulated transient inventory failure per attempt. */
  transientFailureRate?: number;
  /** Probability of a simulated out-of-stock (order ends FAILED). */
  outOfStockRate?: number;
}

const METRICS_NAMESPACE = 'Relay';
const MAX_RECEIVE_COUNT = 3;
const WORKER_TIMEOUT = Duration.seconds(10);

export class RelayStack extends Stack {
  constructor(scope: Construct, id: string, props: RelayStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const prefix = `relay-${stage}`;

    // ---------- Storage ----------
    const table = new dynamodb.Table(this, 'OrdersTable', {
      tableName: `${prefix}-orders`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ---------- Queues ----------
    const dlq = new sqs.Queue(this, 'OrderDlq', {
      queueName: `${prefix}-order-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const queue = new sqs.Queue(this, 'OrderQueue', {
      queueName: `${prefix}-order-queue`,
      // AWS guidance: at least 6x the consumer timeout, so a slow batch is not redelivered mid-flight.
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEIVE_COUNT },
      enforceSSL: true,
    });

    // ---------- Functions ----------
    const fn = (id: string, entry: string, extra: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, id, {
        functionName: `${prefix}-${entry}`,
        entry: path.join(__dirname, '..', 'src', 'handlers', `${entry}.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(5),
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          logGroupName: `/aws/lambda/${prefix}-${entry}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          minify: true,
          sourceMap: true,
          format: OutputFormat.CJS,
          // The Node 22 Lambda runtime ships AWS SDK v3; don't bundle it.
          externalModules: ['@aws-sdk/*'],
        },
        ...extra,
        environment: {
          NODE_OPTIONS: '--enable-source-maps',
          STAGE: stage,
          TABLE_NAME: table.tableName,
          ...extra.environment,
        },
      });

    const createOrderFn = fn('CreateOrderFn', 'createOrder', {
      environment: { QUEUE_URL: queue.queueUrl, REENQUEUE_AFTER_MS: '30000' },
    });
    const getOrderFn = fn('GetOrderFn', 'getOrder');
    const processOrderFn = fn('ProcessOrderFn', 'processOrder', {
      timeout: WORKER_TIMEOUT,
      environment: {
        TRANSIENT_FAILURE_RATE: String(props.transientFailureRate ?? 0.1),
        OUT_OF_STOCK_RATE: String(props.outOfStockRate ?? 0.05),
        SIMULATED_WORK_MS: '25',
      },
    });

    // ---------- Least-privilege IAM, per function ----------
    table.grant(createOrderFn, 'dynamodb:PutItem', 'dynamodb:GetItem');
    queue.grantSendMessages(createOrderFn);
    table.grant(getOrderFn, 'dynamodb:GetItem');
    table.grant(processOrderFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    // The event source mapping grants processOrderFn receive/delete on the queue only.

    processOrderFn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(1),
        reportBatchItemFailures: true,
        maxConcurrency: 5,
      }),
    );

    // ---------- API ----------
    const api = new HttpApi(this, 'Api', { apiName: prefix });
    api.addRoutes({
      path: '/orders',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CreateOrderIntegration', createOrderFn),
    });
    api.addRoutes({
      path: '/orders/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('GetOrderIntegration', getOrderFn),
    });
    // Stage-wide throttle: a runaway client or load test can't run up a bill.
    const cfnStage = api.defaultStage?.node.defaultChild as CfnStage;
    cfnStage.defaultRouteSettings = { throttlingRateLimit: 200, throttlingBurstLimit: 400 };

    // ---------- Alarms ----------
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { topicName: `${prefix}-alarms` });
    if (props.alarmEmail) alarmTopic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const notify = new cwActions.SnsAction(alarmTopic);

    const dlqDepth = dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' });
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: `${prefix}-dlq-not-empty`,
      alarmDescription: 'Orders exhausted retries and are in the DLQ. Inspect, fix, then run `npm run redrive`.',
      metric: dlqDepth,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const apiErrorRate = new cloudwatch.MathExpression({
      label: 'API 5xx rate (%)',
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: {
        errors: api.metricServerError({ statistic: 'Sum' }),
        requests: api.metricCount({ statistic: 'Sum' }),
      },
      period: Duration.minutes(5),
    });
    const apiErrorAlarm = new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: `${prefix}-api-error-rate`,
      alarmDescription: 'More than 5% of API requests returned 5xx over 5 minutes.',
      metric: apiErrorRate,
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const functions = { create: createOrderFn, get: getOrderFn, process: processOrderFn };
    const errorMetrics: Record<string, cloudwatch.IMetric> = {};
    const invocationMetrics: Record<string, cloudwatch.IMetric> = {};
    for (const [key, f] of Object.entries(functions)) {
      errorMetrics[`e_${key}`] = f.metricErrors({ statistic: 'Sum' });
      invocationMetrics[`i_${key}`] = f.metricInvocations({ statistic: 'Sum' });
    }
    const lambdaErrorRate = new cloudwatch.MathExpression({
      label: 'Lambda error rate (%)',
      expression: `IF((${Object.keys(invocationMetrics).join('+')}) > 0, 100 * (${Object.keys(errorMetrics).join('+')}) / (${Object.keys(invocationMetrics).join('+')}), 0)`,
      usingMetrics: { ...errorMetrics, ...invocationMetrics },
      period: Duration.minutes(5),
    });
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorRateAlarm', {
      alarmName: `${prefix}-lambda-error-rate`,
      alarmDescription: 'More than 5% of Lambda invocations errored (crash/timeout) over 5 minutes.',
      metric: lambdaErrorRate,
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const alarm of [dlqAlarm, apiErrorAlarm, lambdaErrorAlarm]) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }

    // ---------- Dashboard ----------
    const relayMetric = (metricName: string, statistic = 'Sum', label?: string) =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName,
        dimensionsMap: { Stage: stage },
        statistic,
        period: Duration.minutes(1),
        label: label ?? metricName,
      });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: prefix });
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarms',
        alarms: [dlqAlarm, apiErrorAlarm, lambdaErrorAlarm],
        width: 24,
        height: 3,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Orders (per minute)',
        left: [
          relayMetric('OrdersCreated'),
          relayMetric('OrdersConfirmed'),
          relayMetric('OrdersFailed'),
          relayMetric('DuplicateRequestsDetected'),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'End-to-end processing latency (ms)',
        left: [
          relayMetric('ProcessingLatencyMs', 'p50', 'p50'),
          relayMetric('ProcessingLatencyMs', 'p99', 'p99'),
        ],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests',
        left: [
          api.metricCount({ statistic: 'Sum', period: Duration.minutes(1), label: 'requests' }),
          api.metricClientError({ statistic: 'Sum', period: Duration.minutes(1), label: '4xx' }),
          api.metricServerError({ statistic: 'Sum', period: Duration.minutes(1), label: '5xx' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API latency (ms)',
        left: [
          api.metricLatency({ statistic: 'p50', period: Duration.minutes(1), label: 'p50' }),
          api.metricLatency({ statistic: 'p99', period: Duration.minutes(1), label: 'p99' }),
        ],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Queues',
        left: [
          queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), label: 'queue visible' }),
          dlqDepth.with({ label: 'DLQ visible' }),
        ],
        right: [
          queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1), label: 'oldest message age (s)' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda errors and throttles',
        left: Object.entries(functions).flatMap(([key, f]) => [
          f.metricErrors({ statistic: 'Sum', period: Duration.minutes(1), label: `${key} errors` }),
          f.metricThrottles({ statistic: 'Sum', period: Duration.minutes(1), label: `${key} throttles` }),
        ]),
        width: 12,
      }),
    );

    // ---------- Outputs ----------
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${prefix}`,
    });
  }
}
