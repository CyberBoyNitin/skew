# Real run: gpt-oss-120b vs Gemini 3.1 Flash Lite

A live differential run recorded on 2026-11-12 with `skew` 0.3.0. This is a
single small run, not a benchmark.

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
found    3 divergences (0 safety, 0 semantic, 3 format-only) · 0 unstable pairs
calls    64   errors 0   retries 0   minimization checks 12
duration 238.13s
```

| probe | verdict | segments | reproduced |
| --- | --- | --- | --- |
| `p000` | `format-only` | 9 → 4 | verified |
| `p001` | `format-only` | 9 → 4 | verified |
| `p003` | `format-only` | 8 → 6 | verified |

Every stable pair agreed on the extracted values. The divergence was
serialization: `gpt-oss-120b` emitted compact JSON, while Gemini emitted
pretty-printed JSON. That still breaks consumers that compare bytes or hash
serialized output.

`p002` produced no divergence.

## Replay

The fixtures capture every successful completion. Replay reruns the full
harness and minimizer offline, without the gateway or model credentials:

```bash
npm run replay:real
```

Recorded replay result: the same 3 findings, 64 calls, 12 checks, and 0 errors
in 0.02s.

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
- Generated probes are extraction prompts. Tool calls, long context, and
  streaming are not covered yet.
- Outputs are shown verbatim, including whitespace differences.
