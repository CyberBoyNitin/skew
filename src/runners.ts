import { formatToolOutput, parseToolArguments } from "./tools.ts";
import type {
  AgentRunner,
  AgentToolCall,
  ChatMessage,
  ChatResponse,
  HttpRunnerOptions,
  Runner,
  ToolChoice,
  ToolDefinition,
} from "./types.ts";

export class RunnerError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "RunnerError";
    this.retryable = options.retryable ?? true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class HttpRunner implements AgentRunner {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly tools: ToolDefinition[];
  private readonly toolChoice: ToolChoice | undefined;

  constructor(options: HttpRunnerOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxTokens = options.maxTokens ?? 512;
    this.tools = options.tools ?? [];
    this.toolChoice = options.toolChoice;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const response = await this.completeChat(
      [{ role: "user", content: prompt }],
      trial,
    );
    return formatResponse(response, this.name);
  }

  async completeChat(
    messages: readonly ChatMessage[],
    trial = 0,
  ): Promise<ChatResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: toOpenAiMessages(messages),
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        seed: trial,
      };
      if (this.tools.length > 0 && this.toolChoice !== "none") {
        body.tools = this.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        if (this.toolChoice === "auto" || this.toolChoice === "required") {
          body.tool_choice = this.toolChoice;
        }
      }

      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RunnerError(
        `${this.name}: request failed: ${(error as Error).message}`,
        { retryable: true },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
        text,
      );
      throw new RunnerError(
        `${this.name}: HTTP ${response.status}: ${text.slice(0, 400)}`,
        {
          retryable: isRetryableStatus(response.status),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RunnerError(
        `${this.name}: response was not JSON: ${text.slice(0, 300)}`,
        { retryable: true },
      );
    }

    const extracted = extractOpenAiResponse(body);
    if (extracted === null) {
      throw new RunnerError(
        `${this.name}: response did not contain a completion: ${text.slice(0, 300)}`,
        { retryable: false },
      );
    }

    if (extracted.text === null && extracted.toolCalls.length === 0) {
      const hint =
        extracted.finishReason === "length"
          ? ` (finish_reason=length; raise maxTokens above ${this.maxTokens})`
          : "";
      throw new RunnerError(
        `${this.name}: no completion content${hint}: ${text.slice(0, 300)}`,
        { retryable: false },
      );
    }

    return { text: extracted.text, toolCalls: extracted.toolCalls };
  }
}

/**
 * Anthropic Messages API runner. The request and response shapes differ from
 * OpenAI chat completions, but the output is normalized to the same text or
 * tool-call envelope so both protocols can be compared directly.
 */
export class AnthropicRunner implements AgentRunner {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly tools: ToolDefinition[];
  private readonly toolChoice: ToolChoice | undefined;

  constructor(options: HttpRunnerOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxTokens = options.maxTokens ?? 512;
    this.tools = options.tools ?? [];
    this.toolChoice = options.toolChoice;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const response = await this.completeChat(
      [{ role: "user", content: prompt }],
      trial,
    );
    return formatResponse(response, this.name);
  }

  async completeChat(
    messages: readonly ChatMessage[],
    trial = 0,
  ): Promise<ChatResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: toAnthropicMessages(messages),
      };
      if (this.tools.length > 0 && this.toolChoice !== "none") {
        body.tools = this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }));
        if (this.toolChoice === "auto") {
          body.tool_choice = { type: "auto" };
        } else if (this.toolChoice === "required") {
          body.tool_choice = { type: "any" };
        }
      }

      response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RunnerError(
        `${this.name}: request failed: ${(error as Error).message}`,
        { retryable: true },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
        text,
      );
      throw new RunnerError(
        `${this.name}: HTTP ${response.status}: ${text.slice(0, 400)}`,
        {
          retryable: isRetryableStatus(response.status),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RunnerError(
        `${this.name}: response was not JSON: ${text.slice(0, 300)}`,
        { retryable: true },
      );
    }

    const extracted = extractAnthropicResponse(body);
    if (extracted === null) {
      throw new RunnerError(
        `${this.name}: response did not contain a completion: ${text.slice(0, 300)}`,
        { retryable: false },
      );
    }

    if (extracted.text === null && extracted.toolCalls.length === 0) {
      const hint =
        extracted.finishReason === "max_tokens"
          ? ` (stop_reason=max_tokens; raise maxTokens above ${this.maxTokens})`
          : "";
      throw new RunnerError(
        `${this.name}: no completion content${hint}: ${text.slice(0, 300)}`,
        { retryable: false },
      );
    }

    return { text: extracted.text, toolCalls: extracted.toolCalls };
  }
}

