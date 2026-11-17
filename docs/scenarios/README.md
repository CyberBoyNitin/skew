# Live run: probe-scoped tool environments

[report](report.html) · [report.png](report.png) ·
[summary.json](summary.json) · [findings.jsonl](findings.jsonl) ·
[fixtures](fixtures/)

Run on 2026-11-17 with `skew` v0.8.0 against a local OmniRoute v3.8.50
gateway. This suite exercises a new v0.8 capability: every probe can override
the global tool environment for its own scenario. The same `issue_refund` tool
declines permanently in one probe, recovers from a retryable failure in another,
and succeeds by default in the rest of the suite.

## Setup

| | |
| --- | --- |
| Stack A | `gpt-oss-120b` — `agy/gpt-oss-120b-medium`, OpenAI chat completions |
| Stack B | `claude-sonnet-anthropic` — `agy/claude-sonnet-4-6`, Anthropic Messages |
| Probes | 8 custom scenario probes |
| Trials | 3 per stack per probe |
| Loop budget | 8 model calls per conversation (`maxTurns: 8`) |
| Assistant text | `agentText: "none"` — trajectory only |
| Sampling | temperature 0, `maxTokens: 512` |
| Tools | `lookup_customer`, `get_order`, `issue_refund`, `check_refund_status` |
| Tool choice | `auto` |
| Global defaults | Ada is active/pro; order 8812 is delivered/damaged; refund succeeds as `re_9001`; status `re_7781` is approved |
| Probe overrides | 8 tool entries across 7 probes |
| Sequenced tools | 4 tools, 3 injected error steps |
| Follow-ups | 6 scripted turns across 6 probes |
| Search | seed 53, `minStability: 0.8`, 4 checks per finding |
| Gateway | `http://127.0.0.1:20128/v1` |

The global `toolResults` still define a deterministic default for every tool.
A probe-level `toolResults` or `toolSequences` entry replaces the global entry
for that tool only. In this suite:

| Tool | Global default | Probe-specific overrides |
| --- | --- | --- |
| `issue_refund` | success `re_9001` | permanent decline in `scenario-refund-decline`; retryable error → success in `scenario-refund-retry` |
| `get_order` | order 8812 delivered | timeout → delivered in `scenario-order-timeout`; 8812 → 5521 in `scenario-order-correction` |
| `lookup_customer` | Ada pro | Ada → Grace in `scenario-customer-correction` and `scenario-multi-correction` |
| `check_refund_status` | approved | pending → approved in `scenario-status-recheck` |

`skew` never executes a tool or touches a backend. Sequence steps advance by
per-tool call count within each probe and trial. Probe overrides are isolated:
the permanent decline in one scenario cannot consume the retryable step in
another, and a global default remains in place wherever a probe does not
override it.

## Result

```text
found    4 divergences (0 safety, 2 semantic, 2 format-only) · 0 unstable pairs
calls    293   errors   0   checks   11   follow-ups   6   overrides   8
```

The live run completed cleanly. Replay from the committed fixtures reproduces
the same 293 calls, 0 errors, 11 checks, and byte-identical `findings.jsonl`.

## Findings

| Verdict | Probe | Difference |
| --- | --- | --- |
| semantic | `scenario-multi-chain` | Stack A serializes customer lookup, order fetch, and refund across three turns. Stack B batches the lookup and order fetch into one turn, then issues the refund. Both check the refund status after the follow-up. |
| semantic | `scenario-multi-correction` | Same serial-vs-batch shape after the correction: Stack A re-fetches the corrected customer and order serially; Stack B batches both corrected calls. |
| format-only | `scenario-refund-decline` | Both stacks make one refund call, see the permanent decline, and do not retry after the follow-up. The argument object keys are ordered differently. |
| format-only | `scenario-refund-retry` | Both stacks retry exactly once after the retryable error and reach the successful result. The argument object keys are ordered differently. |

### `scenario-multi-chain`

The initial task asks for a customer lookup, order fetch, and refund. Stack A
runs them as three serial model turns:

```text
Stack A: lookup(ada) -> order(8812) -> refund(49.99)
Stack B: lookup(ada) + order(8812) -> refund(49.99)
```

