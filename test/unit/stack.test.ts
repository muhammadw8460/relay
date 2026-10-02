import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { BootstrapStack } from '../../lib/bootstrap-stack';
import { RelayStack } from '../../lib/relay-stack';

// Skip esbuild bundling: these tests are about the infrastructure definition.
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

function policyActions(template: Template, logicalIdPrefix: string): string[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.entries(policies)
    .filter(([id]) => id.startsWith(logicalIdPrefix))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement)
    .flatMap((s: { Action: string | string[] }) => [s.Action].flat());
}

describe('RelayStack', () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(new RelayStack(newApp(), 'Relay-test', { stage: 'test' }));
  }, 60_000);

  it('defines an on-demand orders table keyed on pk', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'relay-test-orders',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    });
  });

  it('sends messages to the DLQ after 3 failed receives', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'relay-test-order-queue',
      VisibilityTimeout: 60,
      RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'relay-test-order-dlq' });
  });

  it('wires the worker to the queue with partial batch failure reporting', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('runs all three functions on Node 22 / arm64', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs22.x', Architectures: ['arm64'] },
    });
    expect(Object.keys(fns)).toHaveLength(3);
  });

  it('grants each function only the permissions it needs', () => {
    const create = policyActions(template, 'CreateOrderFnServiceRoleDefaultPolicy');
    expect(create).toEqual(expect.arrayContaining(['dynamodb:PutItem', 'dynamodb:GetItem', 'sqs:SendMessage']));
    expect(create).not.toContain('dynamodb:UpdateItem');
    expect(create).not.toContain('dynamodb:Scan');

    const get = policyActions(template, 'GetOrderFnServiceRoleDefaultPolicy');
    expect(get).toEqual(['dynamodb:GetItem']);

    const proc = policyActions(template, 'ProcessOrderFnServiceRoleDefaultPolicy');
    expect(proc).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'sqs:ReceiveMessage', 'sqs:DeleteMessage']));
    expect(proc).not.toContain('dynamodb:PutItem');
    expect(proc).not.toContain('sqs:SendMessage');
  });

  it('exposes POST /orders and GET /orders/{id}', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /orders' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /orders/{id}' });
  });

  it('alarms on DLQ depth > 0 and error rates > 5%', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'relay-test-dlq-not-empty',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'relay-test-api-error-rate', Threshold: 5 });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'relay-test-lambda-error-rate', Threshold: 5 });
  });

  it('creates a dashboard and short log retention', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });
});

describe('BootstrapStack', () => {
  it('trusts only the configured repo and branch, and creates the budget when an email is given', () => {
    const stack = new BootstrapStack(newApp(), 'RelayBootstrap', {
      githubRepo: 'muhammadw8460/relay',
      budgetEmail: 'alerts@example.com',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:muhammadw8460/relay:ref:refs/heads/main' },
            },
          }),
        ],
      },
    });
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' } }),
    });
  });
});
