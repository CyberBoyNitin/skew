# skew

**Differential fuzzing for LLM stacks.** Find where two models, providers, or
quantizations behave differently on the same prompt — then minimize each
disagreement to its smallest reproducible form.

![skew report](docs/demo/report.png)

No runtime dependencies. TypeScript on Node 24.

## Quickstart

```bash
npm install
npm run demo
```

The demo is scripted and offline, so it is fully reproducible. It writes
`runs/<timestamp>/report.html` — open that file in a browser. A committed
sample lives at [`docs/demo/report.html`](docs/demo/report.html).

```bash
# compare real stacks
cp examples/skew.config.json skew.config.json
# edit the stacks, then:
node src/cli.ts run --config skew.config.json

# fail CI if the stacks disagree on safety
node src/cli.ts run --config skew.config.json --fail-on safety

# record a live run once, then replay it offline as often as needed
node src/cli.ts run --config skew.config.json --record fixtures/run-001
node src/cli.ts run --config skew.config.json --replay fixtures/run-001
```

## What the demo shows

Seed `7`, 8 probes, 3 trials, four scripted stacks. One run:

```text
found    18 divergences (4 safety, 5 semantic, 9 format-only) · 3 unstable pairs
calls    375   errors 0   minimization checks 151
```

| verdict | count | example |
| --- | --- | --- |
| `safety` | 4 | `delta` refuses a patient record; `alpha`/`beta` extract it |
| `semantic` | 5 | `alpha` turns `9007199254740993` into `9007199254740992` |
| `format-only` | 9 | same JSON value, compact vs fenced pretty-print |
| `unstable` | 3 pairs | `gamma` changes its answer between trials |

Each finding is reduced (from 8–10 segments to as few as 3–5) and re-verified
at the full trial count. The outputs in the report are sampled from that
minimized prompt, so every finding stands on its own.

## Live runs

Each is one small run against hosted models, not a benchmark. The recorded
fixtures replay offline without the gateway or model credentials.

### Native tool calls

[`docs/tools/`](docs/tools/) compares two models on seven tool-use prompts with
four native tools and `toolChoice: auto`:

```text
stacks   gpt-oss-120b, gemini-3.1-flash-lite
found    5 divergences (0 safety, 0 semantic, 5 format-only) · 0 unstable pairs
calls    106   errors 0   minimization checks 20
```

All five findings had identical tool names and argument values. The difference
was the order of keys inside `arguments`; canonical comparison classifies those
as format-only. They still matter to consumers that hash or byte-diff serialized
tool calls. This run found no stable semantic tool-argument disagreement, and
two probes produced no divergence at all. Findings were minimized where
possible and re-verified.

```bash
npm run replay:tools
```

See [`docs/tools/README.md`](docs/tools/README.md) for the tool definitions,
outputs, and caveats.

### Anthropic Messages

[`docs/anthropic/`](docs/anthropic/) compares an OpenAI chat-completions stack
with an Anthropic Messages stack:

```text
stacks   gpt-oss-120b-openai, claude-sonnet-anthropic
found    4 divergences (0 safety, 0 semantic, 4 format-only) · 0 unstable pairs
calls    80   errors 0   minimization checks 16
```

Both protocols returned the same values on all four probes, including an unsafe
integer, a float, unicode, and null. The differences were compact vs
pretty-printed JSON and one fenced JSON block. The adapter normalized both
protocols into the same text envelope before comparison.

```bash
npm run replay:anthropic
```

See [`docs/anthropic/README.md`](docs/anthropic/README.md) for the config,
outputs, and caveats.

### Extraction

[`docs/real/`](docs/real/) compares two hosted models on generated extraction
probes through an OpenAI-compatible gateway:

```text
stacks   gpt-oss-120b, gemini-3.1-flash-lite
found    2 divergences (0 safety, 0 semantic, 2 format-only) · 0 unstable pairs
calls    52   errors 0   minimization checks 8
```

Both models extracted the same values. The divergences were compact vs
pretty-printed JSON, which still breaks byte-matching consumers. Each finding
was minimized and verified. The run is recorded, so the full harness and
minimizer replay offline without the gateway or model access:

```bash
npm run replay:real
```

See [`docs/real/README.md`](docs/real/README.md) for the stack versions,
numbers, and caveats.

## Why

Evals compare a model to ground truth. `skew` compares stacks *to each other*,
so it works where no ground truth exists: migrations, quantization, provider
swaps, router fallbacks, version upgrades.

The hard part is not generating prompts. It is making the result trustworthy:

- **N trials per probe.** A stack that disagrees with itself is reported as
  unstable, never as a divergence.
- **Lossless structural comparison.** JSON is compared semantically, with
  unsafe integers preserved exactly from the source text. `0.30000000000000004`
  and `0.3` are not the same value, and neither are `9007199254740993` and
  `9007199254740992`.
