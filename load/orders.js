/**
 * k6 load test for POST /orders at increasing arrival rates.
 *
 *   k6 run -e API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com load/orders.js
 *
 * Optional: -e PEAK_RPS=100 (default 100), -e RUN_ID=k6-myrun
 *
 * ~10% of iterations immediately retry with the same Idempotency-Key, as a
 * client would after a timeout. Every such retry must return 200 with the
 * original order ID; any retry that creates a new order counts as an
 * unexpected duplicate, and the run fails if that count is above zero.
 *
 * After the run, confirm against the table itself:
 *   npm run audit -- --customer <RUN_ID printed below>
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const API_URL = (__ENV.API_URL || '').replace(/\/$/, '');
const RUN_ID = __ENV.RUN_ID || `k6-${Date.now()}`;
const PEAK = Number(__ENV.PEAK_RPS || 100);
const RETRY_RATE = 0.1;

if (!API_URL) throw new Error('Pass the API URL: k6 run -e API_URL=https://... load/orders.js');

const ordersCreated = new Counter('orders_created');
const duplicatesDetected = new Counter('duplicate_requests_detected');
const unexpectedDuplicates = new Counter('unexpected_duplicates');

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.round(PEAK * 0.05)),
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { target: Math.round(PEAK * 0.1), duration: '30s' },
        { target: Math.round(PEAK * 0.25), duration: '30s' },
        { target: Math.round(PEAK * 0.5), duration: '30s' },
        { target: PEAK, duration: '30s' },
        { target: PEAK, duration: '60s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    'http_req_failed{type:create}': ['rate<0.01'],
    'http_req_duration{type:create}': ['p(50)<300', 'p(99)<1500'],
    'http_req_duration{type:retry}': ['p(99)<1500'],
    unexpected_duplicates: ['count==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  console.log(`RUN_ID=${RUN_ID}  API_URL=${API_URL}  PEAK_RPS=${PEAK}`);
  return { runId: RUN_ID };
}

export default function (data) {
  const key = `${data.runId}-${__VU}-${__ITER}`;
  const body = JSON.stringify({
    customerId: data.runId,
    items: [{ sku: 'WIDGET-1', quantity: 1 + (__ITER % 3), unitPriceCents: 1999 }],
  });
  const params = (type) => ({
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-correlation-id': key },
    tags: { type },
  });

  const res = http.post(`${API_URL}/orders`, body, params('create'));
  check(res, { 'create -> 201': (r) => r.status === 201 });
  if (res.status === 201) ordersCreated.add(1);
  else if (res.status === 200) unexpectedDuplicates.add(1); // a fresh key must never look like a replay

  if (res.status === 201 && Math.random() < RETRY_RATE) {
    const retry = http.post(`${API_URL}/orders`, body, params('retry'));
    const sameOrder = retry.status === 200 && retry.json('orderId') === res.json('orderId');
    check(retry, { 'retry -> 200 same order': () => sameOrder });
    if (sameOrder) duplicatesDetected.add(1);
    else if (retry.status === 201 || retry.status === 200) unexpectedDuplicates.add(1);
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const val = (name, stat) => (m[name] && m[name].values[stat] !== undefined ? m[name].values[stat] : 0);
  const create = 'http_req_duration{type:create}';
  const results = {
    runId: RUN_ID,
    peakTargetRps: PEAK,
    totalRequests: val('http_reqs', 'count'),
    throughputRps: Number(val('http_reqs', 'rate').toFixed(1)),
    ordersCreated: val('orders_created', 'count'),
    duplicateRequestsDetected: val('duplicate_requests_detected', 'count'),
    unexpectedDuplicates: val('unexpected_duplicates', 'count'),
    createLatencyMs: {
      p50: Number(val(create, 'med').toFixed(1)),
      p90: Number(val(create, 'p(90)').toFixed(1)),
      p99: Number(val(create, 'p(99)').toFixed(1)),
      max: Number(val(create, 'max').toFixed(1)),
    },
    errorRate: val('http_req_failed{type:create}', 'rate'),
  };

  const headline =
    `\n=== Relay load test ${RUN_ID} ===\n` +
    `throughput     ${results.throughputRps} req/s (${results.totalRequests} requests)\n` +
    `create p50/p99 ${results.createLatencyMs.p50} / ${results.createLatencyMs.p99} ms\n` +
    `orders created ${results.ordersCreated}\n` +
    `retries dedup'd ${results.duplicateRequestsDetected}\n` +
    `unexpected dup ${results.unexpectedDuplicates}\n` +
    `error rate     ${(results.errorRate * 100).toFixed(2)}%\n` +
    `next: npm run audit -- --customer ${RUN_ID}\n`;

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + headline,
    [`load/results/${RUN_ID}.json`]: JSON.stringify(results, null, 2),
  };
}
