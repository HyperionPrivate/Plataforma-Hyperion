import { describe, expect, it, vi } from "vitest";
import { DeepSeekLlmProvider } from "./deepseek-llm-provider.js";
import { LlmProviderUnavailableError } from "./llm-provider.js";

describe("DeepSeekLlmProvider", () => {
  it("uses non-thinking tool calling and retries one transient response", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (calls.length === 1) return new Response("{}", { status: 429 });
      return new Response(
        JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "call-1", function: { name: "get_catalog", arguments: "{}" } }]
              }
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const provider = new DeepSeekLlmProvider({ apiKey: "controlled-test-key", fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.complete({
      messages: [{ role: "system", content: "Prompt controlado" }],
      tools: [
        {
          type: "function",
          function: { name: "get_catalog", description: "catalog", parameters: { type: "object", properties: {} } }
        }
      ]
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[1]).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      tool_choice: "auto",
      stream: false
    });
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "get_catalog", arguments: "{}" }]);
    expect(result).toMatchObject({ inputTokens: 12, outputTokens: 4 });
  });

  it("fails closed when no API key is configured", async () => {
    const provider = new DeepSeekLlmProvider({ apiKey: "" });
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toBeInstanceOf(LlmProviderUnavailableError);
  });
});
