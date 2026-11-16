import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DivergenceVerdict,
  Finding,
  Run,
  UnstableGroup,
} from "./types.ts";

const CSS = `
:root{
  --bg:#08090c;
  --panel:#101319;
  --panel-2:#0b0d11;
  --line:#1e232c;
  --line-soft:#171b22;
  --text:#e9ebf1;
  --muted:#929aa8;
  --dim:#5d6675;
  --gold:#e9b45a;
  --red:#ff6262;
  --amber:#f0b44c;
  --blue:#78a9ff;
  --green:#4fd1a1;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{
  margin:0;
  color:var(--text);
  font-family:var(--sans);
  font-size:14px;
  line-height:1.55;
  background:
    radial-gradient(1100px 480px at 18% -10%, rgba(233,180,90,.065), transparent 62%),
    var(--bg);
}
.wrap{max-width:1080px;margin:0 auto;padding:56px 28px 80px}
.hero{display:flex;justify-content:space-between;gap:28px;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:26px}
.brand{font-family:var(--mono);font-size:34px;font-weight:600;letter-spacing:.24em;color:var(--gold);line-height:1}
.tagline{margin-top:11px;color:var(--muted);font-size:13px;letter-spacing:.015em}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.badge{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.045em}
.badge.demo{border-color:rgba(233,180,90,.35);color:var(--gold)}
.runmeta{text-align:right;font-family:var(--mono);font-size:11px;color:var(--dim);line-height:1.85;white-space:nowrap}
.runmeta b{color:var(--muted);font-weight:500}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:28px 0 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat .n{font-family:var(--mono);font-size:26px;line-height:1.15}
.stat .k{margin-top:5px;font-size:9.5px;text-transform:uppercase;letter-spacing:.13em;color:var(--dim)}
.stat.safety .n{color:var(--red)}
.stat.semantic .n{color:var(--amber)}
.stat.format .n{color:var(--blue)}
.stat.unstable .n{color:var(--muted)}
.bar{display:flex;height:3px;border-radius:2px;overflow:hidden;background:var(--line-soft);margin-top:14px}
.bar i{display:block;height:100%}
.section{margin-top:46px}
.section h2{font-family:var(--mono);font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin:0 0 15px;font-weight:500}
.finding{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:12px}
.finding.v-safety{border-left-color:var(--red)}
.finding.v-semantic{border-left-color:var(--amber)}
.finding.v-format-only{border-left-color:var(--blue)}
.f-top{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.chip{font-family:var(--mono);font-size:9.5px;letter-spacing:.07em;padding:2px 8px;border-radius:4px;text-transform:uppercase;border:1px solid;line-height:1.6}
.chip.safety{color:var(--red);border-color:rgba(255,98,98,.36);background:rgba(255,98,98,.075)}
.chip.semantic{color:var(--amber);border-color:rgba(240,180,76,.36);background:rgba(240,180,76,.075)}
.chip.format-only{color:var(--blue);border-color:rgba(120,169,255,.36);background:rgba(120,169,255,.075)}
.fid{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.pair{font-family:var(--mono);font-size:11.5px;color:var(--text)}
.pair i{font-style:normal;color:var(--dim);padding:0 3px}
.fstat{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-left:auto}
.f-meta{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:9px;font-family:var(--mono);font-size:10.5px;color:var(--dim)}
.ok{color:var(--green)}
.warn{color:var(--amber)}
.tag{border:1px solid var(--line);border-radius:3px;padding:0 5px;font-size:10px;color:var(--muted)}
.f-block{margin-top:13px}
.f-followups{margin-top:9px}
.f-label{font-family:var(--mono);font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--dim);margin-bottom:6px;display:flex;justify-content:space-between;gap:12px}
pre{margin:0;background:var(--panel-2);border:1px solid var(--line-soft);border-radius:7px;padding:12px 14px;font-family:var(--mono);font-size:11.5px;line-height:1.65;color:#cfd5df;overflow:auto;max-height:250px;white-space:pre-wrap;word-break:break-word}
.trace{margin:0;background:var(--panel-2);border:1px solid var(--line-soft);border-radius:7px;padding:6px 12px;max-height:360px;overflow:auto}
.tr-turn{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft)}
.tr-turn:last-of-type{border-bottom:0}
.tr-num{font-family:var(--mono);font-size:9px;color:var(--dim);min-width:18px;padding-top:2px}
.tr-body{flex:1;min-width:0}
.tr-call{font-family:var(--mono);font-size:11px;line-height:1.65;color:var(--blue);word-break:break-word}
.tr-name{color:var(--green)}
.tr-args{color:var(--muted)}
.tr-result{font-family:var(--mono);font-size:10.5px;line-height:1.55;color:var(--dim);word-break:break-word;padding-left:2px}
.tr-result.error{color:var(--red)}
.tr-result.error .tr-res{color:var(--red)}
.tr-res-label{font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-left:3px}
.tr-res{color:var(--muted)}
.tr-text{font-family:var(--mono);font-size:11px;line-height:1.65;color:#cfd5df;white-space:pre-wrap;word-break:break-word}
.tr-user{font-family:var(--mono);font-size:11px;line-height:1.65;color:#e9c98f;border-left:2px solid var(--gold);padding-left:8px;margin-bottom:5px;white-space:pre-wrap;word-break:break-word}
.tr-user-label{font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);margin-right:4px}
.tr-finish{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);padding:7px 0 4px 28px}
.tr-empty{color:var(--dim);font-family:var(--mono);font-size:10px}
.trace + details pre{max-height:220px}
details{margin-top:10px}
summary{cursor:pointer;font-family:var(--mono);font-size:10.5px;color:var(--dim);letter-spacing:.04em;list-style:none}
summary::-webkit-details-marker{display:none}
summary:before{content:"+ ";color:var(--gold)}
details[open] summary:before{content:"- "}
.outputs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11.5px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line-soft)}
th{color:var(--dim);font-weight:500;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase}
td{color:var(--muted)}
td:first-child{color:var(--text)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;color:var(--muted)}
.warning{border-color:rgba(240,180,76,.3);color:var(--amber);font-family:var(--mono);font-size:11px}
.method{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.step{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 16px}
.step .num{font-family:var(--mono);font-size:10px;color:var(--gold);letter-spacing:.1em}
.step .name{margin-top:6px;font-family:var(--mono);font-size:12px;color:var(--text)}
.step p{margin:6px 0 0;color:var(--muted);font-size:11.5px;line-height:1.55}
.notes{color:var(--muted);font-size:12px;line-height:1.75}
.notes ul{margin:0;padding-left:18px}
.notes li{margin-bottom:5px}
footer{margin-top:56px;border-top:1px solid var(--line);padding-top:18px;display:flex;justify-content:space-between;gap:20px;font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:.03em}
@media (max-width:820px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .method{grid-template-columns:1fr 1fr}
  .outputs{grid-template-columns:1fr}
  .hero{flex-direction:column}
  .runmeta{text-align:left;white-space:normal}
  .fstat{margin-left:0;width:100%}
}
`;

