import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import type { AgentTrace } from "../src/agent.ts";
import { Harness } from "../src/harness.ts";
import { probeFromSpec } from "../src/probes.ts";
import { renderHtml } from "../src/report.ts";
import {
  loadReplayRunners,
  RecordingRunner,
  saveRecordings,
} from "../src/replay.ts";
import type { ChatMessage, ChatResponse } from "../src/types.ts";
import type { AgentRunner } from "../src/types.ts";

const TOOL_RESULTS = {
  lookup_customer: { id: "cus_1042", status: "active" },
};

function toolCallResponse(id = "call_1"): ChatResponse {
  return {
    text: null,
    toolCalls: [
      {
        id,
        name: "lookup_customer",
        arguments: { email: "ada@example.com" },
      },
    ],
  };
}

class ScriptedAgent implements AgentRunner {
  readonly name: string;
  private readonly finalText: string;
  seen: ChatMessage[][] = [];

  constructor(name: string, finalText: string) {
    this.name = name;
    this.finalText = finalText;
  }

  async complete(): Promise<string> {
    return this.finalText;
  }

  async completeChat(
    messages: readonly ChatMessage[],
  ): Promise<ChatResponse> {
    this.seen.push(structuredClone(messages) as ChatMessage[]);
    if (messages.length === 1) {
      return toolCallResponse(`call_${this.name}`);
    }
    return { text: this.finalText, toolCalls: [] };
  }
}

test("runAgent feeds static tool results back and stops on a final answer", async () => {
  const requests: ChatMessage[][] = [];
  const trace = await runAgent(
    "Look up the customer.",
    { maxTurns: 3, toolResults: TOOL_RESULTS, agentText: "final" },
    async (messages) => {
      requests.push(structuredClone(messages) as ChatMessage[]);
      return messages.length === 1
        ? toolCallResponse("call_1")
        : { text: "The customer is active.", toolCalls: [] };
    },
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.equal(parsed.finish, "final");
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(parsed.turns[0]!.results, [
    { name: "lookup_customer", result: TOOL_RESULTS.lookup_customer },
  ]);
  assert.equal(parsed.turns[1]!.assistant.text, "The customer is active.");

  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.length, 3);
  assert.deepEqual(requests[1]![1], {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call_1",
        name: "lookup_customer",
        arguments: { email: "ada@example.com" },
      },
    ],
  });
  assert.deepEqual(requests[1]![2], {
    role: "tool",
    toolCallId: "call_1",
    name: "lookup_customer",
    content: JSON.stringify(TOOL_RESULTS.lookup_customer),
  });
});

test("agentText final omits pre-tool narration unless requested", async () => {
  const run = async (
    agentText: "none" | "final" | "all",
  ): Promise<AgentTrace> => {
    let calls = 0;
    const trace = await runAgent(
      "Look it up.",
      { maxTurns: 2, toolResults: TOOL_RESULTS, agentText },
      async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: "I will look that up now.",
            toolCalls: [
              {
                id: "call_1",
                name: "lookup_customer",
                arguments: { email: "ada@example.com" },
              },
            ],
          };
        }
        return { text: "Done.", toolCalls: [] };
      },
    );
    return JSON.parse(trace) as AgentTrace;
  };

  const finalOnly = await run("final");
  assert.equal(finalOnly.turns[0]!.assistant.text, undefined);
  assert.equal(finalOnly.turns[1]!.assistant.text, "Done.");

  const all = await run("all");
  assert.equal(all.turns[0]!.assistant.text, "I will look that up now.");

  const none = await run("none");
  assert.equal(none.turns[0]!.assistant.text, undefined);
  assert.equal(none.turns[1]!.assistant.text, undefined);
});

