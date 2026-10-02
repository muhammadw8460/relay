import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { config } from '../lib/config';
import { reserveInventory } from '../lib/inventory';
import { type Logger, createLogger } from '../lib/logger';
import { Metrics } from '../lib/metrics';
import { getOrder, transitionOrder } from '../lib/orders-repo';
import { CORRELATION_ATTRIBUTE } from '../lib/queue';
import { OrderMessageSchema } from '../lib/schema';
import { isTerminal } from '../lib/state';

export type Outcome =
  | 'CONFIRMED'
  | 'FAILED'
  | 'SKIPPED_ALREADY_TERMINAL'
  | 'SKIPPED_LOST_RACE'
  | 'SKIPPED_NOT_FOUND';

/**
 * Drives one order to a terminal state. Safe under at-least-once delivery:
 *
 * - Terminal orders are skipped, so a redelivered message is a no-op.
 * - Every write is conditional on the version read just before it. If two
 *   deliveries of the same message run concurrently, only one write per
 *   transition succeeds and the loser stops.
 * - PROCESSING is resumable: if a previous attempt moved the order to
 *   PROCESSING and then failed transiently, the retry picks up from there.
 */
export async function processRecord(record: SQSRecord, metrics: Metrics, baseLog: Logger): Promise<Outcome> {
  const correlationId = record.messageAttributes?.[CORRELATION_ATTRIBUTE]?.stringValue ?? record.messageId;
  const receiveCount = Number(record.attributes.ApproximateReceiveCount);
  const log = baseLog.child({ correlationId, messageId: record.messageId, receiveCount });

  // A malformed body throws here. It never succeeds, so after maxReceiveCount it lands in the DLQ for inspection.
  const { orderId } = OrderMessageSchema.parse(JSON.parse(record.body));

  let order = await getOrder(orderId, true);
  if (!order) {
    log.warn('order not found, dropping message', { orderId });
    return 'SKIPPED_NOT_FOUND';
  }
  if (isTerminal(order.status)) {
    log.info('duplicate delivery, order already terminal', { orderId, status: order.status });
    return 'SKIPPED_ALREADY_TERMINAL';
  }

  if (order.status === 'PENDING') {
    const claimed = await transitionOrder({ orderId, from: 'PENDING', to: 'PROCESSING', expectedVersion: order.version });
    if (claimed) {
      order = claimed;
      log.info('order processing', { orderId, version: order.version });
    } else {
      // Someone else moved it first. Re-read and continue only if it is still in flight.
      order = await getOrder(orderId, true);
      if (!order || isTerminal(order.status)) {
        log.info('lost race claiming order', { orderId, status: order?.status });
        return 'SKIPPED_LOST_RACE';
      }
    }
  } else {
    log.info('resuming order already PROCESSING', { orderId, version: order.version });
  }

  // Throws TransientInventoryError on simulated transient failure -> message is retried.
  const reservation = await reserveInventory(order);
  const to = reservation.ok ? 'CONFIRMED' : 'FAILED';
  const final = await transitionOrder({
    orderId,
    from: 'PROCESSING',
    to,
    expectedVersion: order.version,
    failureReason: reservation.ok ? undefined : reservation.reason,
  });

  if (!final) {
    log.info('lost race finalizing order, another delivery completed it', { orderId });
    return 'SKIPPED_LOST_RACE';
  }

  const latencyMs = Date.now() - Date.parse(final.createdAt);
  metrics.count(to === 'CONFIRMED' ? 'OrdersConfirmed' : 'OrdersFailed');
  metrics.timing('ProcessingLatencyMs', latencyMs);
  log.info(`order ${to.toLowerCase()}`, { orderId, status: to, latencyMs, failureReason: final.failureReason });
  return to;
}

/**
 * SQS-triggered worker with ReportBatchItemFailures: only the records that
 * failed are returned to the queue, instead of retrying the whole batch.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const log = createLogger({ handler: 'processOrder' });
  const metrics = new Metrics(config.stage());
  const batchItemFailures: SQSBatchItemFailure[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await processRecord(record, metrics, log);
      } catch (error) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        log.warn('record failed, will be retried', {
          messageId: record.messageId,
          receiveCount: Number(record.attributes.ApproximateReceiveCount),
          correlationId: record.messageAttributes?.[CORRELATION_ATTRIBUTE]?.stringValue,
          error,
        });
      }
    }),
  );

  metrics.flush();
  if (batchItemFailures.length > 0) {
    log.info('batch completed with failures', { size: event.Records.length, failed: batchItemFailures.length });
  }
  return { batchItemFailures };
};
