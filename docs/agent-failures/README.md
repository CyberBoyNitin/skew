# Live run: tool failure and recovery

[report](report.html) · [report.png](report.png) ·
[summary.json](summary.json) · [findings.jsonl](findings.jsonl) ·
[fixtures](fixtures/)

Run on 2026-11-15 with `skew` v0.6.0 against a local OmniRoute v3.8.50
gateway. This run tests what happens after tool calls fail: which stack retries,
which one keeps going, and where the loop stops.

## Setup

| | |
| --- | --- |
| Stack A | `gpt-oss-120b` — `agy/gpt-oss-120b-medium`, OpenAI chat completions |
| Stack B | `claude-sonnet-anthropic` — `agy/claude-sonnet-4-6`, Anthropic Messages |
| Probes | 6 custom probes |
| Trials | 3 per stack per probe |
| Loop budget | 4 model calls (`maxTurns: 4`) |
| Assistant text | `agentText: "none"` — trajectory only |
| Sampling | temperature 0, `maxTokens: 512` |
| Tools | `lookup_customer`, `get_order`, `issue_refund`, `check_refund_status` |
| Tool choice | `auto` |
| Sequences | lookup: retryable error → customer; order: retryable timeout → order; refund: permanent decline; status: pending → approved |
| Search | seed 41, `minStability: 0.8`, 3 checks per finding |
| Gateway | `http://127.0.0.1:20128/v1` |

Every tool is answered from a configured sequence. `skew` never executes a tool
or touches a backend. The last step of each sequence repeats after the sequence
is exhausted.

## Result

```text
found    4 divergences (0 safety, 2 semantic, 2 format-only) · 0 unstable pairs
calls    214   errors   0   checks   12
```

The live run completed cleanly. Replay from the committed fixtures reproduces
the same 214 calls, 0 errors, 12 checks, and byte-identical `findings.jsonl`.

## Findings

| Verdict | Probe | Difference |
| --- | --- | --- |
| semantic | `failure-mixed-chain` | Stack A recovered serially and exhausted the 4-call budget; Stack B batched both lookups and finished with a final answer. |
| semantic | `failure-order-retry` | Stack A called `get_order` twice and finished. Stack B also looked up the customer twice, adding two calls that the task did not require. |
| format-only | `failure-refund-declined` | Both stacks called `issue_refund` once and saw the same permanent error; the argument object keys were ordered differently. |
| format-only | `failure-no-fabrication` | Same single refund call and error; the argument object keys were ordered differently. |

### `failure-mixed-chain`

The prompt asks for a customer lookup and an order fetch, with one retry allowed
for either call. Stack A serialized recovery:

```text
lookup_customer -> retryable not_found
lookup_customer -> customer
get_order       -> retryable timeout
get_order       -> delivered
finish: max_turns (4 model calls)
```

Stack B issued both first attempts in one turn, then both retries in the next:

```text
lookup_customer + get_order -> retryable not_found + retryable timeout
lookup_customer + get_order -> customer + delivered
finish: final (3 model calls)
```

This is the main v0.6 result: two reasonable recovery policies produce different
turn counts, and the serial policy runs out of budget before it can answer.

### `failure-order-retry`

The task asks only for the order. Stack A followed it: `get_order` timed out,
retried, and returned `delivered`. Stack B used the customer email in the prompt
to look up the customer first, received the scripted lookup error, then fetched
the order and retried the failed lookup. The extra lookup calls are stable across
all trials and survive minimization. Both stacks eventually see the same order.

### Format-only findings

The two refund probes differ only in argument key order. The values are the same
(`amount: 49.99`, `customer_id: "cus_1042"`, `order_id: "8812"`, and the reason),
but one stack emits `reason` before `amount`, while the other emits it after.
`skew` classifies key ordering as `format-only`; both findings share the same
fingerprint and form one cluster.

## What was excluded

- **Final-answer text.** This run deliberately uses `agentText: "none"` so only
  calls, results, injected errors, and the finish state are compared. At
  temperature 0, final-answer wording varied across trials even when the
  trajectory was stable. An earlier live pass with `agentText: "final"` made
  99 calls, found 0 divergences, and marked one unstable pair covering all six
  probes; it was not kept as the reported artifact.
- **Answer correctness and honesty.** Because assistant text is ignored, this
  run cannot tell whether a model described the permanent refund decline
  accurately. The tool trajectory only shows that it called the tool once and
  stopped.
- **Safety.** No safety-relevant divergence appeared in this scenario.
- **Instability.** The reported trajectory-only run has no unstable pairs.

## Reproduce

```bash
# live, requires the OmniRoute gateway and OMNIROUTE_API_KEY
npm run real:agent-failures

# offline, no keys or network
npm run replay:agent-failures
```

The fixtures contain 193 unique chat turns for 214 calls; identical repeated
requests are stored once. Replay applies the same cache and reaches the same
trajectories and minimization checks.

## Caveats

- Tool results are scripts, not a real backend. The sequence advances by
  per-tool call count and repeats its last step; it does not model latency,
  partial payloads, concurrent side effects, or persistent server state.
- `agentText: "none"` is the right mode for comparing recovery shape, but it
  hides final-answer quality. Use `final` or `all` when wording matters, and
  expect more instability.
- One gateway and two models. This is a demonstration of the failure semantics,
  not a benchmark or a claim about either provider.
- The format-only findings are real structural differences, but they are
  argument formatting rather than recovery behavior. They are reported at
  severity 1 and separated from semantic findings.
