/**
 * Post-deploy smoke test. Exercises the whole path against a live stack and
 * exits non-zero on the first failed check.
 *
 *   npm run smoke                 # uses cdk-outputs.json or DescribeStacks
 *   API_URL=https://... npm run smoke
 */
import { randomUUID } from 'node:crypto';
import { RelayClient } from './api-client';
import { stackOutputs } from './stack-outputs';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL ?? (await stackOutputs()).ApiUrl;
  console.log(`Smoke testing ${apiUrl}\n`);
  const api = new RelayClient(apiUrl);
  const runId = `smoke-${randomUUID()}`;
  const body = { customerId: runId, items: [{ sku: 'WIDGET-1', quantity: 2, unitPriceCents: 1999 }] };

  const created = await api.createOrder(body, `${runId}-a`, runId);
  check('POST /orders returns 201 PENDING', created.status === 201 && created.body.status === 'PENDING', created);
  const orderId = created.body.orderId;

  const replay = await api.createOrder(body, `${runId}-a`);
  check('retry with same Idempotency-Key returns 200 and the same order', replay.status === 200 && replay.body.orderId === orderId, replay);

  const conflict = await api.createOrder({ ...body, customerId: 'different' }, `${runId}-a`);
  check('same key with a different body returns 422', conflict.status === 422, conflict);

  const fetched = await api.getOrder(orderId);
  check('GET /orders/{id} returns 200', fetched.status === 200 && fetched.body.orderId === orderId, fetched);

  const final = await api.waitForTerminal(orderId, 60_000);
  check(`order reaches a terminal state (${final.status})`, final.status === 'CONFIRMED' || final.status === 'FAILED', final);
  check('history has one entry per transition', final.history.length === 3 && final.version === 2, final.history);

  const oos = await api.createOrder({ ...body, items: [{ sku: 'OOS-SMOKE', quantity: 1, unitPriceCents: 1 }] }, `${runId}-oos`);
  const oosFinal = await api.waitForTerminal(oos.body.orderId, 60_000);
  check('out-of-stock order ends FAILED with a reason', oosFinal.status === 'FAILED' && !!oosFinal.failureReason, oosFinal);

  const missing = await api.getOrder('ord_000000000000000000000000');
  check('GET unknown order returns 404', missing.status === 404, missing);

  const invalid = await api.createOrder({ customerId: runId, items: [] }, `${runId}-bad`);
  check('invalid body returns 400', invalid.status === 400, invalid);

  const noKey = await api.createOrder(body);
  check('missing Idempotency-Key returns 400', noKey.status === 400, noKey);

  console.log(failures === 0 ? '\nSmoke test passed.' : `\nSmoke test FAILED (${failures} check(s)).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