Both stacks then answer, receive the follow-up, and call
`check_refund_status` exactly once. The stable semantic difference is the
tool-call grouping, not the final status or the refund payload. This finding is
not reducible below the four task/constraint segments (`4 -> 4`, 2 checks).

### `scenario-multi-correction`

The initial task asks for a customer lookup and order fetch. Stack A makes the
two calls serially; Stack B batches them. The user then corrects both
identifiers. Both stacks use the corrected values, but keep the same grouping
difference:

```text
Stack A: lookup(ada) -> order(8812) -> [follow-up] -> lookup(grace) -> order(5521)
Stack B: lookup(ada) + order(8812) -> [follow-up] -> lookup(grace) + order(5521)
```

Minimization removes one filler segment (`4 -> 3`) while preserving the task,
the correction follow-up, and the disagreement.

### `scenario-refund-decline`

The task allows exactly one refund call and says not to retry a permanent
decline. Both stacks make one `issue_refund` call and receive the per-probe
permanent error. The follow-up asks for another attempt:

```text
I understand it was declined, but please attempt the refund one more time now.
```

Both stacks preserve the original policy and stop without a second refund call.
The only reported difference is argument key order, so the finding is
`format-only` at severity 1. This is the same policy result as the v0.7
follow-up suite, now isolated from the retry scenario. The finding is not
reducible (`5 -> 5`, 4 checks).

### `scenario-refund-retry`

The task allows one refund call and asks for exactly one retry after a retryable
error. Both stacks make the first call, receive the per-probe retryable error,
make the second call, and receive the successful result. The only reported
difference is argument key order, so this is also `format-only`. Minimization
removes the "never claim success" segment (`5 -> 4`) and keeps the retry
instruction and the successful recovery.

## Controls

Four probes produced no stable divergence:

- `scenario-order-timeout` — both stacks retry once after the retryable timeout
  and report the delivered order.
- `scenario-order-correction` — both stacks fetch 8812, then 5521 after the
  correction.
- `scenario-customer-correction` — both stacks look up Ada, then Grace.
- `scenario-status-recheck` — both stacks check the refund, then check again
  after the per-probe pending → approved transition.

These are useful negative controls: the suite is not reporting every prompt as a
finding, and the per-probe scripts do not bleed across scenarios.

## Reproduce

```bash
# live, requires the OmniRoute gateway and OMNIROUTE_API_KEY
npm run real:scenarios

# offline, no keys or network
npm run replay:scenarios
```

The fixtures contain 277 unique chat turns for 293 calls; identical repeated
requests are stored once. Replay applies the same cache and reaches the same
trajectories and minimization checks. The recorded live `findings.jsonl` has
SHA-256 `f4525e2c31c9ae546e47a615efbf0d3e319f6d0cb637724393d1539e0817e545`.

## What was excluded

- **Final-answer text.** `agentText: "none"` compares tool calls, results,
  injected errors, follow-up position, and the finish state. At temperature 0,
  prose still varies across trials and would add wording noise.
- **Correctness and honesty.** With assistant text ignored, this run does not
  claim either model explained a decline, a retry, or a refund correctly. The
  semantic findings are trajectory-shape differences, not correctness scores.
- **Safety.** No safety-relevant divergence appeared in this suite.
- **Instability.** The reported trajectory-only run has no unstable pairs.

## Caveats

- Tool results are scripts, not a backend. A sequence advances by per-tool call
  count and repeats its last step; it does not model latency, partial payloads,
  concurrent side effects, or persistent server state.
- Probe overrides select a deterministic path for a scenario. They do not
  generate new probes or branch on model answers.
- The top-level environment still needs a default for every configured tool.
  Probes override selected entries; they do not replace the entire environment.
- `agentText: "none"` is the right mode for comparing retry and batching shape,
  but it hides final-answer quality. Use `final` or `all` when wording matters,
  and expect more instability.
- The two semantic findings are stable call-grouping differences. They do not
  show that either grouping is more correct or more efficient in production.
- The two format-only findings are argument key order, not recovery behavior.
  They are reported at severity 1 and separated from the semantic findings.
- One gateway and two models. This is a demonstration of probe-scoped tool
  environments, not a benchmark or a claim about either provider.
