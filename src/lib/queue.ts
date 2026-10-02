import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from './aws';
import { config } from './config';
import type { OrderMessage } from './schema';

export const CORRELATION_ATTRIBUTE = 'correlationId';

/** The correlation ID rides as a message attribute so the worker can log with it. */
export async function enqueueOrder(orderId: string, correlationId: string): Promise<void> {
  const body: OrderMessage = { orderId };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queueUrl(),
      MessageBody: JSON.stringify(body),
      MessageAttributes: {
        [CORRELATION_ATTRIBUTE]: { DataType: 'String', StringValue: correlationId },
      },
    }),
  );
}
