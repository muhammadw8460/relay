# Relay: Design Notes

This document explains the decisions behind Relay and the trade-offs I made. The README covers what it does and how to run it.

## 1. Goals and non-goals

**Goals**
- A client submits an order and gets an ID back right away. Slow or flaky work happens in the background.
- **No duplicate orders**, even when clients retry, the network drops responses, or SQS delivers a message more than once.
- **No double-applied state transitions.** A message delivered twice must not move an order twice.
- Failures are visible (metrics, alarms, DLQ) and recoverable (redrive) without logging into the console.
- Everything is code: infrastructure (CDK), deploys (GitHub Actions), and operations (scripts).

**Non-goals:** authentication, real payments or inventory, multi-region, or a UI.

## 2. Request lifecycle

```
POST /orders (Idempotency-Key: K)
  1. validate header + body (zod)                         -> 400 on failure
  2. orderId = "ord_" + sha256(K)[0:24]
  3. PutItem ORDER#orderId  IF attribute_not_exists(pk)
       ok     -> SendMessage {orderId} + correlationId attr -> 201 PENDING
       exists -> GetItem (consistent)
                   body hash differs -> 422
                   same body         -> 200 original order
                                        (re-enqueue if still PENDING after 30s)

processOrder (SQS batch of up to 10)
  for each record, concurrently:
    GetItem (consistent)
      missing / terminal  -> ack, do nothing
      PENDING             -> Update to PROCESSING IF version = v AND status = PENDING
      PROCESSING          -> resume (a previous attempt failed after claiming it)
    reserveInventory()    -> throws on transient failure (record is retried)
    Update to CONFIRMED|FAILED IF version = v+1 AND status = PROCESSING
  return { batchItemFailures: [only the records that threw] }
```

## 3. At-least-once delivery plus idempotency, instead of exactly-once

There is no exactly-once delivery between independent systems. SQS standard queues say so directly: a message can be delivered more than once, and a consumer that crashes after doing the work but before deleting the message will see it again. HTTP clients behave the same way: a request that timed out may or may not have reached the server, so the only safe move for the client is to retry.

So Relay accepts at-least-once delivery at every hop and makes each **effect** idempotent:

| Hop | Duplicate source | What makes it safe |
|---|---|---|
| Client -> API | Client retry after a timeout or 5xx | Idempotency key -> deterministic order ID -> conditional put. The second write fails the condition and the original order is returned. |
| API -> SQS | Re-enqueue on a duplicate POST; redrive script | The worker checks state before acting and skips terminal orders. |
| SQS -> worker | Redelivery after a crash or visibility timeout; two workers receiving the same message | Every status change is a conditional update on `version`. Only one writer per transition can succeed. |

The result is "effectively once": duplicates can still be *delivered*, but they can't be *applied*.

**Why a conditional write instead of check-then-insert?** A read followed by a write has a race window: two concurrent requests both read "not found" and both insert. `attribute_not_exists(pk)` moves the check into DynamoDB, which evaluates it atomically against the item. Exactly one of N concurrent puts can succeed. The unit tests run 25 concurrent identical requests against a fake table that enforces the same condition and assert exactly one `201`; the integration test does the same against the real table.

## 4. Idempotency key design

**The order ID is derived from the key** (`sha256`, truncated to 96 bits). That means the idempotency check and the order write are the *same* single-item operation. The alternative, a separate `IDEMPOTENCY#K -> orderId` item written in a `TransactWriteItems` with the order, costs twice the write capacity and adds a transaction for no extra safety at this scale. The cost of my approach is that the key determines the ID. That's fine here, but if clients shared a key namespace it would matter; see "Key scope" below.

