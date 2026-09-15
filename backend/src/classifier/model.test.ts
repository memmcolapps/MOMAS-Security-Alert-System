import { describe, expect, test } from "bun:test";
import { resolveGroqModel } from ".";

describe("Groq model migration", () => {
  test("replaces the retired primary classifier", () => {
    expect(resolveGroqModel("llama-3.1-8b-instant", "fallback"))
      .toBe("openai/gpt-oss-20b");
  });

  test("replaces the retired verifier", () => {
    expect(resolveGroqModel("llama-3.3-70b-versatile", "fallback"))
      .toBe("openai/gpt-oss-120b");
  });

  test("preserves supported custom models", () => {
    expect(resolveGroqModel("qwen/qwen3.6-27b", "fallback"))
      .toBe("qwen/qwen3.6-27b");
  });
});
