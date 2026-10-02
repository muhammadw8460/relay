import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { correlationIdFor, errorBody, json } from '../lib/http';
import { createLogger } from '../lib/logger';
import { toView } from '../lib/order';
import { getOrder } from '../lib/orders-repo';
import { OrderIdSchema } from '../lib/schema';

/** GET /orders/{id}: 200 with the order, 404 if unknown (including malformed IDs). */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const correlationId = correlationIdFor(event);
  const log = createLogger({ handler: 'getOrder', correlationId });
  const respond = (status: number, body: unknown) => json(status, body, { 'x-correlation-id': correlationId });
  const notFound = () => respond(404, errorBody('ORDER_NOT_FOUND', 'Order not found'));

  const id = OrderIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return notFound();

  try {
    const order = await getOrder(id.data);
    if (!order) return notFound();
    return respond(200, toView(order));
  } catch (error) {
    log.error('getOrder failed', { orderId: id.data, error });
    return respond(500, errorBody('INTERNAL_ERROR', 'Internal error'));
  }
};
