import { describe, expect, test } from "bun:test";
import { addOpenAiWebSearchToPayload, supportsNativeOpenAiWebSearch } from "./index";

describe("recherche web native OpenAI", () => {
  test.each([
    { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", id: "gpt-6-luna" },
    { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", id: "gpt-6-luna" },
  ] as const)("active web_search pour $provider", (model) => {
    expect(supportsNativeOpenAiWebSearch(model as any)).toBe(true);
    const payload = addOpenAiWebSearchToPayload(model as any, { tools: [] }) as any;
    expect(payload.tools).toEqual([{ type: "web_search" }]);
    expect(payload.include).toContain("web_search_call.action.sources");
  });
  test("respecte un type de recherche explicitement configuré", () => {
    const model = { api: "openai-responses", baseUrl: "https://api.openai.com/v1", compat: { webSearchToolType: "web_search_preview" } };
    const payload = addOpenAiWebSearchToPayload(model as any, { tools: [] }) as any;
    expect(payload.tools).toEqual([{ type: "web_search_preview" }]);
  });
});
