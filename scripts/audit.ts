/**
 * Scans the orders table and checks the invariants the design promises:
 * one order per idempotency key, and every transition applied exactly once.
 *
 *   npm run audit                              # whole table
 *   npm run audit -- --customer k6-1759250000  # one load-test or integration run
 *
 * Exits 1 if any duplicate or anomaly is found.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, paginateScan } from '@aws-sdk/lib-dynamodb';
import type { Order } from '../src/lib/order';
import { auditOrders } from './audit-lib';
import { argValue, stackOutputs } from './stack-outputs';

export async function scanOrders(tableName: string, customerId?: string): Promise<Order[]> {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const orders: Order[] = [];
  const pages = paginateScan(
    { client },
    {
      TableName: tableName,
      ...(customerId
        ? { FilterExpression: 'customerId = :c', ExpressionAttributeValues: { ':c': customerId } }
        : {}),
    },
  );
  for await (const page of pages) orders.push(...((page.Items ?? []) as Order[]));
  return orders;
}

async function main(): Promise<void> {
  const { TableName } = await stackOutputs();
  const customer = argValue('customer');
  const orders = await scanOrders(TableName, customer);
  const report = auditOrders(orders);

  console.log(JSON.stringify({ table: TableName, customer: customer ?? '(all)', ...report }, null, 2));
  const ok = report.duplicateKeys.length === 0 && report.anomalies.length === 0;
  console.log(ok ? '\nAudit passed: 0 duplicate orders, 0 double-applied transitions.' : '\nAudit FAILED.');
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
