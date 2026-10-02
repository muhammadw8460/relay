import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws';
import { config } from './config';
import { type Order, type OrderStatus, orderPk } from './order';
import { assertTransition } from './state';

export type PutResult = 'created' | 'exists';

/**
 * Insert-if-absent. The condition makes this the single point where
 * duplicates are rejected: two concurrent requests with the same key race on
 * one item, and DynamoDB guarantees exactly one of them wins.
 */
export async function putNewOrder(order: Order): Promise<PutResult> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: config.tableName(),
        Item: order,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return 'created';
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'exists';
    throw err;
  }
}

export async function getOrder(orderId: string, consistentRead = false): Promise<Order | undefined> {
  const res = await ddb.send(
    new GetCommand({
      TableName: config.tableName(),
      Key: { pk: orderPk(orderId) },
      ConsistentRead: consistentRead,
    }),
  );
  return res.Item as Order | undefined;
}

export interface TransitionInput {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  expectedVersion: number;
  failureReason?: string;
  now?: Date;
}

/**
 * Optimistic-concurrency status change. Succeeds only if the item is still at
 * `expectedVersion` and `from`; otherwise another delivery already moved it and
 * this returns `undefined` instead of applying the change a second time.
 */
export async function transitionOrder(input: TransitionInput): Promise<Order | undefined> {
  assertTransition(input.from, input.to);
  const at = (input.now ?? new Date()).toISOString();
  const setReason = input.failureReason !== undefined ? ', failureReason = :reason' : '';
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { pk: orderPk(input.orderId) },
        UpdateExpression:
          'SET #status = :to, version = :next, updatedAt = :at, history = list_append(history, :change)' + setReason,
        ConditionExpression: 'attribute_exists(pk) AND version = :expected AND #status = :from',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':to': input.to,
          ':from': input.from,
          ':expected': input.expectedVersion,
          ':next': input.expectedVersion + 1,
          ':at': at,
          ':change': [{ status: input.to, at }],
          ...(input.failureReason !== undefined ? { ':reason': input.failureReason } : {}),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return res.Attributes as Order;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return undefined;
    throw err;
  }
}
