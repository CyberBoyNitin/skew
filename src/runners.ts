import type { HttpRunnerOptions, Runner } from "./types.ts";

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

export class HttpRunner implements Runner {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(options: HttpRunnerOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: this.temperature,
          seed: trial,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RunnerError(
        `${this.name}: request failed: ${(error as Error).message}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new RunnerError(
        `${this.name}: HTTP ${response.status}: ${text.slice(0, 400)}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RunnerError(
        `${this.name}: response was not JSON: ${text.slice(0, 300)}`,
      );
    }

    const content = extractContent(body);
    if (content === null) {
      throw new RunnerError(
        `${this.name}: unexpected response shape: ${text.slice(0, 300)}`,
      );
    }
    return content;
  }
}

function extractContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
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
