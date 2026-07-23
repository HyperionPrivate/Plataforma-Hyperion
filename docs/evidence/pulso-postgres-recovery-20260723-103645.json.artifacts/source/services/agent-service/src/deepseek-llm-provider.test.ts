import { describe, expect, it, vi } from "vitest";
import { DeepSeekLlmProvider } from "./deepseek-llm-provider.js";
import { LlmProviderUnavailableError } from "./llm-provider.js";

describe("DeepSeekLlmProvider", () => {
  it("cancels an in-flight request without consuming a second attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("controlled shutdown");
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
    );
    const provider = new DeepSeekLlmProvider({
      apiKey: "controlled-test-key",
      fetchImpl: fetchImpl as typeof fetch
    });

    const completion = provider.complete({ messages: [], tools: [], signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(completion).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels the transient-response retry delay before issuing another request", async () => {
    const controller = new AbortController();
    const reason = new Error("controlled shutdown during retry delay");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    const provider = new DeepSeekLlmProvider({
      apiKey: "controlled-test-key",
      fetchImpl: fetchImpl as typeof fetch
    });

    const completion = provider.complete({ messages: [], tools: [], signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(completion).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps DEEPSEEK_TIMEOUT_MS at ten seconds", () => {
    const previousTimeout = process.env.DEEPSEEK_TIMEOUT_MS;
    process.env.DEEPSEEK_TIMEOUT_MS = "60000";
    try {
      const provider = new DeepSeekLlmProvider({ apiKey: "controlled-test-key" });
      expect((provider as unknown as { timeoutMs: number }).timeoutMs).toBe(10_000);
    } finally {
      if (previousTimeout === undefined) delete process.env.DEEPSEEK_TIMEOUT_MS;
      else process.env.DEEPSEEK_TIMEOUT_MS = previousTimeout;
    }
  });

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

  it("maps a named provider-neutral tool choice to the DeepSeek request", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "call-availability", function: { name: "search_availability", arguments: "{}" } }]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const provider = new DeepSeekLlmProvider({ apiKey: "controlled-test-key", fetchImpl: fetchImpl as typeof fetch });
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "search_availability",
          description: "availability",
          parameters: { type: "object", properties: {} }
        }
      }
    ];

    await provider.complete({
      messages: [{ role: "user", content: "Busca disponibilidad" }],
      tools,
      toolChoice: { name: "search_availability" }
    });

    expect(requestBody).toMatchObject({
      tool_choice: { type: "function", function: { name: "search_availability" } }
    });
  });

  it("rejects a forced tool that was not offered without calling DeepSeek", async () => {
    const fetchImpl = vi.fn();
    const provider = new DeepSeekLlmProvider({ apiKey: "controlled-test-key", fetchImpl: fetchImpl as typeof fetch });

    await expect(
      provider.complete({
        messages: [{ role: "user", content: "Busca disponibilidad" }],
        tools: [
          {
            type: "function",
            function: { name: "get_catalog", description: "catalog", parameters: { type: "object", properties: {} } }
          }
        ],
        toolChoice: { name: "search_availability" }
      })
    ).rejects.toThrow('Forced tool "search_availability" is not included in the offered tools');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
