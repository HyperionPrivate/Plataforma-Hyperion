import { z } from "zod";
import {
  LlmProviderUnavailableError,
  type LlmCompletion,
  type LlmCompletionInput,
  type LlmMessage,
  type LlmProvider
} from "./llm-provider.js";

const DEFAULT_DEEPSEEK_TIMEOUT_MS = 8_000;
const MIN_DEEPSEEK_TIMEOUT_MS = 100;
const MAX_DEEPSEEK_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;

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
    this.timeoutMs = readBoundedTimeout(options.timeoutMs ?? process.env.DEEPSEEK_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    input.signal?.throwIfAborted();
    if (!this.apiKey) throw new LlmProviderUnavailableError("DeepSeek is not configured");
    if (this.circuitOpenUntil > this.now()) throw new LlmProviderUnavailableError("DeepSeek circuit is open");
    const toolChoice = toDeepSeekToolChoice(input);

    const started = performance.now();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        input.signal?.throwIfAborted();
        const requestSignal = input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: input.messages.map(toDeepSeekMessage),
            tools: input.tools,
            tool_choice: toolChoice,
            thinking: { type: "disabled" },
            stream: false
          }),
          signal: requestSignal
        });

        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await abortableSleep(RETRY_DELAY_MS, input.signal);
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
        if (input.signal?.aborted) throw input.signal.reason;
        lastError = error;
        if (attempt === 0 && isRetryableNetworkError(error)) {
          await abortableSleep(RETRY_DELAY_MS, input.signal);
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

function toDeepSeekToolChoice(input: LlmCompletionInput): string | Record<string, unknown> {
  const choice = input.toolChoice ?? "auto";
  if (typeof choice === "string") return choice;
  if (!input.tools.some((tool) => tool.function.name === choice.name)) {
    throw new TypeError(`Forced tool "${choice.name}" is not included in the offered tools`);
  }
  return { type: "function", function: { name: choice.name } };
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

function readBoundedTimeout(raw: number | string | undefined): number {
  const value = raw === undefined ? DEFAULT_DEEPSEEK_TIMEOUT_MS : Number(raw);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_DEEPSEEK_TIMEOUT_MS;
  return Math.min(MAX_DEEPSEEK_TIMEOUT_MS, Math.max(MIN_DEEPSEEK_TIMEOUT_MS, value));
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /timeout|abort|network|fetch/i.test(error.message));
}

function sanitizeError(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