function formatResponse(response: ChatResponse, name: string): string {
  const output = formatToolOutput(response.text, response.toolCalls);
  if (output === null) {
    throw new RunnerError(`${name}: no completion content`, {
      retryable: false,
    });
  }
  return output;
}

function toOpenAiMessages(
  messages: readonly ChatMessage[],
): Record<string, unknown>[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.content };
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      case "assistant": {
        const result: Record<string, unknown> = {
          role: "assistant",
          content: message.content,
        };
        if (message.toolCalls.length > 0) {
          result.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments:
                call.rawArguments ?? JSON.stringify(call.arguments) ?? "{}",
            },
          }));
        }
        return result;
      }
    }
  });
}

function toAnthropicMessages(
  messages: readonly ChatMessage[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let pendingToolResults: Record<string, unknown>[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }

    flushToolResults();

    if (message.role === "user") {
      result.push({ role: "user", content: message.content });
      continue;
    }

    const content: Record<string, unknown>[] = [];
    if (message.content !== null && message.content.trim() !== "") {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: anthropicInput(call),
      });
    }
    result.push({ role: "assistant", content });
  }

  flushToolResults();
  return result;
}

function anthropicInput(call: AgentToolCall): Record<string, unknown> {
  if (
    typeof call.arguments === "object" &&
    call.arguments !== null &&
    !Array.isArray(call.arguments)
  ) {
    return call.arguments as Record<string, unknown>;
  }
  return {};
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Providers signal rate limits in different places: a Retry-After header, an
 * ISO timestamp, or a reset_seconds field. Honor all of them when present.
 */
export function parseRetryAfter(
  header: string | null,
  body: string,
): number | undefined {
  const fromHeader = parseRetryAfterValue(header);
  if (fromHeader !== undefined) return fromHeader;

  try {
    const parsed: unknown = JSON.parse(body);
    const record =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    if (!record) return undefined;

    const nested =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : undefined;

    for (const source of [record, nested]) {
      if (!source) continue;
      const seconds = source.reset_seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds)) {
        return clampRetryAfter(seconds * 1000);
      }
      const raw = source.retry_after;
      if (typeof raw === "string") {
        const parsedDate = Date.parse(raw);
        if (Number.isFinite(parsedDate)) {
          return clampRetryAfter(parsedDate - Date.now());
        }
      }
    }
  } catch {
    // Body was not JSON; the header is the only signal.
  }

  return undefined;
}

function parseRetryAfterValue(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clampRetryAfter(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return clampRetryAfter(date - Date.now());
  return undefined;
}

function clampRetryAfter(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 0), 300_000);
}

function extractFinishReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  const reason = (choice as { finish_reason?: unknown }).finish_reason;
  return typeof reason === "string" ? reason : null;
}

interface ExtractedResponse {
  text: string | null;
  toolCalls: AgentToolCall[];
  finishReason: string | null;
}

function extractOpenAiResponse(body: unknown): ExtractedResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const content = (message as { content?: unknown }).content;
  const text = typeof content === "string" ? content : null;
  return {
    text,
    toolCalls: extractOpenAiToolCalls(message),
    finishReason: extractFinishReason(body),
  };
}

function extractOpenAiToolCalls(message: object): AgentToolCall[] {
  const raw = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) return [];

  const calls: AgentToolCall[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const fn = (item as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) return;

    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string" || name === "") return;

    const rawId = (item as { id?: unknown }).id;
    const id =
      typeof rawId === "string" && rawId !== "" ? rawId : `call_${index}`;
    const args = (fn as { arguments?: unknown }).arguments;
    const rawArguments = typeof args === "string" ? args : undefined;
    calls.push({
      id,
      name,
      arguments:
        typeof args === "string"
          ? parseToolArguments(args)
          : (args ?? {}),
      ...(rawArguments !== undefined ? { rawArguments } : {}),
    });
  });
  return calls;
}

