import type { OrderView } from '../src/lib/order';

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  latencyMs: number;
}

export class RelayClient {
  constructor(private readonly baseUrl: string) {}

  async createOrder(body: unknown, idempotencyKey?: string, correlationId?: string): Promise<ApiResponse<OrderView>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (correlationId) headers['x-correlation-id'] = correlationId;
    return this.request('POST', '/orders', headers, JSON.stringify(body));
  }

  async getOrder(orderId: string): Promise<ApiResponse<OrderView>> {
    return this.request('GET', `/orders/${encodeURIComponent(orderId)}`, {});
  }

  /** Polls until the order reaches CONFIRMED or FAILED, or the timeout passes. */
  async waitForTerminal(orderId: string, timeoutMs = 60_000, intervalMs = 1_000): Promise<OrderView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.getOrder(orderId);
      if (res.status === 200 && (res.body.status === 'CONFIRMED' || res.body.status === 'FAILED')) return res.body;
      if (Date.now() > deadline) {
        throw new Error(`Order ${orderId} not terminal after ${timeoutMs}ms (last: ${res.status} ${JSON.stringify(res.body)})`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  private async request<T>(method: string, path: string, headers: Record<string, string>, body?: string): Promise<ApiResponse<T>> {
    const started = performance.now();
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { method, headers, body });
    const text = await res.text();
    const latencyMs = performance.now() - started;
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    return { status: res.status, body: parsed as T, latencyMs };
  }
}
