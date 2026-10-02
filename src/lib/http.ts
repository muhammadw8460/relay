import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** HTTP API (payload v2) lowercases header names already; this is defensive for tests and other callers. */
export function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function correlationIdFor(event: APIGatewayProxyEventV2): string {
  const supplied = header(event, 'x-correlation-id');
  if (supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return event.requestContext.requestId;
}

export function rawBody(event: APIGatewayProxyEventV2): string | undefined {
  if (event.body === undefined) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}
