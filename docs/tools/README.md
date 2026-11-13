# Live run: native tool calls

A live differential run recorded on 2026-11-13 with `skew` 0.4.0. This is a
single small run, not a benchmark.

## Setup

| | |
| --- | --- |
| Stack A | `agy/gpt-oss-120b-medium`, OpenAI chat-completions |
| Stack B | `agy/gemini-3.1-flash-lite`, OpenAI chat-completions |
| Gateway | OmniRoute 3.8.50 at `http://127.0.0.1:20128/v1` |
| Provider | Antigravity connections configured in the local gateway |
| Probes | 7 custom tool probes |
| Tools | `lookup_customer`, `issue_refund`, `send_email`, `issue_credit` |
| Tool choice | `auto` |
| Trials | 3 per stack, temperature 0 |
| Generation cap | 512 tokens |
| Minimization | ddmin, 4 checks per finding, full-trial verification |

The live config is [`examples/tools.config.json`](../../examples/tools.config.json)
and the probes are [`examples/tools.probes.json`](../../examples/tools.probes.json).
They require the local gateway and `OMNIROUTE_API_KEY`; replay does not.

## Result

```text
found    5 divergences (0 safety, 0 semantic, 5 format-only) · 0 unstable pairs
calls    106   errors 0   retries 0   minimization checks 20
duration 437.90s
```

| probe | verdict | segments | reproduced |
| --- | --- | --- | --- |
| `tool-reason` | `format-only` | 6 | verified |
| `tool-refund` | `format-only` | 6 → 4 | verified |
| `tool-required` | `format-only` | 6 → 4 | verified |
| `tool-precision` | `format-only` | 7 → 5 | verified |
| `tool-credit` | `format-only` | 6 → 5 | verified |

All five findings had identical tool names and argument values. The difference
was the order of keys inside `arguments`:

```text
A  {"reason":"damaged in transit","amount":49.99,"customer_id":"cus_1042"}
B  {"amount":49.99,"customer_id":"cus_1042","reason":"damaged in transit"}
```

Canonical comparison treats these as the same value, so they are classified as
format-only. They still matter to consumers that hash or byte-diff serialized
tool calls. This run found no stable semantic tool-argument disagreement;
`tool-lookup` and `tool-multi` produced no divergence at all. Findings were
minimized where possible and re-verified at three trials per stack.

## Replay

The fixtures capture every successful completion. Replay reruns the full
harness and minimizer offline, without the gateway or model credentials:

```bash
npm run replay:tools
```

Recorded replay result: the same 5 findings, 106 calls, 20 checks, and 0
errors in 0.03s.

## Files

- [`report.html`](report.html) — self-contained report
- [`report.png`](report.png) — screenshot of the report
- [`summary.json`](summary.json) — run metadata and counts
- [`findings.jsonl`](findings.jsonl) — machine-readable findings
- [`fixtures/`](fixtures/) — per-stack recorded completions

## Caveats

- One run, seven probes, two models. Do not generalize these numbers.
- The gateway and provider accounts are part of this stack. A different route
  can change output even for the same model name.
- Tool calls are single-turn. The harness does not execute tools or feed results
  back to the model.
- Outputs are shown verbatim, including JSON key order and whitespace.
