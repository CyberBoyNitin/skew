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

/**
 * One tool call on the initial turn. A follow-up agent re-checks after the
 * scripted user message; the other answers from the conversation context.
 */
class FollowUpAgent implements AgentRunner {
  readonly name: string;
  private readonly rechecks: boolean;

  constructor(name: string, rechecks: boolean) {
    this.name = name;
    this.rechecks = rechecks;
  }

  async complete(): Promise<string> {
    return this.name;
  }

  async completeChat(
    messages: readonly ChatMessage[],
  ): Promise<ChatResponse> {
    const assistantTurns = messages.filter(
      (message) => message.role === "assistant",
    ).length;
    if (assistantTurns === 0) {
      return toolCallResponse(`call_${this.name}_1`);
    }
    if (assistantTurns === 1) {
      return { text: `${this.name} answered once.`, toolCalls: [] };
    }
    if (this.rechecks && assistantTurns === 2) {
      return toolCallResponse(`call_${this.name}_2`);
    }
    return { text: `${this.name} finished.`, toolCalls: [] };
  }
}

/** Uses the replay namespace in provider ids, like a live provider would. */
class ContextAgent implements AgentRunner {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async complete(): Promise<string> {
    return this.name;
  }

  async completeChat(
    messages: readonly ChatMessage[],
    _trial = 0,
    context = "",
  ): Promise<ChatResponse> {
    const assistantTurns = messages.filter(
      (message) => message.role === "assistant",
    ).length;
    if (assistantTurns === 0) {
      return {
        text: null,
        toolCalls: [
          {
            id: `call_${this.name}_${context}_1`,
            name: "ping",
            arguments: {},
          },
        ],
      };
    }
    return { text: `${this.name} ${context} done.`, toolCalls: [] };
  }
}

/** Calls two tools in one turn, then echoes the returned results. */
class MultiToolAgent implements AgentRunner {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async complete(): Promise<string> {
    return this.name;
  }

