import type {
  AgentText,
  AgentToolCall,
  ChatMessage,
  ChatResponse,
} from "./types.ts";

export interface AgentOptions {
  maxTurns: number;
  toolResults: Record<string, unknown>;
  agentText: AgentText;
}

export interface AgentTraceTurn {
  assistant: {
    text?: string;
    tool_calls?: Array<{ name: string; arguments: unknown }>;
  };
  results?: Array<{ name: string; result: unknown }>;
}

export interface AgentTrace {
  turns: AgentTraceTurn[];
  finish: "final" | "max_turns";
}

interface ResolvedToolResult {
  name: string;
  result: unknown;
  content: string;
}

/**
 * Run one probe through a bounded tool-result loop. Tool execution is
 * deliberately not open-ended: every call is answered from static config
 * values, so the trajectory is deterministic and replayable. The comparison
 * sees assistant text, the sequence of tool calls, and the final turn shape;
 * provider ids and envelope differences stay out of the trace.
 */
export async function runAgent(
  prompt: string,
  options: AgentOptions,
  call: (messages: readonly ChatMessage[]) => Promise<ChatResponse>,
): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const turns: AgentTraceTurn[] = [];
  let finish: AgentTrace["finish"] = "max_turns";

  for (let turn = 0; turn < options.maxTurns; turn += 1) {
    const response = await call(messages);
    const assistant = assistantTrace(response, options.agentText);
    const resolved = response.toolCalls.map((toolCall) =>
      resolveToolResult(toolCall, options.toolResults),
    );

    const traceTurn: AgentTraceTurn = { assistant };
    if (resolved.length > 0) {
      traceTurn.results = resolved.map((item) => ({
        name: item.name,
        result: item.result,
      }));
    }
    turns.push(traceTurn);

    if (response.toolCalls.length === 0) {
      finish = "final";
      break;
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });
    for (const item of resolved) {
      messages.push({
        role: "tool",
        toolCallId: item.toolCallId,
        name: item.name,
        content: item.content,
      });
    }
  }

  const trace: AgentTrace = { turns, finish };
  return JSON.stringify(trace, null, 2);
}

function assistantTrace(
  response: ChatResponse,
  agentText: AgentText,
): AgentTraceTurn["assistant"] {
  const assistant: AgentTraceTurn["assistant"] = {};
  const includeText =
    agentText === "all" || response.toolCalls.length === 0;
  if (includeText && response.text !== null && response.text.trim() !== "") {
    assistant.text = response.text;
  }
  if (response.toolCalls.length > 0) {
    assistant.tool_calls = response.toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments,
    }));
  }
  return assistant;
}

interface ResolvedToolResultInternal extends ResolvedToolResult {
  toolCallId: string;
}

function resolveToolResult(
  call: AgentToolCall,
  configured: Record<string, unknown>,
): ResolvedToolResultInternal {
  const known = Object.prototype.hasOwnProperty.call(configured, call.name);
  const result = known
    ? configured[call.name]
    : { error: `unknown tool: ${call.name}` };
  return {
    toolCallId: call.id,
    name: call.name,
    result,
    content: stringifyResult(result),
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  const serialized = JSON.stringify(result);
  return serialized === undefined ? "null" : serialized;
}
