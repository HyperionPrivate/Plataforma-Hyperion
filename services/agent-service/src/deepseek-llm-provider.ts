import { z } from "zod";
import {
  LlmProviderUnavailableError,
  type LlmCompletion,
  type LlmCompletionInput,
  type LlmMessage,
  type LlmProvider
} from "./llm-provider.js";

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                function: z.object({ name: z.string().min(1), arguments: z.string() })
              })
            )
            .optional()
        })
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional()
    })
    .optional()
});

interface DeepSeekOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DeepSeekLlmProvider implements LlmProvider {
  readonly name = "deepseek";
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(options: DeepSeekOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY?.trim();
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
    this.timeoutMs = options.timeoutMs ?? readPositiveInteger(process.env.DEEPSEEK_TIMEOUT_MS, 8_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    if (!this.apiKey) throw new LlmProviderUnavailableError("DeepSeek is not configured");
    if (this.circuitOpenUntil > this.now()) throw new LlmProviderUnavailableError("DeepSeek circuit is open");

    const started = performance.now();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: input.messages.map(toDeepSeekMessage),
            tools: input.tools,
            tool_choice: "auto",
            thinking: { type: "disabled" },
            stream: false
          }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await sleep(250);
            continue;
          }
          throw new Error(`DeepSeek request failed with status ${response.status}`);
        }

        const parsed = responseSchema.parse(await response.json());
        const message = parsed.choices[0]!.message;
        this.consecutiveFailures = 0;
        this.circuitOpenUntil = 0;
        return {
          content: message.content ?? null,
          toolCalls: (message.tool_calls ?? []).map((tool) => ({
            id: tool.id,
            name: tool.function.name,
            arguments: tool.function.arguments
          })),
          model: parsed.model ?? this.model,
          latencyMs: Math.round(performance.now() - started),
          inputTokens: parsed.usage?.prompt_tokens,
          outputTokens: parsed.usage?.completion_tokens
        };
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isRetryableNetworkError(error)) {
          await sleep(250);
          continue;
        }
        break;
      }
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 3) this.circuitOpenUntil = this.now() + 30_000;
    throw new LlmProviderUnavailableError(lastError instanceof Error ? sanitizeError(lastError.message) : undefined);
  }
}

function toDeepSeekMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content ?? "", tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.toolCalls.map((tool) => ({
        id: tool.id,
        type: "function",
        function: { name: tool.name, arguments: tool.arguments }
      }))
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw ? Number(raw) : fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /timeout|abort|network|fetch/i.test(error.message));
}

function sanitizeError(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
