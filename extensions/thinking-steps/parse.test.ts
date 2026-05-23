import { expect, test } from "vitest";

import { deriveThinkingSteps, splitThinkingIntoStepTexts } from "./parse.js";

test("splits paragraphs into ordered thinking steps", () => {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "Inspect the renderer.\n\nVerify the output." }]);

  expect(steps).toMatchObject([
    { id: "thinking-0-0-0", stepIndex: 0, summary: "Inspect the renderer.", body: "Inspect the renderer.", role: "inspect" },
    { id: "thinking-0-0-1", stepIndex: 1, summary: "Verify the output.", body: "Verify the output.", role: "verify" },
  ]);
});

test("keeps standalone headings attached to their body", () => {
  expect(splitThinkingIntoStepTexts("## Renderer\n\nCompare the current and reference behavior.")).toEqual([
    "## Renderer\n\nCompare the current and reference behavior.",
  ]);
});

test("splits top-level list items while preserving continuations", () => {
  expect(splitThinkingIntoStepTexts("- Inspect parser\n  with detail\n- Write tests")).toEqual([
    "- Inspect parser\n  with detail",
    "- Write tests",
  ]);
});

test("returns no steps for empty visible thinking", () => {
  expect(deriveThinkingSteps([{ contentIndex: 0, text: "  \n\t" }])).toEqual([]);
});

test("normalizes markdown only in summaries", () => {
  const [step] = deriveThinkingSteps([{ contentIndex: 2, text: "**Plan** `render` changes" }]);

  expect(step?.summary).toBe("Plan render changes.");
  expect(step?.body).toBe("**Plan** `render` changes");
});

test("strips generated thinking labels from summaries", () => {
  const [step] = deriveThinkingSteps([{ contentIndex: 3, text: "**Thinking:** Investigating configuration issues." }]);

  expect(step?.summary).toBe("Investigating configuration issues.");
  expect(step?.body).toBe("**Thinking:** Investigating configuration issues.");
});

test("redacted empty thinking produces a hidden marker step", () => {
  const [step] = deriveThinkingSteps([{ contentIndex: 4, text: "", redacted: true }]);

  expect(step).toMatchObject({
    summary: "Hidden reasoning.",
    body: "Hidden reasoning.",
    redacted: true,
    role: "default",
  });
});

test("derivation is deterministic", () => {
  const blocks = [{ contentIndex: 0, text: "Search docs.\n\nThen verify tests." }];

  expect(deriveThinkingSteps(blocks)).toEqual(deriveThinkingSteps(blocks));
});
