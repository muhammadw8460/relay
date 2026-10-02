/**
 * Replays messages from the DLQ back onto the main queue.
 *
 *   npm run redrive -- --dry-run      # show what is in the DLQ, change nothing
 *   npm run redrive                   # move everything
 *   npm run redrive -- --max 20       # move at most 20
 *
 * Each message is sent to the main queue first and only then deleted from the
 * DLQ, so a crash mid-run can duplicate a message but never lose one. The
 * worker is idempotent, so a duplicate is harmless.
 */
import {
  DeleteMessageCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { argValue, hasFlag, stackOutputs } from './stack-outputs';

const sqs = new SQSClient({});

function copyAttributes(attrs: Message['MessageAttributes']): Record<string, MessageAttributeValue> | undefined {
  if (!attrs) return undefined;
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [
      k,
      { DataType: v.DataType, ...(v.StringValue !== undefined ? { StringValue: v.StringValue } : {}), ...(v.BinaryValue ? { BinaryValue: v.BinaryValue } : {}) },
    ]),
  );
}

async function main(): Promise<void> {
  const { QueueUrl, DlqUrl } = await stackOutputs();
  const dryRun = hasFlag('dry-run');
  const max = Number(argValue('max') ?? Infinity);
  let moved = 0;

  console.log(`${dryRun ? '[dry run] ' : ''}Redriving from ${DlqUrl}\n                to ${QueueUrl}`);

  while (moved < max) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: DlqUrl,
        MaxNumberOfMessages: Math.min(10, max - moved),
        WaitTimeSeconds: 2,
        // Dry run: hide briefly so one pass doesn't list the same message twice, then it reappears.
        VisibilityTimeout: dryRun ? 10 : 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) break;

    for (const m of messages) {
      const correlationId = m.MessageAttributes?.correlationId?.StringValue;
      console.log(`  ${m.MessageId}  body=${m.Body}  correlationId=${correlationId ?? '-'}  receives=${m.Attributes?.ApproximateReceiveCount}`);
      if (!dryRun) {
        await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: m.Body!, MessageAttributes: copyAttributes(m.MessageAttributes) }));
        await sqs.send(new DeleteMessageCommand({ QueueUrl: DlqUrl, ReceiptHandle: m.ReceiptHandle! }));
      }
      moved++;
    }
  }

  console.log(`\n${dryRun ? 'Found' : 'Redrove'} ${moved} message(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
