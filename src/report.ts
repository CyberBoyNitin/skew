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
  --paper:#f3f4f2;
  --ink:#17191c;
  --muted:#424851;
  --faint:#5d646d;
  --line:#cdd1cf;
  --line-strong:#9aa19e;
  --accent:#a83424;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:#111315;
    --ink:#e9ebed;
    --muted:#b5bbc1;
    --faint:#969da5;
    --line:#2c3034;
    --line-strong:#494f56;
    --accent:#e27057;
  }
}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:0 32px 64px}
.masthead{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:end;padding:34px 0 20px;border-bottom:2px solid var(--ink)}
.brand{font-family:var(--mono);font-size:30px;font-weight:700;letter-spacing:.26em;line-height:1}
.kicker{margin-top:9px;font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.run-meta{text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.9;white-space:nowrap}
.run-meta b{color:var(--ink);font-weight:600}
.scoreboard{display:grid;grid-template-columns:1.5fr repeat(4,1fr);border-bottom:1px solid var(--line-strong)}
.score{padding:18px 16px 20px;border-right:1px solid var(--line)}
.score:first-child{padding-left:0}
.score:last-child{border-right:0}
.score .n{font-family:var(--mono);font-size:33px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.04em}
.score .k{margin-top:9px;font-family:var(--mono);font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint)}
.score.safety .n{color:var(--accent)}
.main{display:grid;grid-template-columns:212px minmax(0,1fr);gap:44px;padding-top:34px;align-items:start}
.rail{position:sticky;top:24px}
.rail-label,.section-head{margin:0 0 12px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.rail dl{margin:0}
.rail dt{font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.rail dd{margin:2px 0 13px;padding-bottom:11px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11.5px;color:var(--ink);overflow-wrap:anywhere}
.rail .context{margin:0 0 20px;font-family:var(--mono);font-size:11px;line-height:1.8;color:var(--muted)}
.section{margin:0 0 44px}
.section-head{display:flex;justify-content:space-between;gap:16px;padding-bottom:9px;margin-bottom:0;border-bottom:1px solid var(--line-strong);color:var(--ink)}
.section-head span{color:var(--faint)}
.finding{padding:18px 0 22px 18px;border-left:3px var(--mark-style) var(--mark);border-bottom:1px solid var(--line)}
.v-safety{--mark:var(--accent);--mark-style:solid}
.v-semantic{--mark:var(--ink);--mark-style:double}
.v-format-only{--mark:var(--faint);--mark-style:dotted}
.f-top{display:grid;grid-template-columns:24px 88px minmax(0,1fr) auto;gap:12px;align-items:baseline}
.f-num,.verdict,.fid,.fstat,.f-meta,.f-label,.tags{font-family:var(--mono)}
.f-num{font-size:10px;color:var(--faint)}
.verdict{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink)}
.v-safety .verdict{color:var(--accent)}
.v-format-only .verdict{color:var(--muted)}
.fid{font-size:11.5px;color:var(--ink)}
.pair{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.pair i{font-style:normal;color:var(--faint);padding:0 4px}
.fstat{font-size:10px;color:var(--faint);white-space:nowrap}
.f-meta{margin-top:10px;display:flex;flex-wrap:wrap;gap:4px 16px;font-size:10px;color:var(--faint)}
.f-meta .ok{color:var(--accent)}
.f-meta .warn{color:var(--faint);font-weight:700}
.tags{margin-left:auto;color:var(--faint)}
.f-block{margin-top:16px}
.f-label{display:flex;justify-content:space-between;gap:12px;margin-bottom:7px;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
pre{margin:0;padding:8px 0 8px 14px;border-left:1px solid var(--line);font-family:var(--mono);font-size:11.5px;line-height:1.65;color:var(--ink);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:260px}
.outputs{display:grid;grid-template-columns:1fr 1fr;margin-top:16px;border-top:1px solid var(--line)}
.outputs>div{padding:14px 16px 0 0;min-width:0}
.outputs>div+div{padding-left:16px;border-left:1px solid var(--line)}
.trace{padding-left:14px;border-left:1px solid var(--line);max-height:360px;overflow:auto}
.tr-turn{display:grid;grid-template-columns:24px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
.tr-turn:last-of-type{border-bottom:0}
.tr-num{font-family:var(--mono);font-size:9px;color:var(--faint)}
.tr-body{min-width:0}
.tr-call{font-family:var(--mono);font-size:11px;line-height:1.65;color:var(--ink);overflow-wrap:anywhere}
.tr-name{color:var(--accent)}
.tr-args{color:var(--muted)}
.tr-result{font-family:var(--mono);font-size:10.5px;line-height:1.6;color:var(--muted);overflow-wrap:anywhere}
.tr-result.error{color:var(--accent)}
.tr-res-label{font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.tr-res{color:var(--muted)}
.tr-result.error .tr-res{color:var(--accent)}
.tr-text{font-family:var(--mono);font-size:11px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.tr-user{font-family:var(--mono);font-size:11px;line-height:1.65;color:var(--ink);border-left:2px solid var(--accent);padding-left:9px;margin-bottom:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.tr-user-label{font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-right:5px}
.tr-finish{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);padding:9px 0 2px 32px}
.tr-empty{font-family:var(--mono);font-size:10px;color:var(--faint)}
details{margin-top:10px}
summary{cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.03em}
summary:before{content:"+ ";color:var(--accent)}
details[open] summary:before{content:"- "}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}
th,td{text-align:left;padding:9px 12px 9px 0;border-bottom:1px solid var(--line)}
th{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
td{color:var(--muted)}
td:first-child{color:var(--ink)}
.notice,.empty{padding:12px 0;font-family:var(--mono);font-size:11px;border-bottom:1px solid var(--line)}
.notice{color:var(--accent)}
.empty{color:var(--muted)}
.method{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line)}
.step{padding:14px 16px 0 0;border-right:1px solid var(--line)}
.step:last-child{border-right:0;padding-right:0}
.step+.step{padding-left:16px}
.step .num{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--accent)}
.step .name{margin-top:7px;font-family:var(--mono);font-size:12px;color:var(--ink)}
.step p{margin:7px 0 0;font-size:11.5px;color:var(--muted);line-height:1.6}
.notes ol{display:grid;grid-template-columns:1fr 1fr;gap:8px 38px;margin:0;padding-left:20px}
.notes li{padding-left:4px;font-size:11.5px;line-height:1.65;color:var(--muted)}
.notes code{font-family:var(--mono);font-size:11px;color:var(--ink)}
footer{margin-top:52px;border-top:2px solid var(--ink);padding-top:16px;display:flex;justify-content:space-between;gap:20px;font-family:var(--mono);font-size:10px;color:var(--faint)}
@media (max-width:900px){
  .main{grid-template-columns:1fr;gap:28px}
  .rail{position:static;display:grid;grid-template-columns:1fr 1fr;gap:0 28px}
  .rail-label{grid-column:1/-1}
}
@media (max-width:640px){
  .wrap{padding:0 18px 48px}
  .masthead{grid-template-columns:1fr;gap:14px}
  .run-meta{text-align:left;white-space:normal}
  .scoreboard{grid-template-columns:1fr 1fr}
  .score{border-bottom:1px solid var(--line)}
  .score:nth-child(2n){border-right:0}
  .f-top{grid-template-columns:24px 1fr;gap:6px 10px}
  .verdict,.fstat{grid-column:2}
  .fstat{white-space:normal}
  .outputs,.notes ol,.rail{grid-template-columns:1fr}
  .outputs>div+div{padding-left:0;border-left:0;border-top:1px solid var(--line);margin-top:14px}
  .method{grid-template-columns:1fr 1fr}
  .tags{margin-left:0}
  footer{flex-direction:column;gap:6px}
}
@media print{
  .rail{position:static}
  pre,.trace{max-height:none}
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
  const routedTools = run.meta.routedTools ?? 0;
  const routeRules = run.meta.routeRules ?? 0;
  const routes =
    routedTools > 0
      ? `   routes   ${routedTools}${routeRules > 0 ? ` (${routeRules} rules)` : ""}`
      : "";
  const followUps = run.meta.followUps ?? 0;
  const conversations =
    followUps > 0 ? `   follow-ups   ${followUps}` : "";
  const overrides = run.meta.toolOverrides ?? 0;
  const probeOverrides =
    overrides > 0 ? `   overrides   ${overrides}` : "";
  console.log(
    `probes   ${run.meta.probeCount}   trials   ${run.meta.trials}${turns}${sequences}${routes}${conversations}${probeOverrides}   calls   ${run.stats.calls}   errors   ${run.stats.errors}${retries}   checks   ${run.stats.minimizeChecks}`,
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
  const version = esc(run.meta.version);
  const originLabel =
    run.meta.origin === "demo"
      ? "scripted demo · no network"
      : run.meta.origin === "replay"
        ? "replay · recorded fixtures"
        : "live run";

  const contextParts: string[] = [
    originLabel,
    `seed ${run.meta.seed}`,
    `${run.meta.probeCount} probes`,
    `${run.meta.trials} trials`,
  ];
  if (run.meta.maxTurns > 1) {
    contextParts.push(`${run.meta.maxTurns}-turn agent loop`);
  }
  const sequencedTools = run.meta.sequencedTools ?? 0;
  const injectedErrors = run.meta.injectedErrors ?? 0;
  if (sequencedTools > 0) {
    const steps =
      injectedErrors > 0
        ? ` · ${injectedErrors} error step${injectedErrors === 1 ? "" : "s"}`
        : "";
    contextParts.push(
      `${sequencedTools} sequenced tool${sequencedTools === 1 ? "" : "s"}${steps}`,
    );
  }
  const routedTools = run.meta.routedTools ?? 0;
  const routeRules = run.meta.routeRules ?? 0;
  if (routedTools > 0) {
    const rules =
      routeRules > 0
        ? ` · ${routeRules} route${routeRules === 1 ? "" : "s"}`
        : "";
    contextParts.push(`${routedTools} routed tools${rules}`);
  }
  const followUpCount = run.meta.followUps ?? 0;
  if (followUpCount > 0) {
    contextParts.push(
      `${followUpCount} follow-up turn${followUpCount === 1 ? "" : "s"}`,
    );
  }
  const overrideCount = run.meta.toolOverrides ?? 0;
  const overrideProbeCount = run.meta.toolOverrideProbes ?? 0;
  if (overrideCount > 0) {
    const probes =
      overrideProbeCount > 0
        ? ` · ${overrideProbeCount} probe${overrideProbeCount === 1 ? "" : "s"}`
        : "";
    contextParts.push(
      `${overrideCount} probe tool override${overrideCount === 1 ? "" : "s"}${probes}`,
    );
  }
  contextParts.push(`${run.meta.durationS.toFixed(2)}s`);
  const contextText = esc(contextParts.join(" · "));

  const retryMeta =
    run.stats.retries > 0 ? ` · <b>retries</b> ${run.stats.retries}` : "";

  const findingsHtml =
    findings.length === 0
      ? '<p class="empty">No stable divergences found. Either the stacks agree, or the run did not complete enough calls to compare them.</p>'
      : findings
          .map((finding, index) => findingCard(finding, index))
          .join("\n");

  const unstableHtml =
    run.unstable.length === 0
      ? ""
      : `
    <section class="section">
      <h2 class="section-head">Unstable pairs <span>${run.unstable.length} excluded</span></h2>
      <table>
        <thead><tr><th>stacks</th><th>probes</th><th>example</th><th>min stability</th></tr></thead>
        <tbody>${run.unstable.map(unstableRow).join("")}</tbody>
      </table>
      <p class="empty">A stack that disagrees with itself cannot be compared to another stack. These pairs are excluded from the findings count.</p>
    </section>`;

  const errorsHtml =
    run.errorSamples.length === 0
      ? ""
      : `<p class="notice"><strong>${run.stats.errors} stack call(s) failed.</strong><br>${run.errorSamples.map((sample) => esc(sample)).join("<br>")}</p>`;

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
  <header class="masthead">
    <div>
      <div class="brand">SKEW</div>
      <div class="kicker">divergence report · v${version}</div>
    </div>
    <div class="run-meta">
      <div><b>run</b> ${esc(run.meta.startedAt)}</div>
      <div><b>stacks</b> ${esc(run.meta.stacks.join(" · "))}</div>
      <div><b>calls</b> ${run.stats.calls} · <b>errors</b> ${run.stats.errors}${retryMeta} · <b>checks</b> ${run.stats.minimizeChecks}</div>
    </div>
  </header>

  <div class="scoreboard">
    <div class="score"><div class="n">${counts.total}</div><div class="k">divergences</div></div>
    <div class="score safety"><div class="n">${counts.safety}</div><div class="k">safety</div></div>
    <div class="score"><div class="n">${counts.semantic}</div><div class="k">semantic</div></div>
    <div class="score"><div class="n">${counts["format-only"]}</div><div class="k">format-only</div></div>
    <div class="score"><div class="n">${run.unstable.length}</div><div class="k">unstable pairs</div></div>
  </div>

  <div class="main">
    <aside class="rail">
      <h2 class="rail-label">Run</h2>
      <p class="context">${contextText}</p>
      <dl>
        <dt>stacks</dt><dd>${run.meta.stacks.map((stack) => esc(stack)).join("<br>")}</dd>
        <dt>started</dt><dd>${esc(run.meta.startedAt)}</dd>
        <dt>calls</dt><dd>${run.stats.calls}</dd>
        <dt>errors</dt><dd>${run.stats.errors}</dd>
        <dt>checks</dt><dd>${run.stats.minimizeChecks}</dd>
        <dt>skew</dt><dd>v${version}</dd>
      </dl>
    </aside>

    <main>
      ${errorsHtml}
      <section class="section">
        <h2 class="section-head">Findings <span>sorted by severity</span></h2>
        ${findingsHtml}
      </section>
      ${unstableHtml}

      <section class="section">
        <h2 class="section-head">Method</h2>
        <div class="method">
          <div class="step"><div class="num">01</div><div class="name">generate</div><p>A seeded grammar emits extraction probes around JSON edge cases, and custom probe files can add tool-use and safety cases.</p></div>
          <div class="step"><div class="num">02</div><div class="name">sample</div><p>Every stack answers every probe N times at temperature 0. Calls are retried with backoff and bounded by a concurrency limit. With a multi-turn config, tool calls are answered from static, argument-routed, or sequenced results and the model continues until it stops or hits the turn budget. Routes can branch on call arguments, and steps can return a result or inject an error to exercise retry paths.</p></div>
          <div class="step"><div class="num">03</div><div class="name">classify</div><p>Stacks that disagree with themselves are marked unstable. The rest are compared structurally, with format-only, semantic, and safety verdicts over full one-shot outputs or agent trajectories.</p></div>
          <div class="step"><div class="num">04</div><div class="name">minimize</div><p>Each divergence is delta-debugged over prompt segments and re-verified at the full trial count. Only reductions that reproduce the same disagreement are kept.</p></div>
        </div>
      </section>

      <section class="section">
        <h2 class="section-head">Limits <span>read before acting on a finding</span></h2>
        <div class="notes">
          <ol>
            <li>Stability is estimated from ${run.meta.trials} trials. Temperature 0 reduces noise but does not remove it; stacks below the 0.8 threshold are reported as unstable, never as findings.</li>
            <li>Minimization uses one trial per stack because the search is call-heavy. Every reduced prompt is re-checked at the full trial count; if it no longer reproduces, the original prompt is kept and the finding is marked unverified.</li>
            <li>Prompts are minimized by removing whole segments (lines and blocks). The minimizer does not rewrite or paraphrase text. Scripted follow-up user turns are fixed during minimization.</li>
            <li>JSON is compared structurally, with unsafe integers preserved losslessly from the source text. Prose is compared after whitespace normalization.</li>
            <li>Native tool calls are normalized to <code>{name, arguments}</code>. Provider ids, envelopes, and serialization differences are ignored; tool choice and argument values are compared.</li>
            <li>In agent mode, tool calls are answered from static <code>toolResults</code> values or ordered <code>toolSequences</code>. skew never executes a tool or performs a real side effect. Each sequence step is a result or an injected error; after the last step, the last step repeats. The trace compares call order, arguments, returned results, injected errors, and where the loop stopped; assistant text is included according to <code>agentText</code>. The default <code>final</code> omits pre-tool narration because it is high-variance. Use <code>all</code> to compare every assistant message, or <code>none</code> to compare only calls, results, and where the loop stopped. Follow-up turns add the next scripted user message after a final answer and count against the same <code>maxTurns</code> budget.</li>
            <li>Probes can override global <code>toolResults</code>, <code>toolSequences</code>, and <code>toolRoutes</code> tool by tool. An override replaces the global entry for that tool, so one suite can exercise different retry, failure, and recovery paths without shared sequence state. A probe cannot define more than one of a static result, a sequence, and a route list for the same tool.</li>
            <li>Argument-aware routes match a subset of tool-call arguments recursively; extra argument keys are allowed. The first matching route wins, and a route without <code>when</code> is a fallback and must be last. A call with no matching route receives an injected <code>no_matching_tool_route</code> error. Sequences inside routes advance per route, not per tool, so two entities can have independent state.</li>
            <li>Stacks speak either OpenAI chat-completions or the Anthropic Messages API. Provider-specific sampling controls are not compared.</li>
          </ol>
        </div>
      </section>
    </main>
  </div>

  <footer>
    <span>skew v${version} · ${run.findings.length} findings · ${run.stats.minimizeChecks} minimization checks</span>
    <span>findings.jsonl · summary.json</span>
  </footer>
</div>
</body>
</html>
`;
}

function findingCard(finding: Finding, index: number): string {
  const pairName = `${esc(finding.stackA)} <i>vs</i> ${esc(finding.stackB)}`;
  const tags =
    finding.tags.length === 0
      ? ""
      : `<span class="tags">${finding.tags.map((tag) => esc(tag)).join(" · ")}</span>`;
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
    <span class="f-num">${String(index + 1).padStart(2, "0")}</span>
    <span class="verdict">${finding.verdict}</span>
    <span><span class="fid">${esc(finding.probeId)}</span> <span class="pair">${pairName}</span></span>
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
