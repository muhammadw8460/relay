import type { OrderStatus } from './order';

/**
 * PENDING -> PROCESSING -> CONFIRMED | FAILED
 *
 * Terminal states have no outgoing edges, so a late or duplicate SQS delivery
 * can never move an order backwards.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Invalid order transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