- **Native tool calls.** OpenAI and Anthropic tool calls are normalized to the
  same `{name, arguments}` shape, so tool choice and arguments can be compared
  across protocols. Provider ids and envelopes are ignored.
- **Two wire protocols.** OpenAI chat-completions and Anthropic Messages stacks
  run through the same sampler, classifier, minimizer, and replay format.
- **Fingerprint-preserving minimization.** Delta debugging keeps reducing a
  prompt only while the *same* disagreement survives. A prompt that collapses
  into a different error is rejected, and the original is kept. Format-only
  findings also preserve the parsed JSON payload, so minimization cannot
  collapse a data-rich output into `{}`.
- **A failure taxonomy.** `format-only`, `semantic`, `safety`, `unstable` —
  each implies a different fix.
- **Runs that survive real providers.** Calls are retried with exponential
  backoff, bounded by a concurrency cap, and can be recorded once and replayed
  offline with the full minimizer intact.

## How it works

1. **Generate** — a seeded grammar emits extraction probes around edge cases:
   unsafe integers, float precision, null, unicode, empty strings, escaped
   characters, dates, booleans. Custom probe files can add native tool tasks.
2. **Sample** — every stack answers every probe N times at temperature 0, with
   retries and a concurrency cap. OpenAI chat-completions and Anthropic Messages
   stacks share the same harness. The modal output and its stability are computed
   per stack.
3. **Classify** — stacks that disagree with themselves are marked unstable.
   Stable disagreements are compared structurally and labeled.
4. **Minimize** — ddmin removes prompt segments while the disagreement
   fingerprint persists, capped by a check budget, then verifies the reduced
   prompt at the full trial count.

## Verdicts

| verdict | meaning | why it matters |
| --- | --- | --- |
| `safety` | one stack refuses or hedges while the other complies | policy drift between providers |
| `semantic` | both answer, but the values differ | silent data corruption |
| `format-only` | same parsed value, different serialization | breaks byte-matching consumers |
| `unstable` | a stack disagrees with itself across trials | the comparison is invalid; fix sampling first |

## Output

Each run writes three artifacts:

- `report.html` — self-contained report with minimized prompts and outputs
- `findings.jsonl` — one JSON object per finding, for CI and analysis
- `summary.json` — run metadata and counts

Exit codes: `0` by default, `1` when `--fail-on <class>` is triggered, `2` for
usage errors.

## Config

```json
{
  "seed": 7,
  "probes": 12,
  "probeFiles": ["probes.jsonl"],
  "trials": 3,
  "minStability": 0.8,
  "minimize": true,
  "maxChecks": 30,
  "concurrency": 4,
  "retries": 2,
  "retryDelayMs": 500,
  "retryMaxDelayMs": 8000,
  "stacks": [
    {
      "name": "hosted-mini",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5-mini",
      "apiKeyEnv": "OPENAI_API_KEY",
      "maxTokens": 512
    },
    {
      "name": "local-qwen",
      "baseUrl": "http://localhost:8000/v1",
      "model": "qwen3-8b"
    }
  ]
}
```

`apiKeyEnv` is read from the environment. Prefer it over inline `apiKey`.

`protocol` is `"openai"` (default) or `"anthropic"`. An Anthropic stack's
`baseUrl` should include the version, for example
`https://api.anthropic.com/v1`; `skew` appends `/messages`.

Define native tools once at the top level. Every stack receives the same
definitions, which keeps the comparison controlled:

```json
{
  "tools": [
    {
      "name": "lookup_customer",
      "description": "Look up a customer by email.",
      "parameters": {
        "type": "object",
        "properties": { "email": { "type": "string" } },
        "required": ["email"]
      }
    }
  ],
  "toolChoice": "auto"
}
```

`toolChoice` accepts `auto`, `none`, or `required`. `none` suppresses tool
definitions for both protocols. Calls are normalized to
`{tool_calls: [{name, arguments}]}` before comparison; refusals and prose stay
visible as text. See [`examples/tools.config.json`](examples/tools.config.json)
for a complete run.

Probe files are resolved relative to the config file. Retries apply to transport
errors plus HTTP 408, 409, 425, 429, and 5xx; other 4xx responses fail fast.
`maxTokens` caps generation per call (default 512). Lower it for slow local
models; without a cap, a chatty model can stall a run. Reasoning models may
spend the cap on hidden reasoning; raise it if the run reports
`finish_reason=length`.

## Custom probes

Generated probes cover extraction edge cases. Bring your own prompts inline or
as JSONL:

```json
{
  "probes": 0,
  "customProbes": [
    {
      "id": "tool-01",
      "segments": [
        "TASK: Issue a refund for order 8812.",
        "Customer: cus_1042. Amount: 49.99 USD.",
        "Use issue_refund. Reason: damaged in transit."
      ],
      "protected": [0],
      "tags": ["tool"]
    }
  ],
  "probeFiles": ["probes.jsonl"]
}
```

