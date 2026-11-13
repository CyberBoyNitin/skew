# Real run: gpt-oss-120b vs Gemini 3.1 Flash Lite

A live differential extraction run recorded on 2026-11-13 with `skew` 0.4.0.
This is a single small run, not a benchmark. Other runs cover native tool calls
([`docs/tools/`](../tools/)) and the Anthropic Messages protocol
([`docs/anthropic/`](../anthropic/)).

## Setup

| | |
| --- | --- |
| Stack A | `agy/gpt-oss-120b-medium` |
| Stack B | `agy/gemini-3.1-flash-lite` |
| Gateway | OmniRoute 3.8.50, OpenAI-compatible at `http://127.0.0.1:20128/v1` |
| Provider | Antigravity connections configured in the local gateway |
| Probes | 4 generated extraction probes, seed 11 |
| Trials | 3 per stack, temperature 0 |
| Generation cap | 512 tokens |
| Minimization | ddmin, 4 checks per finding, full-trial verification |

The live config is [`examples/omniroute.config.json`](../../examples/omniroute.config.json).
It requires the local gateway and `OMNIROUTE_API_KEY`; replay does not.

## Result

```text
found    2 divergences (0 safety, 0 semantic, 2 format-only) · 0 unstable pairs
calls    52   errors 0   retries 0   minimization checks 8
duration 187.48s
```

| probe | verdict | segments | reproduced |
| --- | --- | --- | --- |
| `p001` | `format-only` | 9 → 6 | verified |
| `p003` | `format-only` | 8 → 7 | verified |

Every stable pair agreed on the extracted values, including the unsafe integer
`9007199254740993` and the float `0.30000000000000004`. The divergence was
serialization: `gpt-oss-120b` emitted compact JSON, while Gemini emitted
pretty-printed JSON. That still breaks consumers that compare bytes or hash
serialized output.

`p000` and `p002` produced no divergence.

## Replay

The fixtures capture every successful completion. Replay reruns the full
harness and minimizer offline, without the gateway or model credentials:

```bash
npm run replay:real
```

Recorded replay result: the same 2 findings, 52 calls, 8 checks, and 0 errors
in 0.01s.

## Files

- [`report.html`](report.html) — self-contained report
- [`report.png`](report.png) — screenshot of the report
- [`summary.json`](summary.json) — run metadata and counts
- [`findings.jsonl`](findings.jsonl) — machine-readable findings
- [`fixtures/`](fixtures/) — per-stack recorded completions

## Caveats

- One run, four probes, two models. Do not generalize these numbers.
- The gateway and provider accounts are part of this stack. A different
  route can change output even for the same model name.
- Generated probes are extraction prompts. This run does not cover tool calls,
  long context, or streaming.
- Outputs are shown verbatim, including whitespace differences.
