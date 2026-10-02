function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function rate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

/** Read at call time (not import time) so tests can set env per case. */
export const config = {
  tableName: () => required('TABLE_NAME'),
  queueUrl: () => required('QUEUE_URL'),
  stage: () => process.env.STAGE ?? 'local',
  /** Probability that one inventory call throws a retryable error. */
  transientFailureRate: () => rate('TRANSIENT_FAILURE_RATE', 0),
  /** Probability that inventory is unavailable (a business failure: order -> FAILED). */
  outOfStockRate: () => rate('OUT_OF_STOCK_RATE', 0),
  simulatedWorkMs: () => int('SIMULATED_WORK_MS', 0),
  /** A duplicate POST re-enqueues a still-PENDING order once it is older than this. */
  reenqueueAfterMs: () => int('REENQUEUE_AFTER_MS', 30_000),
};