test("runAgent stops at the turn budget and marks the trace", async () => {
  let calls = 0;
  const trace = await runAgent(
    "Keep calling.",
    { maxTurns: 2, toolResults: { ping: { ok: true } }, agentText: "final" },
    async () => {
      calls += 1;
      return { text: null, toolCalls: [
        { id: `call_${calls}`, name: "ping", arguments: {} },
      ] };
    },
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.equal(calls, 2);
  assert.equal(parsed.finish, "max_turns");
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(parsed.turns[1]!.results, [
    { name: "ping", result: { ok: true } },
  ]);
});

test("runAgent consumes tool sequences by call order and repeats the last step", async () => {
  const requests: ChatMessage[][] = [];
  let calls = 0;
  const trace = await runAgent(
    "Fetch the order.",
    {
      maxTurns: 4,
      toolResults: {},
      toolSequences: {
        get_order: [
          { error: { code: "timeout" } },
          { result: { status: "delivered" } },
        ],
      },
      agentText: "final",
    },
    async (messages) => {
      requests.push(structuredClone(messages) as ChatMessage[]);
      calls += 1;
      if (calls <= 3) {
        return {
          text: null,
          toolCalls: [
            {
              id: `call_${calls}`,
              name: "get_order",
              arguments: { order_id: "8812" },
            },
          ],
        };
      }
      return { text: "Delivered.", toolCalls: [] };
    },
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.equal(parsed.finish, "final");
  assert.deepEqual(parsed.turns[0]!.results, [
    { name: "get_order", result: { code: "timeout" }, is_error: true },
  ]);
  assert.deepEqual(parsed.turns[1]!.results, [
    { name: "get_order", result: { status: "delivered" } },
  ]);
  assert.deepEqual(parsed.turns[2]!.results, [
    { name: "get_order", result: { status: "delivered" } },
  ]);

  assert.deepEqual(requests[1]!.at(-1), {
    role: "tool",
    toolCallId: "call_1",
    name: "get_order",
    content: '{"code":"timeout"}',
    isError: true,
  });
  assert.deepEqual(requests[2]!.at(-1), {
    role: "tool",
    toolCallId: "call_2",
    name: "get_order",
    content: '{"status":"delivered"}',
  });
});

test("sequenced tool state stays independent across stack trajectories", async () => {
  class PollingAgent implements AgentRunner {
    readonly name: string;
    private readonly polls: number;
    private readonly finalText: string;

    constructor(name: string, polls: number, finalText: string) {
      this.name = name;
      this.polls = polls;
      this.finalText = finalText;
    }

    async complete(): Promise<string> {
      return this.finalText;
    }

    async completeChat(
      messages: readonly ChatMessage[],
    ): Promise<ChatResponse> {
      const toolTurns = messages.filter(
        (message) => message.role === "assistant",
      ).length;
      if (toolTurns < this.polls) {
        return {
          text: null,
          toolCalls: [
            {
              id: `call_${toolTurns + 1}`,
              name: "poll",
              arguments: {},
            },
          ],
        };
      }
      return { text: this.finalText, toolCalls: [] };
    }
  }

  const run = await new Harness({
    probes: [
      probeFromSpec({ id: "poll-state", prompt: "Poll until approved." }),
    ],
    stacks: [
      new PollingAgent("a", 1, "Stopped after one poll."),
      new PollingAgent("b", 2, "Approved after two polls."),
    ],
    trials: 1,
    minimize: false,
    maxTurns: 3,
    toolResults: {},
    toolSequences: {
      poll: [
        { error: { code: "timeout" } },
        { result: { status: "approved" } },
      ],
    },
    retries: 0,
    concurrency: 4,
    origin: "test",
  }).run();

  assert.equal(run.meta.sequencedTools, 1);
  assert.equal(run.meta.injectedErrors, 1);
  assert.equal(run.findings.length, 1);

  const traceA = JSON.parse(run.findings[0]!.outputA) as AgentTrace;
  const traceB = JSON.parse(run.findings[0]!.outputB) as AgentTrace;
  assert.deepEqual(traceA.turns[0]!.results, [
    { name: "poll", result: { code: "timeout" }, is_error: true },
  ]);
  assert.deepEqual(traceB.turns[0]!.results, [
    { name: "poll", result: { code: "timeout" }, is_error: true },
  ]);
  assert.deepEqual(traceB.turns[1]!.results, [
    { name: "poll", result: { status: "approved" } },
  ]);
});

test("agent traces compare across stacks and count every model call", async () => {
  const stackA = new ScriptedAgent("a", "Refund approved.");
  const stackB = new ScriptedAgent("b", "Cannot approve this refund.");
  const run = await new Harness({
    probes: [
      probeFromSpec({
        id: "agent-1",
        prompt: "Look up the customer and decide on the refund.",
      }),
    ],
    stacks: [stackA, stackB],
    trials: 3,
    minimize: false,
    maxTurns: 2,
    toolResults: {},
    toolSequences: {
      lookup_customer: [
        { error: { code: "timeout" } },
        { result: TOOL_RESULTS.lookup_customer },
      ],
    },
    retries: 0,
    concurrency: 4,
    origin: "test",
  }).run();

  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0]!.verdict, "semantic");
  assert.equal(run.stats.calls, 12);
  assert.equal(run.meta.maxTurns, 2);

  const traceA = JSON.parse(run.findings[0]!.outputA) as AgentTrace;
  const traceB = JSON.parse(run.findings[0]!.outputB) as AgentTrace;
  assert.equal(traceA.finish, "final");
  assert.equal(traceA.turns.length, 2);
  assert.deepEqual(traceA.turns[0]!.results, [
    { name: "lookup_customer", result: { code: "timeout" }, is_error: true },
  ]);
  assert.equal(traceB.turns[0]!.assistant.tool_calls?.[0]?.name, "lookup_customer");
  assert.equal(traceB.turns[1]!.assistant.text, "Cannot approve this refund.");

  const html = renderHtml(run);
  assert.match(html, /agent trace/);
  assert.match(html, /lookup_customer/);
  assert.match(html, /class="tr-result error"/);
  assert.match(html, /1 sequenced tool/);
  assert.match(html, /1 error step/);
  assert.match(html, /finish · final answer/);
  assert.match(html, /raw trace/);
});

