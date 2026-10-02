import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '../../src/lib/order';
import { InvalidTransitionError, assertTransition, canTransition, isTerminal } from '../../src/lib/state';

describe('order state machine', () => {
  const allowed: [OrderStatus, OrderStatus][] = [
    ['PENDING', 'PROCESSING'],
    ['PROCESSING', 'CONFIRMED'],
    ['PROCESSING', 'FAILED'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every other transition', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const isAllowed = allowed.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(isAllowed);
      }
    }
  });

  it('never skips PROCESSING or moves backwards', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(false);
    expect(canTransition('PROCESSING', 'PENDING')).toBe(false);
    expect(canTransition('CONFIRMED', 'FAILED')).toBe(false);
    expect(() => assertTransition('FAILED', 'CONFIRMED')).toThrow(InvalidTransitionError);
  });

  it('treats CONFIRMED and FAILED as terminal', () => {
    expect(isTerminal('CONFIRMED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('PENDING')).toBe(false);
    expect(isTerminal('PROCESSING')).toBe(false);
  });
});
