# Live run: OpenAI chat-completions vs Anthropic Messages

A live differential run recorded on 2026-11-13 with `skew` 0.4.0. This is a
single small run, not a benchmark.

## Setup

| | |
| --- | --- |
| Stack A | `agy/gpt-oss-120b-medium`, OpenAI chat-completions |
| Stack B | `agy/claude-sonnet-4-6`, Anthropic Messages |
| Gateway | OmniRoute 3.8.50 at `http://127.0.0.1:20128/v1` |
| Provider | Antigravity connections configured in the local gateway |
| Probes | 4 generated extraction probes, seed 23 |
| Trials | 3 per stack, temperature 0 |
| Generation cap | 512 tokens |
| Minimization | ddmin, 4 checks per finding, full-trial verification |

Stack B sends `/v1/messages` requests with an `x-api-key` header and the
`anthropic-version: 2023-06-01` header. Its responses are normalized to the same
text envelope as the OpenAI stack, so the comparator does not branch by
protocol.

The live config is
[`examples/omniroute-anthropic.config.json`](../../examples/omniroute-anthropic.config.json).
It requires the local gateway and `OMNIROUTE_API_KEY`; replay does not. The
direct-Anthropic template is [`examples/anthropic.config.json`](../../examples/anthropic.config.json).

## Result

```text
found    4 divergences (0 safety, 0 semantic, 4 format-only) · 0 unstable pairs
calls    80   errors 0   retries 0   minimization checks 16
duration 240.00s
```

| probe | verdict | segments | reproduced |
| --- | --- | --- | --- |
| `p000` | `format-only` | 8 → 7 | verified |
| `p001` | `format-only` | 8 → 7 | verified |
| `p002` | `format-only` | 8 → 7 | verified |
| `p003` | `format-only` | 9 → 5 | verified |

Both protocols extracted the same values on all four probes, including the
unsafe integer `9007199254740993`, the float `0.30000000000000004`, and the
unicode string in `p000`. The differences were serialization: compact vs
pretty-printed JSON, and one fenced JSON block from Claude. Canonical comparison
classifies all four as format-only.

That is the adapter working as intended: the same values arrived through two
different wire formats, and `skew` compared them without protocol-specific
special cases. Each finding was minimized and re-verified at three trials per
stack.

## Replay

The fixtures capture every successful completion. Replay reruns the full
harness and minimizer offline, without the gateway or model credentials:

```bash
npm run replay:anthropic
```

Recorded replay result: the same 4 findings, 80 calls, 16 checks, and 0 errors
in 0.05s.

## Files

- [`report.html`](report.html) — self-contained report
- [`report.png`](report.png) — screenshot of the report
- [`summary.json`](summary.json) — run metadata and counts
- [`findings.jsonl`](findings.jsonl) — machine-readable findings
- [`fixtures/`](fixtures/) — per-stack recorded completions

## Caveats

- One run, four probes, two models. Do not generalize these numbers.
- The gateway and provider accounts are part of this stack. A different route
  can change output even for the same model name.
- Anthropic Messages has no seed parameter. OpenAI requests send the trial index
  as a seed; the Anthropic stack relies on repeated sampling for stability.
- Outputs are shown verbatim, including whitespace differences.