export async function writeArtifacts(run: Run, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });

  const lines = run.findings.map((finding) => JSON.stringify(finding));
  await writeFile(
    join(outDir, "findings.jsonl"),
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    "utf8",
  );
  await writeFile(
    join(outDir, "summary.json"),
    `${JSON.stringify(buildSummary(run), null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(outDir, "report.html"), renderHtml(run), "utf8");

  return outDir;
}

export function printSummary(run: Run, outDir: string): void {
  const counts = countVerdicts(run.findings);
  const sorted = sortFindings(run.findings);
  const originNote =
    run.meta.origin === "demo"
      ? "demo (scripted stacks, no network)"
      : run.meta.origin === "replay"
        ? "replay (recorded fixtures, no network)"
        : "live";
  const retries =
    run.stats.retries > 0 ? `   retries   ${run.stats.retries}` : "";

  console.log("");
  console.log(`SKEW  ${run.meta.startedAt}  ${originNote}`);
  console.log(
    `stacks   ${run.meta.stacks.join(", ")}`,
  );
  const turns =
    run.meta.maxTurns > 1 ? `   turns   ${run.meta.maxTurns}` : "";
  const sequencedTools = run.meta.sequencedTools ?? 0;
  const injectedErrors = run.meta.injectedErrors ?? 0;
  const sequences =
    sequencedTools > 0
      ? `   sequences   ${sequencedTools}${injectedErrors > 0 ? ` (${injectedErrors} error steps)` : ""}`
      : "";
  const followUps = run.meta.followUps ?? 0;
  const conversations =
    followUps > 0 ? `   follow-ups   ${followUps}` : "";
  console.log(
    `probes   ${run.meta.probeCount}   trials   ${run.meta.trials}${turns}${sequences}${conversations}   calls   ${run.stats.calls}   errors   ${run.stats.errors}${retries}   checks   ${run.stats.minimizeChecks}`,
  );
  console.log(
    `found    ${counts.total} divergences (${counts.safety} safety, ${counts.semantic} semantic, ${counts["format-only"]} format-only) · ${run.unstable.length} unstable pairs`,
  );
  console.log("");

  if (sorted.length > 0) {
    console.log("sev  class        probe  stacks                segments");
    for (const finding of sorted.slice(0, 12)) {
      const pair = `${finding.stackA}/${finding.stackB}`;
      const segments = finding.minimized
        ? `${finding.originalSegments} -> ${finding.minimizedSegments}`
        : `${finding.originalSegments}`;
      console.log(
        `${String(finding.severity).padEnd(4)} ${finding.verdict.padEnd(12)} ${finding.probeId.padEnd(6)} ${pair.padEnd(21)} ${segments}`,
      );
    }
    if (sorted.length > 12) {
      console.log(`     ... ${sorted.length - 12} more in the report`);
    }
    console.log("");
  }

  if (run.unstable.length > 0) {
    const pairs = run.unstable
      .map((group) => `${group.stackA}/${group.stackB}`)
      .join(", ");
    console.log(`unstable pairs   ${pairs}`);
    console.log("");
  }

  if (run.stats.errors > 0) {
    console.log(`warning: ${run.stats.errors} stack call(s) failed`);
    for (const sample of run.errorSamples) console.log(`  ${sample}`);
    console.log("");
  }

  console.log(`report    ${join(outDir, "report.html")}`);
  console.log(`findings  ${join(outDir, "findings.jsonl")}`);
  console.log("");
}

export function renderHtml(run: Run): string {
  const counts = countVerdicts(run.findings);
  const findings = sortFindings(run.findings);
  const total = counts.total;
  const originBadge =
    run.meta.origin === "demo"
      ? '<span class="badge demo">scripted demo · no network</span>'
      : run.meta.origin === "replay"
        ? '<span class="badge demo">replay · recorded fixtures</span>'
        : '<span class="badge">live run</span>';
  const turnBadge =
    run.meta.maxTurns > 1
      ? `\n        <span class="badge demo">${run.meta.maxTurns}-turn agent loop</span>`
      : "";
  const sequencedTools = run.meta.sequencedTools ?? 0;
  const injectedErrors = run.meta.injectedErrors ?? 0;
  const sequenceBadge =
    sequencedTools > 0
      ? `\n        <span class="badge demo">${sequencedTools} sequenced tool${sequencedTools === 1 ? "" : "s"}${injectedErrors > 0 ? ` · ${injectedErrors} error step${injectedErrors === 1 ? "" : "s"}` : ""}</span>`
      : "";
  const followUpCount = run.meta.followUps ?? 0;
  const followUpBadge =
    followUpCount > 0
      ? `\n        <span class="badge demo">${followUpCount} follow-up turn${followUpCount === 1 ? "" : "s"}</span>`
      : "";
  const retryMeta =
    run.stats.retries > 0 ? ` · <b>retries</b> ${run.stats.retries}` : "";

  const distribution = (["safety", "semantic", "format-only"] as const)
    .map((verdict) => {
      const count = counts[verdict];
      const pct = total === 0 ? 0 : (count / total) * 100;
      return `<i style="width:${pct.toFixed(2)}%;background:var(--${colorFor(verdict)})"></i>`;
    })
    .join("");

  const findingsHtml =
    findings.length === 0
      ? '<div class="panel">No stable divergences found. Either the stacks agree, or the run did not complete enough calls to compare them.</div>'
      : findings.map(findingCard).join("\n");

  const unstableHtml =
    run.unstable.length === 0
      ? ""
      : `
  <section class="section">
    <h2>Unstable pairs</h2>
    <div class="panel" style="padding:6px 20px">
      <table>
        <thead><tr><th>stacks</th><th>probes</th><th>example</th><th>min stability</th></tr></thead>
        <tbody>${run.unstable.map(unstableRow).join("")}</tbody>
      </table>
    </div>
    <p class="notes" style="margin-top:10px">A stack that disagrees with itself cannot be compared to another stack. These pairs are excluded from the findings count and reported separately.</p>
  </section>`;

  const errorsHtml =
    run.errorSamples.length === 0
      ? ""
      : `
  <div class="panel warning" style="margin-top:18px">
    <strong>${run.stats.errors} stack call(s) failed.</strong><br>
    ${run.errorSamples.map((sample) => esc(sample)).join("<br>")}
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skew · divergence report</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div>
      <div class="brand">SKEW</div>
      <div class="tagline">behavioral divergence report for LLM stacks</div>
      <div class="badges">
        ${originBadge}
        <span class="badge">seed ${run.meta.seed}</span>
        <span class="badge">${run.meta.probeCount} probes</span>
        <span class="badge">${run.meta.trials} trials</span>${turnBadge}${sequenceBadge}${followUpBadge}
        <span class="badge">${run.meta.durationS.toFixed(2)}s</span>
      </div>
    </div>
    <div class="runmeta">
      <div><b>run</b> ${esc(run.meta.startedAt)}</div>
      <div><b>stacks</b> ${esc(run.meta.stacks.join(" · "))}</div>
      <div><b>calls</b> ${run.stats.calls} · <b>errors</b> ${run.stats.errors}${retryMeta} · <b>checks</b> ${run.stats.minimizeChecks}</div>
      <div><b>skew</b> v${esc(run.meta.version)}</div>
    </div>
  </header>

  <div class="stats">
    <div class="stat total"><div class="n">${counts.total}</div><div class="k">divergences</div></div>
    <div class="stat safety"><div class="n">${counts.safety}</div><div class="k">safety</div></div>
    <div class="stat semantic"><div class="n">${counts.semantic}</div><div class="k">semantic</div></div>
    <div class="stat format"><div class="n">${counts["format-only"]}</div><div class="k">format-only</div></div>
    <div class="stat unstable"><div class="n">${run.unstable.length}</div><div class="k">unstable pairs</div></div>
  </div>
  <div class="bar">${distribution}</div>
  ${errorsHtml}

  <section class="section">
    <h2>Findings · sorted by severity</h2>
    ${findingsHtml}
  </section>
  ${unstableHtml}

  <section class="section">
    <h2>Method</h2>
    <div class="method">
      <div class="step"><div class="num">01</div><div class="name">generate</div><p>A seeded grammar emits extraction probes around JSON edge cases, and custom probe files can add tool-use and safety cases.</p></div>
      <div class="step"><div class="num">02</div><div class="name">sample</div><p>Every stack answers every probe N times at temperature 0. Calls are retried with backoff and bounded by a concurrency limit. With a multi-turn config, tool calls are answered from static or sequenced results and the model continues until it stops or hits the turn budget. Sequence steps can return a result or inject an error to exercise retry paths.</p></div>
      <div class="step"><div class="num">03</div><div class="name">classify</div><p>Stacks that disagree with themselves are marked unstable. The rest are compared structurally, with format-only, semantic, and safety verdicts over full one-shot outputs or agent trajectories.</p></div>
      <div class="step"><div class="num">04</div><div class="name">minimize</div><p>Each divergence is delta-debugged over prompt segments and re-verified at the full trial count. Only reductions that reproduce the same disagreement are kept.</p></div>
    </div>
  </section>

  <section class="section">
    <h2>Limits</h2>
    <div class="notes">
      <ul>
        <li>Stability is estimated from ${run.meta.trials} trials. Temperature 0 reduces noise but does not remove it; stacks below the 0.8 threshold are reported as unstable, never as findings.</li>
        <li>Minimization uses one trial per stack because the search is call-heavy. Every reduced prompt is re-checked at the full trial count; if it no longer reproduces, the original prompt is kept and the finding is marked unverified.</li>
        <li>Prompts are minimized by removing whole segments (lines and blocks). The minimizer does not rewrite or paraphrase text. Scripted follow-up user turns are fixed during minimization.</li>
        <li>JSON is compared structurally, with unsafe integers preserved losslessly from the source text. Prose is compared after whitespace normalization.</li>
        <li>Native tool calls are normalized to <code>{name, arguments}</code>. Provider ids, envelopes, and serialization differences are ignored; tool choice and argument values are compared.</li>
        <li>In agent mode, tool calls are answered from static <code>toolResults</code> values or ordered <code>toolSequences</code>. skew never executes a tool or performs a real side effect. Each sequence step is a result or an injected error; after the last step, the last step repeats. The trace compares call order, arguments, returned results, injected errors, and where the loop stopped; assistant text is included according to <code>agentText</code>. The default <code>final</code> omits pre-tool narration because it is high-variance. Use <code>all</code> to compare every assistant message, or <code>none</code> to compare only calls, results, and where the loop stopped. Follow-up turns add the next scripted user message after a final answer and count against the same <code>maxTurns</code> budget.</li>
        <li>Stacks speak either OpenAI chat-completions or the Anthropic Messages API. Provider-specific sampling controls are not compared.</li>
      </ul>
    </div>
  </section>

  <footer>
    <span>skew v${esc(run.meta.version)} · ${run.findings.length} findings · ${run.stats.minimizeChecks} minimization checks</span>
    <span>machine-readable artifacts: findings.jsonl · summary.json</span>
  </footer>
</div>
</body>
</html>
`;
}

function findingCard(finding: Finding): string {
  const pairName = `${esc(finding.stackA)} <i>vs</i> ${esc(finding.stackB)}`;
  const tags = finding.tags
    .map((tag) => `<span class="tag">${esc(tag)}</span>`)
    .join("");
  const verified = finding.verified
    ? '<span class="ok">verified</span>'
    : '<span class="warn">unverified</span>';
  const minimizedLabel = finding.minimized
    ? `${finding.originalSegments} → ${finding.minimizedSegments} segments`
    : `${finding.originalSegments} segments · not reducible`;
  const cluster =
    finding.clusterSize > 1
      ? `<span>cluster ×${finding.clusterSize}</span>`
      : "";
  const traceA = renderAgentTrace(finding.outputA);
  const traceB = renderAgentTrace(finding.outputB);
  const followUpTurns = finding.followUps ?? [];
  const followUps =
    followUpTurns.length === 0
      ? ""
      : `<div class="f-block f-followups">
      <div class="f-label"><span>scripted follow-up turns</span><span>${followUpTurns.length}</span></div>
      <pre>${esc(followUpTurns.map((message, index) => `${index + 1}. ${message}`).join("\n"))}</pre>
    </div>`;

  const original =
    finding.minimized && finding.originalPrompt !== finding.minimizedPrompt
      ? `<details><summary>original prompt · ${finding.originalSegments} segments</summary><pre>${esc(finding.originalPrompt)}</pre></details>`
      : "";

  return `<article class="finding v-${finding.verdict}">
  <div class="f-top">
    <span class="chip ${finding.verdict}">${finding.verdict}</span>
    <span class="fid">${esc(finding.probeId)}</span>
    <span class="pair">${pairName}</span>
    <span class="fstat">stability ${finding.stabilityA.toFixed(2)} / ${finding.stabilityB.toFixed(2)}</span>
  </div>
  <div class="f-meta">
    <span>${esc(minimizedLabel)}</span>
    <span>${finding.checks} checks</span>
    ${verified}
    ${cluster}
    ${tags}
  </div>
  <div class="f-block">
    <div class="f-label"><span>minimized repro</span><span>${finding.minimizedPrompt.length} chars</span></div>
    <pre>${esc(finding.minimizedPrompt)}</pre>
    ${followUps}
    ${original}
  </div>
  <div class="outputs">
    <div>
      <div class="f-label"><span>${esc(finding.stackA)}</span><span>${traceA ? "agent trace" : "observed output"}</span></div>
      ${traceA ?? `<pre>${esc(finding.outputA)}</pre>`}
    </div>
    <div>
      <div class="f-label"><span>${esc(finding.stackB)}</span><span>${traceB ? "agent trace" : "observed output"}</span></div>
      ${traceB ?? `<pre>${esc(finding.outputB)}</pre>`}
    </div>
  </div>
</article>`;
}

function renderAgentTrace(output: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const turns = parsed.turns;
  const finish = parsed.finish;
  if (
    !Array.isArray(turns) ||
    (finish !== "final" && finish !== "max_turns")
  ) {
    return null;
  }

  const rows = turns
    .map((turn, index) => {
      if (!isRecord(turn)) return "";
      const assistant = isRecord(turn.assistant) ? turn.assistant : {};
      const calls = Array.isArray(assistant.tool_calls)
        ? assistant.tool_calls
        : [];
      const text =
        typeof assistant.text === "string" ? assistant.text : "";
      const user = typeof turn.user === "string" ? turn.user : "";
      const userHtml =
        user === ""
          ? ""
          : `<div class="tr-user"><span class="tr-user-label">follow-up</span>${esc(user)}</div>`;
      const callHtml = calls
        .map((call) => {
          if (!isRecord(call)) return "";
          const name = typeof call.name === "string" ? call.name : "?";
          const args =
            JSON.stringify(call.arguments ?? {}) ?? "{}";
          return `<div class="tr-call"><span class="tr-name">${esc(name)}</span><span class="tr-args">(${esc(args)})</span></div>`;
        })
        .join("");
      const results = Array.isArray(turn.results) ? turn.results : [];
      const resultHtml = results
        .map((result) => {
          if (!isRecord(result)) return "";
          const name =
            typeof result.name === "string" ? result.name : "?";
          const isError = result.is_error === true;
          const value =
            JSON.stringify(result.result ?? null) ?? "null";
          return `<div class="tr-result${isError ? " error" : ""}"><span class="tr-res-label">${isError ? "error" : "result"}</span> <span class="tr-name">${esc(name)}</span> <span class="tr-res">${esc(value)}</span></div>`;
        })
        .join("");
      const textHtml =
        text === "" ? "" : `<div class="tr-text">${esc(text)}</div>`;
      const body =
        userHtml + callHtml + resultHtml + textHtml === ""
          ? '<div class="tr-empty">(empty turn)</div>'
          : userHtml + callHtml + resultHtml + textHtml;
      return `<div class="tr-turn"><div class="tr-num">${String(index + 1).padStart(2, "0")}</div><div class="tr-body">${body}</div></div>`;
    })
    .join("");

  const finishLabel =
    finish === "final" ? "final answer" : "turn budget reached";
  return `<div class="trace">${rows}<div class="tr-finish">finish · ${finishLabel}</div></div><details><summary>raw trace · ${output.length} chars</summary><pre>${esc(output)}</pre></details>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unstableRow(group: UnstableGroup): string {
  return `<tr><td>${esc(group.stackA)} ↔ ${esc(group.stackB)}</td><td>${group.probes}</td><td>${esc(group.exampleProbe)}</td><td>${group.stabilityA.toFixed(2)} / ${group.stabilityB.toFixed(2)}</td></tr>`;
}

function colorFor(verdict: DivergenceVerdict): string {
  switch (verdict) {
    case "safety":
      return "red";
    case "semantic":
      return "amber";
    case "format-only":
      return "blue";
  }
}

function countVerdicts(findings: Finding[]): Record<DivergenceVerdict, number> & {
  total: number;
} {
  const counts = {
    total: findings.length,
    safety: 0,
    semantic: 0,
    "format-only": 0,
  };
  for (const finding of findings) {
    counts[finding.verdict] += 1;
  }
  return counts;
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      b.severity - a.severity ||
      a.probeId.localeCompare(b.probeId) ||
      a.stackA.localeCompare(b.stackA) ||
      a.stackB.localeCompare(b.stackB),
  );
}

function buildSummary(run: Run): unknown {
  const counts = countVerdicts(run.findings);
  return {
    meta: run.meta,
    stats: run.stats,
    counts,
    unstable: run.unstable,
    errorSamples: run.errorSamples,
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