```json
{"id":"sql-01","prompt":"TASK: write the query as JSON.\n\nSCHEMA: {\"sql\": string}\n\nREQUEST: orders above 1000.","tags":["sql"]}
```

- `prompt` is split on newlines; `segments` gives explicit control.
- Minimization removes whole segments; `protected` indices are never removed.
  It defaults to `[0]`, so the instruction line survives by default.
- IDs must be unique across generated and custom probes.
- `probes: 0` disables the generator for custom-only suites.

## Record and replay

```bash
# once, against real stacks
node src/cli.ts run --config skew.config.json --record fixtures/run-001

# anywhere, including CI, with no keys and no network
node src/cli.ts run --config skew.config.json --replay fixtures/run-001
```

`--record` writes one JSONL file per stack plus a manifest. `--replay` feeds
those completions back through the same harness, so probes, classification,
minimization, and final verification all run deterministically. Recording keeps
successful completions only; a replay miss is a hard, non-retryable error.

## CLI

```text
skew demo [options]                 run the offline scripted demo
skew run --config <file> [options]  compare live OpenAI or Anthropic stacks

-o, --out <dir>        artifact directory (default: runs/<timestamp>)
    --seed <n>         generator seed (default: 7)
    --probes <n>       number of generated probes
    --trials <n>       samples per stack per probe (default: 3)
    --max-checks <n>   minimization budget per finding (default: 30)
    --concurrency <n>  max in-flight model calls (default: 4)
    --retries <n>      retries per failed call, with backoff (default: 2)
    --record <dir>     record completions for deterministic replay
    --replay <dir>     replay a recorded run instead of calling stacks
    --no-minimize      skip delta debugging
    --fail-on <class>  exit 1 on format-only | semantic | safety
```

## Design notes

- **Lossless JSON.** The `JSON.parse` reviver receives the source text for each
  primitive, which lets `skew` keep unsafe integers exact instead of losing
  precision in `Number`. This is what makes big-integer divergence detectable.
- **Stability before comparison.** The modal output must appear in at least
  `minStability` of trials. Otherwise the pair is `unstable`, not a finding.
- **Disagreement fingerprint.** A structural diff of the two outputs, reduced
  to the paths and values that actually differ. Minimization preserves it, so
  incidental fields can disappear from a repro without changing its meaning.
- **Verification is mandatory.** A reduced prompt is re-sampled at the full
  trial count. If it stops reproducing, the original prompt is reported and the
  finding is marked `unverified`.
- **Bounded concurrency and retries.** A semaphore caps in-flight calls across
  probes, trials, and stacks. Transport failures, 429s, and 5xx responses retry
  with exponential backoff and jitter; deterministic 4xx errors do not.
  `Retry-After` headers and provider reset timestamps override the backoff.
- **Protocol adapters.** One runner speaks OpenAI chat completions; another
  speaks Anthropic Messages. Both return the same text or tool-call envelope, so
  classification, minimization, and replay do not branch by provider.
- **Tool-call normalization.** OpenAI argument strings and Anthropic `input`
  objects are parsed into the same shape. Unsafe integers in arguments stay
  lossless; provider tool ids are discarded.
- **Output caps.** Every request sends `max_tokens` (default 512) so a chatty
  model cannot stall a run with unbounded generation.
- **Record/replay.** Each successful completion is keyed by stack, prompt, and
  trial. Replaying a fixture directory exercises the real harness and minimizer
  without making a network call, which is how the CLI-level replay test works.
- **Zero runtime dependencies.** Node 24 runs the TypeScript sources directly;
  `npm run build` emits plain ESM for distribution.

## Limitations

- Temperature 0 reduces stochasticity; it does not eliminate it. `trials` and
  `minStability` are the knobs.
- Minimization samples one trial per stack because the search is call-heavy.
  The final check always uses the full trial count.
- Prompt minimization removes whole segments (lines and blocks); it does not
  rewrite text. Custom probes are compared as-is, with no ground-truth answer.
- Recordings contain successful completions only. A replayed run must use the
  same probe set, seed, trial count, and minimization budget; otherwise a prompt
  can miss the fixture and fail loudly. Tool definitions live in the config, so
  replay with the same config.
- Anthropic Messages has no seed parameter. OpenAI stacks send the trial index
  as a seed; Anthropic stacks rely on repeated sampling for stability.
- Hosted free tiers rate-limit aggressively. The retry budget and
  `retryMaxDelayMs` should be large enough to wait out a reset; the extraction
  run uses one in-flight request and four retries.
- Only non-streaming OpenAI chat-completions and Anthropic Messages are
  supported. Tool-result loops, streaming deltas, and provider-native structured
  outputs are not covered yet.
- Tool definitions are global to a run: every stack sees the same tools and
  `toolChoice`. Comparing stacks with intentionally different tool schemas is not
  supported yet.
- The demo stacks are scripted. Demo findings demonstrate the classifier and
  minimizer; they are not claims about any real model.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## License

MIT
