export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type LlmToolChoice = "auto" | "none" | "required" | { name: string };

export interface LlmCompletionInput {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
  /** Cancels provider work when the owning runtime is shutting down. */
  signal?: AbortSignal;
}

export interface LlmCompletion {
  content: string | null;
  toolCalls: LlmToolCall[];
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  complete(input: LlmCompletionInput): Promise<LlmCompletion>;
}

export class LlmProviderUnavailableError extends Error {
  constructor(message = "Language model is temporarily unavailable") {
    super(message);
    this.name = "LlmProviderUnavailableError";
  }
}
