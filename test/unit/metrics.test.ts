import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/lib/logger';
import { Metrics } from '../../src/lib/metrics';

describe('Metrics (EMF)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a valid EMF document and aggregates repeated values', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = new Metrics('dev', { correlationId: 'c-1' });
    m.count('OrdersConfirmed');
    m.count('OrdersConfirmed');
    m.timing('ProcessingLatencyMs', 120);
    m.flush();

    expect(spy).toHaveBeenCalledTimes(1);
    const doc = JSON.parse(String(spy.mock.calls[0][0]));
    expect(doc._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: 'Relay',
      Dimensions: [['Stage']],
      Metrics: [
        { Name: 'OrdersConfirmed', Unit: 'Count' },
        { Name: 'ProcessingLatencyMs', Unit: 'Milliseconds' },
      ],
    });
    expect(typeof doc._aws.Timestamp).toBe('number');
    expect(doc).toMatchObject({ Stage: 'dev', correlationId: 'c-1', OrdersConfirmed: [1, 1], ProcessingLatencyMs: 120 });
  });

  it('does nothing when no metrics were recorded, and resets after flush', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = new Metrics('dev');
    m.flush();
    m.count('OrdersCreated');
    m.flush();
    m.flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('logger', () => {
  it('writes one JSON line with base fields and serialized errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger({ correlationId: 'c-1' }).child({ orderId: 'o-1' }).error('failed', { error: new Error('boom') });
    const entry = JSON.parse(String(spy.mock.calls[0][0]));
    expect(entry).toMatchObject({ level: 'ERROR', message: 'failed', correlationId: 'c-1', orderId: 'o-1', service: 'relay' });
    expect(entry.error).toMatchObject({ name: 'Error', message: 'boom' });
  });
});
