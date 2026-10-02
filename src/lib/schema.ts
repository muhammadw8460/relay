import { z } from 'zod';

export const IdempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(128, 'Idempotency-Key must be at most 128 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key may only contain letters, digits, and . _ : -');

export const OrderItemSchema = z
  .object({
    sku: z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'sku must be alphanumeric with dashes'),
    quantity: z.number().int().min(1).max(100),
    unitPriceCents: z.number().int().min(0).max(10_000_000),
  })
  .strict();

export const CreateOrderSchema = z
  .object({
    customerId: z.string().min(1).max(64),
    currency: z.enum(['USD', 'CAD', 'EUR', 'GBP']).default('USD'),
    items: z.array(OrderItemSchema).min(1).max(50),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export const OrderIdSchema = z.string().regex(/^ord_[0-9a-f]{24}$/);

/** Body of the message put on order-queue. */
export const OrderMessageSchema = z.object({ orderId: OrderIdSchema });
export type OrderMessage = z.infer<typeof OrderMessageSchema>;

export function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
