export const METRICS_NAMESPACE = 'Relay';

export type MetricName =
  | 'OrdersCreated'
  | 'OrdersConfirmed'
  | 'OrdersFailed'
  | 'ProcessingLatencyMs'
  | 'DuplicateRequestsDetected';

type Unit = 'Count' | 'Milliseconds';

/**
 * Minimal CloudWatch Embedded Metric Format (EMF) writer.
 *
 * Metrics are written to stdout as a structured log line; CloudWatch extracts
 * them asynchronously, so recording a metric never adds a PutMetricData call
 * to the request path.
 * Spec: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
export class Metrics {
  private readonly values = new Map<MetricName, { unit: Unit; values: number[] }>();

  constructor(
    private readonly stage: string,
    private readonly properties: Record<string, unknown> = {},
  ) {}

  count(name: MetricName, value = 1): void {
    this.add(name, 'Count', value);
  }

  timing(name: MetricName, ms: number): void {
    this.add(name, 'Milliseconds', ms);
  }

  private add(name: MetricName, unit: Unit, value: number): void {
    const entry = this.values.get(name) ?? { unit, values: [] };
    entry.values.push(value);
    this.values.set(name, entry);
  }

  /** Emits one EMF document for everything recorded, then resets. No-op if empty. */
  flush(): void {
    if (this.values.size === 0) return;
    const doc: Record<string, unknown> = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRICS_NAMESPACE,
            Dimensions: [['Stage']],
            Metrics: [...this.values].map(([name, { unit }]) => ({ Name: name, Unit: unit })),
          },
        ],
      },
      Stage: this.stage,
      ...this.properties,
    };
    for (const [name, { values }] of this.values) {
      doc[name] = values.length === 1 ? values[0] : values;
    }
    console.log(JSON.stringify(doc));
    this.values.clear();
  }
}
