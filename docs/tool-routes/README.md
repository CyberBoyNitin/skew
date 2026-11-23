# Example: argument-aware tool routes

[config](../../examples/tool-routes.config.json) ·
[probes](../../examples/tool-routes.probes.json)

This example exercises the v0.9 `toolRoutes` feature. Instead of answering every
call to a tool with one static result or one ordered sequence, each tool has a
list of routes selected by the call's arguments. The same tool can return
different records for different customer emails and order ids, and a status tool
can keep independent pending → approved sequences for different refund ids.

This is a ready-to-run configuration example, not a recorded live run: no
fixtures are committed for it, so it needs a reachable gateway and credentials.

## Setup

| | |
| --- | --- |
| Config | [`examples/tool-routes.config.json`](../../examples/tool-routes.config.json) |
| Probes | [`examples/tool-routes.probes.json`](../../examples/tool-routes.probes.json) — 10 custom probes |
| Trials | 3 per stack per probe |
| Loop budget | 8 model calls per conversation (`maxTurns: 8`) |
| Assistant text | `agentText: "none"` — trajectory only |
| Sampling | temperature 0, `maxTokens: 512` |
| Tools | `lookup_customer`, `get_order`, `issue_refund`, `check_refund_status` |
| Tool choice | `auto` |
| Global routes | 11 rules across 4 tools |
| Probe overrides | 6 route rules across 3 probes, including 2 injected error steps |
| Follow-ups | 6 scripted turns across 6 probes |
| Search | seed 59, `minStability: 0.8`, 4 checks per finding |
| Gateway | `http://127.0.0.1:20128/v1` |

```bash
npm run real:tool-routes
```

## Matching rules

A route has an optional `when` object and exactly one response: `result`,
`error`, or `sequence`.

| Tool | Route behavior |
| --- | --- |
| `lookup_customer` | Ada (`ada@example.com`) and Grace (`grace@example.com`) return different customer records; any other email returns `customer_not_found`. |
| `get_order` | Orders `8812` and `5521` return different records; any other id returns `order_not_found`. |
| `issue_refund` | Order `8812` approves as `re_9001`; any other order returns `refund_not_allowed`. |
| `check_refund_status` | `re_9001` is approved; `re_7781` advances from pending to approved across calls; any other id returns `refund_status_not_found`. |

- A route matches when every key in `when` is present in the parsed call
  arguments and equal to the expected value. Matching is recursive for nested
  objects, requires arrays to have the same length and order, and ignores extra
  argument keys.
- The first matching route wins. A route without `when` is a fallback: there can
  be at most one, and it must be last.
- A call that matches no route receives an injected `no_matching_tool_route`
  error, so the model sees a deterministic failure rather than a real tool call.
- Sequences inside routes advance by call count per tool *and route*. Two refund
  ids can therefore hold independent pending → approved state in the same run.
  As with global sequences, the last step repeats once exhausted.
- A tool cannot combine `toolRoutes` with `toolResults` or `toolSequences`. A
  probe-level `toolRoutes` entry replaces the global route list for that tool
  only and follows the same collision rules.

The first three probes override `issue_refund` or `get_order` to test a permanent
decline, a retryable failure that recovers, and an order timeout that recovers.
The remaining probes use the global routes to exercise corrections, a multi-tool
chain, a status recheck, not-found handling, and reversed call order.

## Reporting and caveats

The CLI summary and HTML report show routed tools and the total number of route
rules when routes are configured. Because `agentText` is `"none"`, only the tool
trajectory, returned results, injected errors, and stop state are compared;
assistant wording is not part of a finding.

`skew` never executes a tool or validates arguments against a live backend.
Routes match only the arguments the model emitted; a model that sends a
different id than the task specified can take the fallback path, which is itself
a useful divergence to compare across stacks. As with any live configuration,
model-version changes will change the trajectories, and this example has no
committed fixtures for byte-identical replay.