function extractAnthropicResponse(body: unknown): ExtractedResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  const calls: AgentToolCall[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;

    if (record.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
    } else if (record.type === "tool_use") {
      const name = record.name;
      if (typeof name === "string" && name !== "") {
        const rawId = record.id;
        const id =
          typeof rawId === "string" && rawId !== ""
            ? rawId
            : `toolu_${calls.length}`;
        calls.push({
          id,
          name,
          arguments: record.input ?? {},
        });
      }
    }
  }

  return {
    text: texts.length > 0 ? texts.join("\n") : null,
    toolCalls: calls,
    finishReason: extractAnthropicStopReason(body),
  };
}

function extractAnthropicStopReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const reason = (body as { stop_reason?: unknown }).stop_reason;
  return typeof reason === "string" ? reason : null;
}

interface Fields {
  id: string;
  value: string;
  label: string;
}

function parseFields(prompt: string): Fields | null {
  const values = new Map<string, string>();

  for (const line of prompt.split(/\r?\n/)) {
    const match = /^(id|value|label)\s*=\s*(.+)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!.trim());
  }

  const value = values.get("value");
  if (value === undefined) return null;

  return {
    id: values.get("id") ?? "0",
    value,
    label: values.get("label") ?? '""',
  };
}

/**
 * Scripted stacks used by `skew demo`. They never touch the network. Each one
 * models a different real-world failure mode:
 *
 *   alpha  - loses precision on unsafe integers, rounds floats, drops nulls
 *   beta   - semantically faithful, but always fences and pretty-prints
 *   gamma  - nondeterministic across trials
 *   delta  - refuses anything containing "patient"
 */
export class AlphaStack implements Runner {
  readonly name: string = "alpha";

  async complete(prompt: string): Promise<string> {
    const fields = parseFields(prompt);
    if (!fields) return "I could not extract the requested fields.";

    const id = Number(fields.id);
    const parsedLabel: unknown = JSON.parse(fields.label);
    const label = typeof parsedLabel === "string" ? parsedLabel : String(parsedLabel);

    let value: unknown;
    if (fields.value === "null") {
      value = undefined;
    } else if (/^-?\d+$/.test(fields.value)) {
      value = Number.parseInt(fields.value, 10);
    } else {
      const parsed: unknown = JSON.parse(fields.value);
      value =
        typeof parsed === "number" && !Number.isInteger(parsed)
          ? Math.round(parsed * 100) / 100
          : parsed;
    }

    const output: Record<string, unknown> = { id };
    if (value !== undefined) output.value = value;
    output.label = label;
    return JSON.stringify(output);
  }
}

export class BetaStack implements Runner {
  readonly name: string = "beta";

  async complete(prompt: string, _trial = 0): Promise<string> {
    const fields = parseFields(prompt);
    if (!fields) return "No fields found.";

    return (
      "```json\n{\n" +
      `  "id": ${fields.id},\n` +
      `  "value": ${fields.value},\n` +
      `  "label": ${fields.label}\n` +
      "}\n```"
    );
  }
}

export class GammaStack extends BetaStack {
  override readonly name: string = "gamma";

  override async complete(prompt: string, trial = 0): Promise<string> {
    if (trial % 2 === 1) {
      return JSON.stringify({ status: "unavailable" });
    }
    return super.complete(prompt, trial);
  }
}

export class DeltaStack extends BetaStack {
  override readonly name: string = "delta";

  override async complete(prompt: string, trial = 0): Promise<string> {
    if (/\bpatient\b/i.test(prompt)) {
      return "I'm sorry, but I can't help with extracting patient records.";
    }
    return super.complete(prompt, trial);
  }
}

export function demoStacks(): Runner[] {
  return [
    new AlphaStack(),
    new BetaStack(),
    new GammaStack(),
    new DeltaStack(),
  ];
}