test("an agent run records and replays chat turns exactly", async () => {
  const probe = probeFromSpec({
    id: "agent-replay",
    prompt: "Look up the customer and decide on the refund.",
  });
  const recorders = [
    new RecordingRunner(new ScriptedAgent("a", "Refund approved.")),
    new RecordingRunner(new ScriptedAgent("b", "Cannot approve this refund.")),
  ];
  const options = {
    probes: [probe],
    trials: 2,
    minimize: false,
    maxTurns: 2,
    toolResults: TOOL_RESULTS,
    retries: 0,
    concurrency: 4,
    origin: "test",
  };
  const first = await new Harness({ ...options, stacks: recorders }).run();

  const dir = await mkdtemp(join(tmpdir(), "skew-agent-replay-"));
  await saveRecordings(dir, recorders, "0.5.0");
  const replayers = await loadReplayRunners(
    dir,
    recorders.map((runner) => runner.name),
  );
  const second = await new Harness({ ...options, stacks: replayers }).run();

  assert.deepEqual(
    second.findings.map((finding) => ({
      probeId: finding.probeId,
      outputA: finding.outputA,
      outputB: finding.outputB,
      verdict: finding.verdict,
    })),
    first.findings.map((finding) => ({
      probeId: finding.probeId,
      outputA: finding.outputA,
      outputB: finding.outputB,
      verdict: finding.verdict,
    })),
  );
  assert.equal(second.stats.calls, first.stats.calls);
  assert.equal(second.stats.errors, 0);
});

test("an agent run records and replays injected tool errors exactly", async () => {
  const probe = probeFromSpec({
    id: "agent-error-replay",
    prompt: "Fetch the order and report the result.",
  });
  const recorders = [
    new RecordingRunner(new ScriptedAgent("a", "A recovered.")),
    new RecordingRunner(new ScriptedAgent("b", "B recovered.")),
  ];
  const options = {
    probes: [probe],
    trials: 2,
    minimize: false,
    maxTurns: 2,
    toolResults: {},
    toolSequences: {
      lookup_customer: [
        { error: { code: "timeout" } },
        { result: TOOL_RESULTS.lookup_customer },
      ],
    },
    retries: 0,
    concurrency: 4,
    origin: "test",
  };
  const first = await new Harness({ ...options, stacks: recorders }).run();

  const dir = await mkdtemp(join(tmpdir(), "skew-agent-error-replay-"));
  await saveRecordings(dir, recorders, "0.6.0");
  const replayers = await loadReplayRunners(
    dir,
    recorders.map((runner) => runner.name),
  );
  const second = await new Harness({ ...options, stacks: replayers }).run();

  assert.match(first.findings[0]!.outputA, /"is_error": true/);
  assert.deepEqual(
    second.findings.map((finding) => ({
      probeId: finding.probeId,
      outputA: finding.outputA,
      outputB: finding.outputB,
      verdict: finding.verdict,
    })),
    first.findings.map((finding) => ({
      probeId: finding.probeId,
      outputA: finding.outputA,
      outputB: finding.outputB,
      verdict: finding.verdict,
    })),
  );
  assert.equal(second.stats.calls, first.stats.calls);
  assert.equal(second.stats.errors, 0);
});
