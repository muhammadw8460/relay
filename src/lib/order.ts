export const ORDER_STATUSES = ['PENDING', 'PROCESSING', 'CONFIRMED', 'FAILED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface StatusChange {
  status: OrderStatus;
  at: string;
}

/** The order record as stored in DynamoDB. */
export interface Order {
  pk: string;
  orderId: string;
  idempotencyKey: string;
  /** sha256 of the validated request body; detects a key reused with a different payload. */
  requestHash: string;
  customerId: string;
  items: OrderItem[];
  currency: string;
  totalCents: number;
  status: OrderStatus;
  /** Optimistic-concurrency counter. Every status change is conditional on it and bumps it by one. */
  version: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  /** Append-only audit trail. A repeated status here would mean a transition applied twice. */
  history: StatusChange[];
}

/** What the API returns: internal bookkeeping fields stripped. */
export type OrderView = Omit<Order, 'pk' | 'requestHash'>;

export function toView(order: Order): OrderView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pk, requestHash, ...view } = order;
  return view;
}

export const orderPk = (orderId: string): string => `ORDER#${orderId}`;