  async completeChat(
    messages: readonly ChatMessage[],
  ): Promise<ChatResponse> {
    const assistantTurns = messages.filter(
      (message) => message.role === "assistant",
    ).length;
    if (assistantTurns === 0) {
      return {
        text: null,
        toolCalls: [
          {
            id: `call_${this.name}_ping`,
            name: "ping",
            arguments: {},
          },
          {
            id: `call_${this.name}_pong`,
            name: "pong",
            arguments: {},
          },
        ],
      };
    }
    const results = messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content)
      .join(", ");
    return { text: `${this.name}: ${results}`, toolCalls: [] };
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

test("runAgent appends follow-up user turns and keeps tool state", async () => {
  const requests: ChatMessage[][] = [];
  let calls = 0;
  const trace = await runAgent(
    "Look up Ada.",
    {
      maxTurns: 5,
      toolResults: {},
      toolSequences: {
        lookup_customer: [
          { result: { email: "ada@example.com", status: "active" } },
          { result: { email: "grace@example.com", status: "trial" } },
        ],
      },
      followUps: ["Now look up Grace.", "Summarize both."],
      agentText: "final",
    },
    async (messages) => {
      requests.push(structuredClone(messages) as ChatMessage[]);
      calls += 1;
      if (calls === 1 || calls === 3) {
        return {
          text: null,
          toolCalls: [
            {
              id: `call_${calls}`,
              name: "lookup_customer",
              arguments: {
                email: calls === 1 ? "ada@example.com" : "grace@example.com",
              },
            },
          ],
        };
      }
      const text =
        calls === 2
          ? "Ada is active."
          : calls === 4
            ? "Grace is active."
            : "Both are active.";
      return { text, toolCalls: [] };
    },
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.equal(parsed.finish, "final");
  assert.equal(parsed.turns.length, 5);
  assert.equal(parsed.turns[0]!.user, undefined);
  assert.equal(parsed.turns[1]!.user, undefined);
  assert.equal(parsed.turns[2]!.user, "Now look up Grace.");
  assert.equal(parsed.turns[3]!.user, undefined);
  assert.equal(parsed.turns[4]!.user, "Summarize both.");
  assert.deepEqual(parsed.turns[2]!.results, [
    {
      name: "lookup_customer",
      result: { email: "grace@example.com", status: "trial" },
    },
  ]);
  assert.equal(parsed.turns[3]!.assistant.text, "Grace is active.");
  assert.equal(parsed.turns[4]!.assistant.text, "Both are active.");

  assert.equal(requests.length, 5);
  assert.equal(requests[2]!.length, 5);
  assert.deepEqual(requests[2]![3], {
    role: "assistant",
    content: "Ada is active.",
    toolCalls: [],
  });
  assert.deepEqual(requests[2]![4], {
    role: "user",
    content: "Now look up Grace.",
  });
  assert.equal(requests[3]!.length, 7);
  assert.deepEqual(requests[3]!.at(-1), {
    role: "tool",
    toolCallId: "call_3",
    name: "lookup_customer",
    content: '{"email":"grace@example.com","status":"trial"}',
  });
  assert.equal(requests[4]!.length, 9);
  assert.deepEqual(requests[4]!.at(-1), {
    role: "user",
    content: "Summarize both.",
  });
});

test("follow-up turns count against the overall turn budget", async () => {
  const requests: ChatMessage[][] = [];
  const trace = await runAgent(
    "Start.",
    {
      maxTurns: 2,
      toolResults: { ping: { ok: true } },
      followUps: ["Second.", "Third."],
      agentText: "final",
    },
    async (messages) => {
      requests.push(structuredClone(messages) as ChatMessage[]);
      return { text: "Done.", toolCalls: [] };
    },
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.at(-1), {
    role: "user",
    content: "Second.",
  });
  assert.equal(parsed.finish, "max_turns");
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.turns[0]!.user, undefined);
  assert.equal(parsed.turns[1]!.user, "Second.");
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

test("follow-up turns surface in findings, run metadata, and reports", async () => {
  const run = await new Harness({
    probes: [
      probeFromSpec({
        id: "followup-harness",
        segments: ["Filler context.", "Look up Ada."],
        protected: [1],
        followUps: ["Now look up Grace."],
      }),
    ],
    stacks: [
      new FollowUpAgent("a", true),
      new FollowUpAgent("b", false),
    ],
    trials: 3,
    minimize: true,
    maxChecks: 6,
    maxTurns: 5,
    toolResults: TOOL_RESULTS,
    agentText: "none",
    retries: 0,
    concurrency: 4,
    origin: "test",
  }).run();

  assert.equal(run.findings.length, 1);
  assert.equal(run.meta.followUpProbes, 1);
  assert.equal(run.meta.followUps, 1);

  const finding = run.findings[0]!;
  assert.equal(finding.verdict, "semantic");
  assert.deepEqual(finding.followUps, ["Now look up Grace."]);
  assert.equal(finding.minimized, true);
  assert.equal(finding.minimizedSegments, 1);
  assert.equal(finding.minimizedPrompt, "Look up Ada.");

  const html = renderHtml(run);
  assert.match(html, /1 follow-up turn/);
  assert.match(html, /scripted follow-up turns/);
  assert.match(html, /Now look up Grace\./);
  assert.match(html, /class="tr-user"/);
  assert.match(html, /follow-up/);
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

test("a follow-up conversation records and replays every chat turn", async () => {
  const probe = probeFromSpec({
    id: "followup-replay",
    prompt: "Look up Ada.",
    followUps: ["Now look up Grace."],
  });
  const recorders = [
    new RecordingRunner(new FollowUpAgent("a", true)),
    new RecordingRunner(new FollowUpAgent("b", false)),
  ];
  const options = {
    probes: [probe],
    trials: 2,
    minimize: false,
    maxTurns: 4,
    toolResults: TOOL_RESULTS,
    agentText: "none" as const,
    retries: 0,
    concurrency: 4,
    origin: "test",
  };
  const first = await new Harness({ ...options, stacks: recorders }).run();

  const dir = await mkdtemp(join(tmpdir(), "skew-followup-replay-"));
  await saveRecordings(dir, recorders, "0.7.0");
  const replayers = await loadReplayRunners(
    dir,
    recorders.map((runner) => runner.name),
  );
  const second = await new Harness({ ...options, stacks: replayers }).run();

  assert.equal(first.findings.length, 1);
  assert.deepEqual(first.findings[0]!.followUps, ["Now look up Grace."]);
  assert.deepEqual(
    second.findings.map((finding) => ({
      probeId: finding.probeId,
      followUps: finding.followUps,
      outputA: finding.outputA,
      outputB: finding.outputB,
      verdict: finding.verdict,
    })),
    first.findings.map((finding) => ({
      probeId: finding.probeId,
      followUps: finding.followUps,
      outputA: finding.outputA,
      outputB: finding.outputB,
      verdict: finding.verdict,
    })),
  );
  assert.equal(second.stats.calls, first.stats.calls);
  assert.equal(second.stats.errors, 0);
});

test("probe tool overrides isolate scenarios and merge global defaults", async () => {
  const probes = [
    probeFromSpec({
      id: "env-static",
      prompt: "Call both services.",
      toolResults: { ping: { v: "a-ping" } },
    }),
    probeFromSpec({
      id: "env-sequence",
      prompt: "Call both services.",
      toolSequences: { ping: [{ result: { v: "b-ping" } }] },
    }),
  ];
  const run = await new Harness({
    probes,
    stacks: [new MultiToolAgent("a"), new MultiToolAgent("b")],
    trials: 3,
    minimize: false,
    maxTurns: 2,
    toolResults: {
      ping: { v: "global-ping" },
      pong: { v: "global-pong" },
    },
    toolNames: ["ping", "pong"],
    agentText: "final",
    retries: 0,
    concurrency: 4,
    origin: "test",
  }).run();

  assert.equal(run.findings.length, 2);
  assert.equal(run.meta.toolOverrideProbes, 2);
  assert.equal(run.meta.toolOverrides, 2);

  const staticFinding = run.findings.find(
    (finding) => finding.probeId === "env-static",
  )!;
  assert.match(staticFinding.outputA, /a-ping/);
  assert.match(staticFinding.outputA, /global-pong/);
  assert.doesNotMatch(staticFinding.outputA, /global-ping/);
  assert.match(staticFinding.outputB, /a-ping/);

  const sequenceFinding = run.findings.find(
    (finding) => finding.probeId === "env-sequence",
  )!;
  assert.match(sequenceFinding.outputA, /b-ping/);
  assert.match(sequenceFinding.outputA, /global-pong/);
  assert.doesNotMatch(sequenceFinding.outputA, /global-ping/);

  const html = renderHtml(run);
  assert.match(html, /2 probe tool overrides/);
});

test("probe tool overrides are validated against configured tools", () => {
  assert.throws(
    () =>
      new Harness({
        probes: [
          probeFromSpec({
            id: "typo",
            prompt: "Check it.",
            toolResults: { pign: { ok: true } },
          }),
        ],
        stacks: [new MultiToolAgent("a"), new MultiToolAgent("b")],
        maxTurns: 2,
        toolResults: { ping: { ok: true } },
        toolNames: ["ping"],
      }),
    /overrides unknown tool "pign"/,
  );
});

test("probe tool overrides record and replay exactly", async () => {
  const probes = [
    probeFromSpec({
      id: "env-replay-static",
      prompt: "Call both services.",
      toolResults: { ping: { v: "a-ping" } },
    }),
    probeFromSpec({
      id: "env-replay-sequence",
      prompt: "Call both services.",
      toolSequences: { ping: [{ result: { v: "b-ping" } }] },
    }),
  ];
  const recorders = [
    new RecordingRunner(new MultiToolAgent("a")),
    new RecordingRunner(new MultiToolAgent("b")),
  ];
  const options = {
    probes,
    trials: 2,
    minimize: false,
    maxTurns: 2,
    toolResults: {
      ping: { v: "global-ping" },
      pong: { v: "global-pong" },
    },
    toolNames: ["ping", "pong"],
    agentText: "final" as const,
    retries: 0,
    concurrency: 4,
    origin: "test",
  };
  const first = await new Harness({ ...options, stacks: recorders }).run();

  const dir = await mkdtemp(join(tmpdir(), "skew-env-replay-"));
  await saveRecordings(dir, recorders, "0.8.0");
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

test("runAgent resolves argument-aware routes and reports route misses", async () => {
  const scripts: ChatResponse[] = [
    {
      text: null,
      toolCalls: [
        {
          id: "call_5521",
          name: "get_order",
          arguments: { order_id: "5521" },
        },
      ],
    },
    {
      text: null,
      toolCalls: [
        {
          id: "call_8812",
          name: "get_order",
          arguments: { order_id: "8812" },
        },
      ],
    },
    {
      text: null,
      toolCalls: [
        {
          id: "call_9999",
          name: "get_order",
          arguments: { order_id: "9999" },
        },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  let turn = 0;

  const trace = await runAgent(
    "Fetch the orders.",
    {
      maxTurns: 4,
      toolResults: {},
      toolRoutes: {
        get_order: [
          {
            when: { order_id: "8812" },
            result: { order_id: "8812", status: "delivered" },
          },
          {
            when: { order_id: "5521" },
            result: { order_id: "5521", status: "processing" },
          },
        ],
      },
      agentText: "none",
    },
    async () => scripts[turn++]!,
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.equal(parsed.finish, "final");
  assert.deepEqual(parsed.turns[0]!.results, [
    {
      name: "get_order",
      result: { order_id: "5521", status: "processing" },
    },
  ]);
  assert.deepEqual(parsed.turns[1]!.results, [
    {
      name: "get_order",
      result: { order_id: "8812", status: "delivered" },
    },
  ]);
  assert.deepEqual(parsed.turns[2]!.results, [
    {
      name: "get_order",
      result: {
        code: "no_matching_tool_route",
        message: "no toolRoutes entry matched get_order",
      },
      is_error: true,
    },
  ]);
});

test("route sequences advance per route, not per tool", async () => {
  const scripts: ChatResponse[] = [
    {
      text: null,
      toolCalls: [
        {
          id: "call_9001",
          name: "check_refund_status",
          arguments: { refund_id: "re_9001" },
        },
      ],
    },
    {
      text: null,
      toolCalls: [
        {
          id: "call_7781_first",
          name: "check_refund_status",
          arguments: { refund_id: "re_7781" },
        },
      ],
    },
    {
      text: null,
      toolCalls: [
        {
          id: "call_7781_second",
          name: "check_refund_status",
          arguments: { refund_id: "re_7781" },
        },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  let turn = 0;

  const trace = await runAgent(
    "Check the refunds.",
    {
      maxTurns: 4,
      toolResults: {},
      toolRoutes: {
        check_refund_status: [
          {
            when: { refund_id: "re_9001" },
            result: { refund_id: "re_9001", status: "approved" },
          },
          {
            when: { refund_id: "re_7781" },
            sequence: [
              { result: { refund_id: "re_7781", status: "pending" } },
              { result: { refund_id: "re_7781", status: "approved" } },
            ],
          },
        ],
      },
      agentText: "none",
    },
    async () => scripts[turn++]!,
  );

  const parsed = JSON.parse(trace) as AgentTrace;
  assert.deepEqual(
    parsed.turns.slice(0, 3).map((item) => item.results?.[0]?.result),
    [
      { refund_id: "re_9001", status: "approved" },
      { refund_id: "re_7781", status: "pending" },
      { refund_id: "re_7781", status: "approved" },
    ],
  );
});

test("probe tool routes isolate scenarios and merge global routes", async () => {
  const probes = [
    probeFromSpec({
      id: "route-override",
      prompt: "Call both services.",
      toolRoutes: { ping: [{ result: { v: "a-ping" } }] },
    }),
    probeFromSpec({
      id: "route-inherit",
      prompt: "Call both services.",
    }),
  ];
  const run = await new Harness({
    probes,
    stacks: [new MultiToolAgent("a"), new MultiToolAgent("b")],
    trials: 3,
    minimize: false,
    maxTurns: 2,
    toolResults: {},
    toolRoutes: {
      ping: [{ result: { v: "global-ping" } }],
      pong: [{ result: { v: "global-pong" } }],
    },
    toolNames: ["ping", "pong"],
    agentText: "final",
    retries: 0,
    concurrency: 4,
    origin: "test",
  }).run();

  assert.equal(run.findings.length, 2);
  assert.equal(run.meta.routedTools, 2);
  assert.equal(run.meta.routeRules, 3);
  assert.equal(run.meta.toolOverrideProbes, 1);
  assert.equal(run.meta.toolOverrides, 1);

  const overridden = run.findings.find(
    (finding) => finding.probeId === "route-override",
  )!;
  assert.match(overridden.outputA, /a-ping/);
  assert.match(overridden.outputA, /global-pong/);
  assert.doesNotMatch(overridden.outputA, /global-ping/);

  const inherited = run.findings.find(
    (finding) => finding.probeId === "route-inherit",
  )!;
  assert.match(inherited.outputA, /global-ping/);
  assert.match(inherited.outputA, /global-pong/);

  const html = renderHtml(run);
  assert.match(html, /2 routed tools · 3 routes/);
});

test("probe tool routes record and replay exactly", async () => {
  const probes = [
    probeFromSpec({
      id: "route-replay-override",
      prompt: "Call both services.",
      toolRoutes: { ping: [{ result: { v: "a-ping" } }] },
    }),
    probeFromSpec({
      id: "route-replay-inherit",
      prompt: "Call both services.",
    }),
  ];
  const recorders = [
    new RecordingRunner(new MultiToolAgent("a")),
    new RecordingRunner(new MultiToolAgent("b")),
  ];
  const options = {
    probes,
    trials: 2,
    minimize: false,
    maxTurns: 2,
    toolResults: {},
    toolRoutes: {
      ping: [{ result: { v: "global-ping" } }],
      pong: [{ result: { v: "global-pong" } }],
    },
    toolNames: ["ping", "pong"],
    agentText: "final" as const,
    retries: 0,
    concurrency: 4,
    origin: "test",
  };
  const first = await new Harness({ ...options, stacks: recorders }).run();

  const dir = await mkdtemp(join(tmpdir(), "skew-route-replay-"));
  await saveRecordings(dir, recorders, "0.9.0");
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

test("replay namespaces identical prompts by probe", async () => {
  const probes = [
    probeFromSpec({
      id: "context-a",
      prompt: "Check the same thing.",
      followUps: ["Follow-up A."],
    }),
    probeFromSpec({
      id: "context-b",
      prompt: "Check the same thing.",
      followUps: ["Follow-up B."],
    }),
  ];
  const recorders = [
    new RecordingRunner(new ContextAgent("a")),
    new RecordingRunner(new ContextAgent("b")),
  ];
  const options = {
    probes,
    trials: 2,
    minimize: false,
    maxTurns: 3,
    toolResults: { ping: { ok: true } },
    agentText: "none" as const,
    retries: 0,
    concurrency: 4,
    origin: "test",
  };
  const first = await new Harness({ ...options, stacks: recorders }).run();

  const dir = await mkdtemp(join(tmpdir(), "skew-context-replay-"));
  await saveRecordings(dir, recorders, "0.7.0");
  const replayers = await loadReplayRunners(
    dir,
    recorders.map((runner) => runner.name),
  );
  const second = await new Harness({ ...options, stacks: replayers }).run();

  assert.equal(first.findings.length, 0);
  assert.equal(second.findings.length, 0);
  assert.equal(second.stats.errors, 0);
  assert.equal(second.stats.calls, first.stats.calls);
});