**Same key, different body -> 422.** If a client reuses a key for a different order, silently returning the old order would hide a client bug. I store a hash of the validated body with the order and compare on replay. zod emits keys in schema order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` hash the same.

**Retry window.** Keys never expire here because the order *is* the idempotency record. A production system would put a TTL on the idempotency record (Stripe uses 24h) so keys can be reused and storage stays bounded. That is the point where a separate idempotency item becomes worth it.

**Key scope.** With no auth, keys are global. With auth, the ID would hash `tenantId + key` so two clients can't collide.

**The gap between put and send.** If the put succeeds and `SendMessage` fails, the order exists but nothing will process it. Relay returns a 500 so the client retries with the same key. The retry hits the duplicate path, sees the order is still `PENDING`, and re-enqueues it. To avoid flooding the queue with duplicate messages during a burst of normal retries, it only re-enqueues orders older than 30 s. A client that never retries leaves the order stuck in `PENDING`. That is what the reconciliation job in the stretch goals is for (scan for stale PENDING/PROCESSING orders and re-enqueue them). The transactional outbox pattern, or DynamoDB Streams -> SQS, would close the gap completely at the cost of more moving parts.

## 5. SQS standard vs. FIFO

| | Standard | FIFO |
|---|---|---|
| Delivery | At least once | Exactly-once *processing* within a 5-minute dedup window |
| Ordering | Best effort | Strict, per message group |
| Throughput | Nearly unlimited | 300 msg/s per API action (3,000 with batching; more with high-throughput mode) |
| Lambda scaling | Scales out to the concurrency limit | One concurrent batch per message group |

I chose **standard**:
- Orders are independent. There is nothing to keep in order across orders, and each order's state machine is protected by its version check, not by delivery order.
- FIFO's dedup is a 5-minute window keyed on a dedup ID. It doesn't cover a client retry 10 minutes later, a redrive from the DLQ, or a worker crash after the DynamoDB write. I'd need idempotent processing anyway, and once I have it, FIFO's guarantee adds nothing.
- Standard doesn't cap throughput and doesn't serialize processing per group.

FIFO would be the right call if the consumer's side effect *couldn't* be made idempotent and duplicates within a few minutes were the main risk, or if ordering mattered, e.g. applying a sequence of updates to the same account.

## 6. DynamoDB key design

One table, one item per order, `pk = ORDER#<orderId>`.

Access patterns:
1. Create an order if it doesn't exist -> conditional `PutItem` on `pk`.
2. Get an order by ID -> `GetItem` on `pk`.
3. Change an order's status if nobody else has -> conditional `UpdateItem` on `pk`.

All three are single-item operations on the partition key, so there is no GSI and no Query. The `ORDER#` prefix leaves room for other entity types in the same table later (single-table design) without a migration.

The partition key is a hash, so writes spread evenly across partitions. No hot keys regardless of traffic shape.

**On-demand billing:** traffic is spiky (idle, then load tests), and on-demand has no capacity to tune or throttle on. The trade-off is a higher per-request price, which at this volume is fractions of a cent.

**What I'd add next:** "list orders for a customer" would need a GSI on `customerId` with `createdAt` as the sort key. The audit script uses a `Scan` with a filter instead, which is fine for a dev table and something I'd never do on a hot path.

## 7. Optimistic concurrency

Every item has a `version` number. Each transition is:

```
UpdateItem
  SET status = :to, version = :v + 1, history = list_append(history, :change)
  IF  version = :v AND status = :from
```

If two deliveries of the same message race, both read `version = 0`. The first update succeeds and sets `version = 1`, and the second fails with `ConditionalCheckFailedException`. The loser re-reads and stops if the order is already terminal.

**Why not a lock or lease?** A lock needs an owner, a timeout, and cleanup when the holder dies. The version check has none of those: nothing is held, so nothing can be leaked. It is optimistic because conflicts are rare (they only happen on duplicate delivery), and when one happens the loser does no harm and just stops.

**Why is PROCESSING resumable?** A worker can claim an order (`PENDING -> PROCESSING`) and then fail transiently in the inventory call. When SQS redelivers, the order is already `PROCESSING`. If the worker required `PENDING`, the order would be stuck forever. So `PROCESSING` means "claimed, not finished", and a retry picks it up from there. The price is that two concurrent deliveries can both call inventory. In a real system the reservation call would take `orderId` as its own idempotency key. That is the same pattern, one level down.

**`history`** is an append-only list of transitions, updated in the same conditional write. It's mostly for debugging, but it also makes "a transition applied twice" *detectable*. The audit script checks that every order's history is a valid prefix of `PENDING -> PROCESSING -> CONFIRMED|FAILED` and that `version = len(history) - 1`.

