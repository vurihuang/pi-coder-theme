import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { deriveThinkingSteps } from "./parse.js";
import { renderThinkingSteps } from "./render.js";
import type { ThinkingThemeLike } from "./types.js";

const theme: ThinkingThemeLike = {
  fg(color, text) {
    return `[${color}]${text}`;
  },
  bold(text) {
    return `<b>${text}</b>`;
  },
  italic(text) {
    return `<i>${text}</i>`;
  },
};

test("renders compact thinking with a Task-style header and branch", () => {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "Plan the renderer." }]);

  expect(renderThinkingSteps({ mode: "compact", width: 80, steps, theme, isActive: false })).toEqual([
    "[success]● [toolTitle]Thinking",
    " [dim]└─ [accent]◇ [thinkingText]Plan the renderer.",
  ]);
});

test("renders multiple complete steps in summary order", () => {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "Inspect parser.\n\nVerify renderer." }]);

  expect(renderThinkingSteps({ mode: "summary", width: 80, steps, theme, isActive: false })).toEqual([
    "[success]● [toolTitle]Thinking",
    " [dim]├─ [mdLink]◫ [thinkingText]Inspect parser.",
    " [dim]└─ [success]✓ [thinkingText]Verify renderer.",
  ]);
});

test("keeps narrow output within requested visible width", () => {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "Inspect an extremely long renderer summary that must wrap or truncate in narrow terminals." }]);
  const lines = renderThinkingSteps({ mode: "compact", width: 24, steps, theme, isActive: true });

  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  }
});

test("strips raw control sequences from rendered thinking", () => {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "Verify \u001b[31mred\u001b[0m output." }]);

  expect(renderThinkingSteps({ mode: "summary", width: 80, steps, theme, isActive: false }).join("\n")).not.toContain("\u001b");
});

test("returns no lines when there are no steps", () => {
  expect(renderThinkingSteps({ mode: "compact", width: 80, steps: [], theme, isActive: false })).toEqual([]);
});
