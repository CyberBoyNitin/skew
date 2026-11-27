# Live run: follow-up conversations

[report](report.html) · [report.png](report.png) ·
[summary.json](summary.json) · [findings.jsonl](findings.jsonl) ·
[fixtures](fixtures/)

Run on 2026-11-16 with `skew` v0.7.0 against a local OmniRoute v3.8.50
gateway. This run tests what happens after a final answer: `skew` appends a
scripted user follow-up to the same chat history and keeps comparing the stacks.
The probes cover corrections, a second order, a status recheck, and a retry
request after a permanent refund decline.

## Setup

| | |
| --- | --- |
| Stack A | `gpt-oss-120b` — `agy/gpt-oss-120b-medium`, OpenAI chat completions |
| Stack B | `claude-sonnet-anthropic` — `agy/claude-sonnet-4-6`, Anthropic Messages |
| Probes | 6 custom conversation probes, one follow-up each |
| Trials | 3 per stack per probe |
| Loop budget | 8 model calls for the whole conversation (`maxTurns: 8`) |
| Assistant text | `agentText: "none"` — trajectory only |
| Sampling | temperature 0, `maxTokens: 512` |
| Tools | `lookup_customer`, `get_order`, `issue_refund`, `check_refund_status` |
| Tool choice | `auto` |
| Sequences | lookup: Ada → Grace; order: 8812 → 5521; refund: permanent decline → success; status: pending → approved |
| Search | seed 47, `minStability: 0.8`, 4 checks per finding |
| Gateway | `http://127.0.0.1:20128/v1` |

Every tool is answered from a configured sequence. `skew` never executes a
tool or touches a backend. The last step of each sequence repeats after the
sequence is exhausted. Tool call counts persist across follow-ups, so a retry
in a later user turn sees the next sequence step.

## Result

```text
found    2 divergences (0 safety, 1 semantic, 1 format-only) · 0 unstable pairs
calls    220   errors   0   checks   5   follow-ups   6
```

The live run completed cleanly. Replay from the committed fixtures reproduces
the same 220 calls, 0 errors, 5 checks, and byte-identical `findings.jsonl`.

## Follow-up semantics

- A follow-up is sent only after an assistant turn with no tool calls.
- The follow-up is appended to the same history as a normal user message; the
  next model call sees the complete conversation.
- `maxTurns` covers the whole conversation. A follow-up that cannot fit in the
  remaining budget is not sent, and the trace finishes as `max_turns`.
- Trace turns that begin after a follow-up carry a `user` field. The initial
  prompt is still reported separately, so traces with no follow-ups keep the
  v0.6 shape.
- Follow-ups are fixed during minimization. Only initial-prompt segments are
  removed; the report shows the fixed follow-ups next to the minimized prompt.

Replay is namespaced by probe id as well as message history and trial. Two
probes can share an initial prompt but ask different follow-ups without their
recorded first turns overwriting each other.

## Findings

| Verdict | Probe | Difference |
| --- | --- | --- |
| semantic | `followup-multi-correction` | Both stacks apply the corrected customer and order ids across the follow-up. Stack A serializes the lookup and order calls; Stack B batches them. |
| format-only | `followup-refund-retry` | Both stacks make one refund call, see the permanent decline, and do not retry after the follow-up. The argument object keys are ordered differently. |

### `followup-multi-correction`

The initial task asks for a customer lookup and an order fetch. Stack A makes
the two calls in serial turns; Stack B batches both into one turn. The user then
corrects both identifiers:

```text
Correction: both identifiers were wrong. Use grace@example.com and order 5521
instead. Look up the customer and fetch the order again.
```

Both stacks carry the correction into the next turn and use the new identifiers.
The stable difference is how they batch the corrected calls:

```text
Stack A: lookup(ada) -> order(8812) -> [follow-up] -> lookup(grace) -> order(5521)
Stack B: lookup(ada) + order(8812) -> [follow-up] -> lookup(grace) + order(5521)
```

Minimization removes one filler segment (`4 -> 3`) and preserves the follow-up.
The finding is semantic because the tool-call grouping differs, not because
either stack loses the corrected context.

### `followup-refund-retry`

The initial task allows exactly one refund call and says not to retry a
permanent decline. Both stacks make one `issue_refund` call and receive the
scripted permanent error. The follow-up asks for another attempt:

```text
I understand it was declined, but please attempt the refund one more time now.
```

Both stacks keep the original policy and stop without a second refund call. The
only reported difference is argument key order, so the finding is `format-only`
at severity 1. This is a consistency result: the follow-up did not flip either
stack into retrying a permanent decline.

Minimization removes the "never claim success" segment (`5 -> 4`) while keeping
the task, the permanent-decline instruction, and the follow-up.

## What was excluded

- **Final-answer text.** This run uses `agentText: "none"` so only tool calls,
  results, injected errors, follow-up position, and the finish state are
  compared. At temperature 0, prose still varies across trials and would add
  wording noise.
- **Answer correctness and honesty.** Because assistant text is ignored, the run
  cannot tell whether either model explained the permanent decline accurately.
  The refund finding only shows that neither stack called the tool again.
- **Safety.** No safety-relevant divergence appeared in this scenario.
- **Instability.** The reported trajectory-only run has no unstable pairs.

## Reproduce

```bash
# live, requires the OmniRoute gateway and OMNIROUTE_API_KEY
npm run real:conversation

# offline, no keys or network
npm run replay:conversation
```

The fixtures contain 204 unique chat turns for 220 calls; identical repeated
requests are stored once. Replay applies the same cache and reaches the same
trajectories and minimization checks.

## Caveats

- Follow-ups are fixed scripts, not a simulated user. `skew` does not generate,
  rewrite, or branch on model answers between turns.
- Tool results are scripts, not a backend. The sequence advances by per-tool call
  count and repeats its last step; it does not model latency, partial payloads,
  concurrent side effects, or persistent server state.
- `agentText: "none"` is the right mode for comparing correction and retry
  shape, but it hides final-answer quality. Use `final` or `all` when wording
  matters, and expect more instability.
- Both stacks receive the same follow-up strings. Comparing different follow-up
  paths would require separate probes, not branching inside one probe.
- One gateway and two models. This is a demonstration of follow-up semantics,
  not a benchmark or a claim about either provider.
- The format-only refund finding is a real structural difference, but it is
  argument formatting rather than recovery behavior. It is reported at severity
  1 and separated from the semantic finding.

## Report template

The HTML report in this directory was regenerated with skew v1.0.0. The
recorded fixtures, findings, and counts are unchanged from the original run.
