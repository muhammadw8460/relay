import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandInput,
  PutCommand,
  type PutCommandInput,
  UpdateCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, SQSRecord } from 'aws-lambda';
import type { AwsClientStub } from 'aws-sdk-client-mock';
import type { Order } from '../../src/lib/order';

export const TEST_ENV = {
  TABLE_NAME: 'orders-test',
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/order-queue',
  STAGE: 'test',
  TRANSIENT_FAILURE_RATE: '0',
  OUT_OF_STOCK_RATE: '0',
  SIMULATED_WORK_MS: '0',
  REENQUEUE_AFTER_MS: '30000',
};

export function setTestEnv(overrides: Partial<Record<keyof typeof TEST_ENV, string>> = {}): void {
  Object.assign(process.env, TEST_ENV, overrides);
}

export function apiEvent(
  opts: { body?: unknown; headers?: Record<string, string>; pathParameters?: Record<string, string>; requestId?: string } = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /orders',
    rawPath: '/orders',
    rawQueryString: '',
    headers: opts.headers ?? {},
    pathParameters: opts.pathParameters,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/orders', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: opts.requestId ?? 'req-123',
      routeKey: 'POST /orders',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
  };
}

export function sqsRecord(orderId: string, opts: { messageId?: string; receiveCount?: number; body?: string } = {}): SQSRecord {
  return {
    messageId: opts.messageId ?? `msg-${orderId}`,
    receiptHandle: 'receipt',
    body: opts.body ?? JSON.stringify({ orderId }),
    attributes: {
      ApproximateReceiveCount: String(opts.receiveCount ?? 1),
      SentTimestamp: '0',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: { correlationId: { stringValue: 'corr-123', dataType: 'String' } },
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:order-queue',
    awsRegion: 'us-east-1',
  };
}

export const validBody = {
  customerId: 'cust-1',
  currency: 'USD',
  items: [
    { sku: 'WIDGET-1', quantity: 2, unitPriceCents: 1250 },
    { sku: 'GADGET-9', quantity: 1, unitPriceCents: 499 },
  ],
};

export function makeOrder(overrides: Partial<Order> = {}): Order {
  const orderId = overrides.orderId ?? 'ord_0123456789abcdef01234567';
  const createdAt = '2026-01-01T00:00:00.000Z';
  return {
    pk: `ORDER#${orderId}`,
    orderId,
    idempotencyKey: 'key-12345678',
    requestHash: 'hash',
    customerId: 'cust-1',
    items: [{ sku: 'WIDGET-1', quantity: 1, unitPriceCents: 100 }],
    currency: 'USD',
    totalCents: 100,
    status: 'PENDING',
    version: 0,
    correlationId: 'corr-123',
    createdAt,
    updatedAt: createdAt,
    history: [{ status: 'PENDING', at: createdAt }],
    ...overrides,
  };
}

const ccf = () => new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

/**
 * In-memory table that enforces the same conditions the real code sends to
 * DynamoDB. It understands exactly the expressions in orders-repo.ts (not a
 * general expression parser), which is enough to prove the concurrency
 * guarantees in unit tests. Every call yields to the event loop first so
 * concurrent callers genuinely interleave.
 */
export class FakeOrdersTable {
  readonly items = new Map<string, Order>();

  install(mock: AwsClientStub<DynamoDBDocumentClient>): void {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    mock.on(PutCommand).callsFake(async (input: PutCommandInput) => {
      await tick();
      const item = structuredClone(input.Item) as Order;
      if (input.ConditionExpression === 'attribute_not_exists(pk)' && this.items.has(item.pk)) throw ccf();
      this.items.set(item.pk, item);
      return {};
    });
    mock.on(GetCommand).callsFake(async (input: GetCommandInput) => {
      await tick();
      const item = this.items.get(input.Key?.pk as string);
      return { Item: item ? structuredClone(item) : undefined };
    });
    mock.on(UpdateCommand).callsFake(async (input: UpdateCommandInput) => {
      await tick();
      const v = input.ExpressionAttributeValues ?? {};
      const item = this.items.get(input.Key?.pk as string);
      const cond = input.ConditionExpression ?? '';
      if (!item) throw ccf();
      if (cond.includes('version = :expected') && item.version !== v[':expected']) throw ccf();
      if (cond.includes('#status = :from') && item.status !== v[':from']) throw ccf();
      item.status = v[':to'];
      item.version = v[':next'];
      item.updatedAt = v[':at'];
      item.history = [...item.history, ...v[':change']];
      if (v[':reason'] !== undefined) item.failureReason = v[':reason'];
      return { Attributes: structuredClone(item) };
    });
  }
}

export { DynamoDBDocumentClient };
