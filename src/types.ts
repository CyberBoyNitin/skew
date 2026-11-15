import type { NormalizedToolCall } from "./tools.ts";

export type Verdict = "format-only" | "semantic" | "safety" | "unstable";

export type DivergenceVerdict = Exclude<Verdict, "unstable">;

export type Protocol = "openai" | "anthropic";

export type ToolChoice = "auto" | "none" | "required";

export type AgentText = "none" | "final" | "all";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One scripted response for a tool. Result steps are normal tool output;
 * error steps are returned to the model as an error result. The distinction
 * lets a config exercise retry and recovery paths without executing anything.
 */
export type ToolSequenceStep =
  | { result: unknown }
  | { error: unknown };

/**
 * A tool call with the provider-issued id retained for multi-turn history.
 * The id is never compared; it only lets the next request reference the call.
 */
export interface AgentToolCall extends NormalizedToolCall {
  id: string;
  rawArguments?: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls: AgentToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

export interface ChatResponse {
  text: string | null;
  toolCalls: AgentToolCall[];
}

export interface PairAnalysis {
  verdict: Verdict | null;
  stabilityA: number;
  stabilityB: number;
  modalA: string;
  modalB: string;
}

export interface Runner {
  readonly name: string;
  complete(prompt: string, trial?: number): Promise<string>;
}

export interface AgentRunner extends Runner {
  completeChat(
    messages: readonly ChatMessage[],
    trial?: number,
  ): Promise<ChatResponse>;
}

export function isAgentRunner(runner: Runner): runner is AgentRunner {
  return typeof (runner as Partial<AgentRunner>).completeChat === "function";
}

export interface RunStats {
  calls: number;
  errors: number;
  retries: number;
  minimizeChecks: number;
}

export interface Finding {
  probeId: string;
  tags: string[];
  stackA: string;
  stackB: string;
  verdict: DivergenceVerdict;
  severity: number;
  stabilityA: number;
  stabilityB: number;
  outputA: string;
  outputB: string;
  originalPrompt: string;
  minimizedPrompt: string;
  originalSegments: number;
  minimizedSegments: number;
  minimized: boolean;
  verified: boolean;
  checks: number;
  signature: string;
  clusterSize: number;
}

export interface UnstableGroup {
  stackA: string;
  stackB: string;
  probes: number;
  exampleProbe: string;
  stabilityA: number;
  stabilityB: number;
}

export interface RunMeta {
  startedAt: string;
  durationS: number;
  seed: number;
  probeCount: number;
  trials: number;
  maxTurns: number;
  sequencedTools?: number;
  injectedErrors?: number;
  stacks: string[];
  version: string;
  origin: string;
}

export interface Run {
  meta: RunMeta;
  findings: Finding[];
  unstable: UnstableGroup[];
  stats: RunStats;
  errorSamples: string[];
}

export interface HttpRunnerOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}