## 8. Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| Invalid request | 400 with field-level errors; nothing written | Client fixes the request |
| Client retries a request that succeeded | 200 with the original order | Automatic |
| Put succeeds, `SendMessage` fails | 500, order stays PENDING | Client retry re-enqueues; reconciliation job (stretch) |
| Inventory call fails transiently | Record in `batchItemFailures`; only that message is retried | Automatic, up to 3 receives |
| Worker crashes or times out mid-batch | Whole batch becomes visible again after the 60 s visibility timeout | Automatic; finished orders are skipped on redelivery |
| 3 failed receives | Message moves to the DLQ; order stays PROCESSING; DLQ alarm fires | Investigate by correlation ID, fix, `npm run redrive` |
| Malformed message (poison) | Throws on parse and is retried, then lands in the DLQ | Inspect with `npm run redrive -- --dry-run` |
| Same message delivered twice concurrently | One conditional write wins; the other stops | Automatic |
| Business failure (out of stock) | Order -> FAILED with `failureReason`, no retry | By design |

**Why ReportBatchItemFailures?** Without it, one failed record in a batch of 10 makes Lambda return the whole batch to the queue, and the 9 successes are processed again. With idempotent processing that is *safe* but wasteful, and it burns receive counts: a message that keeps sharing a batch with a bad one can reach the DLQ without ever failing itself.

**Why maxReceiveCount = 3?** At a 10% transient failure rate, the chance that one message fails 3 times in a row is 0.1%. That's rare enough that the DLQ means something, and frequent enough that a load test will actually exercise the DLQ path. The visibility timeout is 6x the worker timeout (AWS guidance), so a slow but healthy batch isn't redelivered while it's still running.

## 9. Polling instead of webhooks

The client polls `GET /orders/{id}` until the status is terminal.

- **Simple for clients:** no public endpoint to host, no signature verification, no retry handling on their side.
- **Simple for the server:** a webhook sender is its own reliable-delivery problem: retries with backoff, a DLQ per subscriber, signing, protection against a slow or dead subscriber, and SSRF protection for user-supplied URLs. That's a second project.
- **Cheap at this scale:** a `GetItem` is an eventually consistent single-item read, and orders finish in well under a second at p50.

The cost is latency (up to one poll interval) and wasted reads while waiting. If clients needed near-real-time updates, or the processing took minutes, I'd add webhooks or WebSocket push fed from DynamoDB Streams, still keeping `GET` as the source of truth. Webhooks are notifications, and state still lives behind the API.

## 10. Observability

- **Structured JSON logs**, one object per line, with `correlationId` on every line. It comes from the `x-correlation-id` request header (or the API Gateway request ID), is stored on the order, travels as an SQS message attribute, and is logged by the worker. One Logs Insights query across all three log groups shows a request's full path.
- **EMF metrics** are written as log lines and extracted by CloudWatch asynchronously, so metrics never add a `PutMetricData` call or latency to the request path.
- **Alarms** on symptoms users would feel: DLQ depth > 0 (work that won't finish on its own), API 5xx rate > 5%, Lambda error rate > 5%. I didn't alarm on transient retries: they're expected and handled automatically.
- **Dashboard** with alarms, business metrics, API and processing latency, queue depth and age, and Lambda errors/throttles.

A 5xx *rate* can't be computed from one metric, so the alarms use metric math (`100 * errors / requests`), guarded against divide-by-zero when there's no traffic.

## 11. Security

- **Least-privilege IAM per function.** `createOrder`: `PutItem`, `GetItem`, `SendMessage`. `getOrder`: `GetItem`. `processOrder`: `GetItem`, `UpdateItem`, plus receive/delete on its queue. A CDK assertion test fails the build if, for example, `createOrder` gains `UpdateItem`.
- **No long-lived AWS keys in CI.** GitHub Actions gets short-lived credentials through OIDC. The deploy role only trusts `repo:muhammadw8460/relay:ref:refs/heads/main` and can only assume the CDK bootstrap roles.
- Queues enforce TLS. The API validates and caps every input: size limits on keys, items, and quantities, and unknown fields are rejected.
- API stage throttling (200 rps, burst 400) bounds cost if something misbehaves.

## 12. What I'd do next

1. **Reconciliation job:** a scheduled Lambda that finds orders stuck in PENDING or PROCESSING for more than 5 minutes and re-enqueues them. This closes the put/send gap and makes the DLQ a place for real bugs only.
2. **Step Functions** for `processOrder` once there are more steps (reserve, charge, notify), to get per-step retries and a visual execution history.
3. **Idempotency TTL** with a separate idempotency item, so keys can expire.
4. **Auth** (Cognito or IAM) and tenant-scoped keys.
5. **X-Ray / OpenTelemetry tracing** to go with the correlation IDs.
