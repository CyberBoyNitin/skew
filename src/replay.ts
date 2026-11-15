import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunnerError } from "./runners.ts";
import { isAgentRunner } from "./types.ts";
import type {
  AgentRunner,
  AgentToolCall,
  ChatMessage,
  ChatResponse,
  Runner,
} from "./types.ts";

export type ReplayEntry =
  | {
      kind: "text";
      prompt: string;
      trial: number;
      output: string;
    }
  | {
      kind: "chat";
      messages: ChatMessage[];
      trial: number;
      output: ChatResponse;
    };

export interface ReplayManifest {
  version: number;
  createdAt: string;
  skew: string;
  stacks: string[];
}

function textKey(prompt: string, trial: number): string {
  return JSON.stringify(["text", prompt, trial]);
}

function chatKey(messages: readonly ChatMessage[], trial: number): string {
  return JSON.stringify(["chat", messages, trial]);
}

export function safeStackName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Wraps a live runner and remembers every successful completion. Call
 * saveRecordings() after the run to write a replayable fixture directory.
 * One-shot completions and multi-turn chat requests live in the same file;
 * kind distinguishes them without breaking v0.4 fixtures.
 */
export class RecordingRunner implements AgentRunner {
  readonly name: string;
  private readonly inner: Runner;
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly order: string[] = [];

  constructor(inner: Runner) {
    this.inner = inner;
    this.name = inner.name;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const output = await this.inner.complete(prompt, trial);
    this.record(textKey(prompt, trial), {
      kind: "text",
      prompt,
      trial,
      output,
    });
    return output;
  }

  async completeChat(
    messages: readonly ChatMessage[],
    trial = 0,
  ): Promise<ChatResponse> {
    if (!isAgentRunner(this.inner)) {
      throw new RunnerError(
        `${this.name}: underlying runner does not support multi-turn chat`,
        { retryable: false },
      );
    }
    const output = await this.inner.completeChat(messages, trial);
    const recordedMessages = cloneMessages(messages);
    this.record(chatKey(recordedMessages, trial), {
      kind: "chat",
      messages: recordedMessages,
      trial,
      output,
    });
    return output;
  }

  get size(): number {
    return this.entries.size;
  }

  entriesInOrder(): ReplayEntry[] {
    return this.order
      .map((key) => this.entries.get(key))
      .filter((entry): entry is ReplayEntry => entry !== undefined);
  }

  private record(key: string, entry: ReplayEntry): void {
    if (!this.entries.has(key)) this.order.push(key);
    this.entries.set(key, entry);
  }
}

export async function saveRecordings(
  dir: string,
  runners: RecordingRunner[],
  version: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const used = new Set<string>();
  for (const runner of runners) {
    const file = safeStackName(runner.name);
    if (used.has(file)) {
      throw new Error(`duplicate recording file name for stack "${runner.name}"`);
    }
    used.add(file);

    const lines = runner
      .entriesInOrder()
      .map((entry) => JSON.stringify(entry));
    await writeFile(
      join(dir, `${file}.jsonl`),
      lines.length > 0 ? `${lines.join("\n")}\n` : "",
      "utf8",
    );
  }

  const manifest: ReplayManifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    skew: version,
    stacks: runners.map((runner) => runner.name),
  };
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export class ReplayRunner implements AgentRunner {
  readonly name: string;
  private readonly outputs: Map<string, string>;
  private readonly chats: Map<string, ChatResponse>;

  constructor(
    name: string,
    outputs: Map<string, string> = new Map(),
    chats: Map<string, ChatResponse> = new Map(),
  ) {
    this.name = name;
    this.outputs = outputs;
    this.chats = chats;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const output = this.outputs.get(textKey(prompt, trial));
    if (output === undefined) {
      throw new RunnerError(
        `${this.name}: no recorded output for trial ${trial} (${prompt.length} char prompt)`,
        { retryable: false },
      );
    }
    return output;
  }

  async completeChat(
    messages: readonly ChatMessage[],
    trial = 0,
  ): Promise<ChatResponse> {
    const output = this.chats.get(chatKey(messages, trial));
    if (output === undefined) {
      throw new RunnerError(
        `${this.name}: no recorded chat output for trial ${trial} (${messages.length} messages)`,
        { retryable: false },
      );
    }
    return output;
  }
}

export async function loadReplayRunners(
  dir: string,
  names: string[],
): Promise<ReplayRunner[]> {
  const used = new Set<string>();

  return Promise.all(
    names.map(async (name) => {
      const file = safeStackName(name);
      if (used.has(file)) {
        throw new Error(`duplicate replay file name for stack "${name}"`);
      }
      used.add(file);

      const path = join(dir, `${file}.jsonl`);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        throw new Error(`replay file not found for stack "${name}": ${path}`);
      }

      const outputs = new Map<string, string>();
      const chats = new Map<string, ChatResponse>();
      raw.split(/\r?\n/).forEach((line, index) => {
        if (line.trim() === "") return;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `${path}:${index + 1}: invalid JSON: ${(error as Error).message}`,
          );
        }
        parseEntry(entry, path, index + 1, outputs, chats);
      });

      return new ReplayRunner(name, outputs, chats);
    }),
  );
}

function parseEntry(
  entry: unknown,
  path: string,
  line: number,
  outputs: Map<string, string>,
  chats: Map<string, ChatResponse>,
): void {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${path}:${line}: invalid replay entry`);
  }
  const record = entry as Record<string, unknown>;
  const kind = record.kind;
  const trial = record.trial;
  if (!Number.isInteger(trial)) {
    throw new Error(`${path}:${line}: invalid replay trial`);
  }

  if (
    kind === "chat" ||
    (kind === undefined && Array.isArray(record.messages))
  ) {
    const messages = record.messages;
    const output = record.output;
    if (!isChatMessages(messages) || !isChatResponse(output)) {
      throw new Error(`${path}:${line}: invalid chat replay entry`);
    }
    chats.set(chatKey(messages, trial as number), output);
    return;
  }

  if (
    kind === "text" ||
    (kind === undefined && typeof record.prompt === "string")
  ) {
    if (
      typeof record.prompt !== "string" ||
      typeof record.output !== "string"
    ) {
      throw new Error(`${path}:${line}: invalid text replay entry`);
    }
    outputs.set(textKey(record.prompt, trial as number), record.output);
    return;
  }

  throw new Error(`${path}:${line}: invalid replay entry`);
}

function isChatMessages(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every(isChatMessage);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.role) {
    case "user":
      return typeof record.content === "string";
    case "assistant":
      return (
        (record.content === null || typeof record.content === "string") &&
        Array.isArray(record.toolCalls) &&
        record.toolCalls.every(isAgentToolCall)
      );
    case "tool":
      return (
        typeof record.toolCallId === "string" &&
        typeof record.name === "string" &&
        typeof record.content === "string" &&
        (record.isError === undefined || typeof record.isError === "boolean")
      );
    default:
      return false;
  }
}

function isAgentToolCall(value: unknown): value is AgentToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    "arguments" in record &&
    (record.rawArguments === undefined ||
      typeof record.rawArguments === "string")
  );
}

function isChatResponse(value: unknown): value is ChatResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.text === null || typeof record.text === "string") &&
    Array.isArray(record.toolCalls) &&
    record.toolCalls.every(isAgentToolCall)
  );
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return structuredClone(messages) as ChatMessage[];
}
