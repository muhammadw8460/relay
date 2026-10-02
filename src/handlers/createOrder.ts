import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { config } from '../lib/config';
import { correlationIdFor, errorBody, header, json, rawBody } from '../lib/http';
import { orderIdFromKey, requestHash } from '../lib/ids';
import { createLogger } from '../lib/logger';
import { Metrics } from '../lib/metrics';
import { type Order, orderPk, toView } from '../lib/order';
import { getOrder, putNewOrder } from '../lib/orders-repo';
import { enqueueOrder } from '../lib/queue';
import { CreateOrderSchema, IdempotencyKeySchema, formatIssues } from '../lib/schema';

/**
 * POST /orders
 *
 * 201 new order accepted (PENDING, enqueued)
 * 200 same Idempotency-Key seen before: the original order, nothing new written
 * 400 missing/invalid key or body
 * 422 key reused with a different body
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const correlationId = correlationIdFor(event);
  const log = createLogger({ handler: 'createOrder', correlationId });
  const metrics = new Metrics(config.stage(), { correlationId });
  const respond = (status: number, body: unknown) => json(status, body, { 'x-correlation-id': correlationId });

  try {
    const key = IdempotencyKeySchema.safeParse(header(event, 'idempotency-key'));
    if (!key.success) {
      return respond(400, errorBody('INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key header', formatIssues(key.error)));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody(event) ?? '');
    } catch {
      return respond(400, errorBody('INVALID_JSON', 'Request body must be valid JSON'));
    }

    const parsed = CreateOrderSchema.safeParse(payload);
    if (!parsed.success) {
      return respond(400, errorBody('VALIDATION_FAILED', 'Request body failed validation', formatIssues(parsed.error)));
    }

    const input = parsed.data;
    const orderId = orderIdFromKey(key.data);
    const hash = requestHash(input);
    const now = new Date().toISOString();
    const order: Order = {
      pk: orderPk(orderId),
      orderId,
      idempotencyKey: key.data,
      requestHash: hash,
      customerId: input.customerId,
      items: input.items,
      currency: input.currency,
      totalCents: input.items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
      status: 'PENDING',
      version: 0,
      correlationId,
      createdAt: now,
      updatedAt: now,
      history: [{ status: 'PENDING', at: now }],
    };

    const result = await putNewOrder(order);

    if (result === 'created') {
      // If this send fails the client gets a 500 and retries with the same key;
      // the duplicate path below re-enqueues the order it finds still PENDING.
      await enqueueOrder(orderId, correlationId);
      metrics.count('OrdersCreated');
      log.info('order created', { orderId, totalCents: order.totalCents, itemCount: order.items.length });
      return respond(201, toView(order));
    }

    const existing = await getOrder(orderId, true);
    if (!existing) {
      // The conditional put said the item exists, and the read is strongly consistent.
      throw new Error(`Order ${orderId} reported as existing but not found`);
    }

    if (existing.requestHash !== hash) {
      log.warn('idempotency key reused with different payload', { orderId });
      return respond(
        422,
        errorBody('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request body'),
      );
    }

    metrics.count('DuplicateRequestsDetected');
    log.info('duplicate request detected', { orderId, status: existing.status, originalCorrelationId: existing.correlationId });

    const ageMs = Date.now() - Date.parse(existing.createdAt);
    if (existing.status === 'PENDING' && ageMs >= config.reenqueueAfterMs()) {
      // Heals the "put succeeded, send failed" gap. Safe: the worker is idempotent.
      await enqueueOrder(orderId, existing.correlationId);
      log.warn('re-enqueued stale PENDING order', { orderId, ageMs });
    }

    return respond(200, toView(existing));
  } catch (error) {
    log.error('createOrder failed', { error });
    return respond(500, errorBody('INTERNAL_ERROR', 'Internal error, safe to retry with the same Idempotency-Key'));
  } finally {
    metrics.flush();
  }
};
