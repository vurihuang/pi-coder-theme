import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { DerivedThinkingStep, ThinkingSemanticRole, ThinkingThemeLike } from "./types.js";

type RenderThinkingStepsOptions = {
  mode: "compact" | "summary";
  width: number;
  steps: DerivedThinkingStep[];
  theme: ThinkingThemeLike;
  activeStepId?: string;
  isActive: boolean;
  nowMs?: number;
};

function sanitizeThinkingText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[0-9@-~])/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

function roleColor(role: ThinkingSemanticRole): string {
  switch (role) {
    case "verify":
      return "success";
    case "error":
      return "error";
    case "compare":
      return "warning";
    case "inspect":
    case "search":
      return "mdLink";
    case "write":
    case "plan":
      return "accent";
    default:
      return "muted";
  }
}

function styleSummary(theme: ThinkingThemeLike, text: string, active: boolean): string {
  const styled = theme.fg("thinkingText", sanitizeThinkingText(text));
  return active && theme.bold ? theme.bold(styled) : styled;
}

function pulseGlyph(theme: ThinkingThemeLike, nowMs: number): string {
  const frames = [theme.fg("dim", "·"), theme.fg("muted", "•"), theme.fg("accent", "•"), theme.fg("muted", "•")];
  return frames[Math.floor(nowMs / 180) % frames.length] ?? frames[0]!;
}

function pickCompactStep(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep | undefined {
  if (activeStepId) {
    const active = steps.find((step) => step.id === activeStepId);
    if (active) return active;
  }

  return [...steps].sort((left, right) =>
    right.collapsedPriority - left.collapsedPriority
    || right.blockIndex - left.blockIndex
    || right.stepIndex - left.stepIndex,
  )[0];
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), "");
}

function renderThinkingHeader(theme: ThinkingThemeLike, width: number, isActive: boolean, nowMs: number): string {
  const status = isActive ? pulseGlyph(theme, nowMs) : theme.fg("success", "●");
  return fitLine(`${status} ${theme.fg("toolTitle", "Thinking")}`, width);
}

function renderTreeStep(theme: ThinkingThemeLike, width: number, step: DerivedThinkingStep, active: boolean, connector: string): string[] {
  const prefix = ` ${theme.fg("dim", connector)} ${theme.fg(roleColor(step.role), step.icon)} `;
  const continuationPrefix = `${theme.fg("dim", connector === "└─" ? "    " : " │  ")}${" ".repeat(visibleWidth(step.icon) + 1)}`;
  const wrapped = wrapTextWithAnsi(styleSummary(theme, step.summary, active), Math.max(1, width - visibleWidth(prefix)));

  if (wrapped.length === 0) return [fitLine(prefix, width)];

  return wrapped.map((line, index) => fitLine(`${index === 0 ? prefix : continuationPrefix}${line}`, width));
}

function renderCompact(options: RenderThinkingStepsOptions): string[] {
  const { width, steps, theme, activeStepId, isActive, nowMs = Date.now() } = options;
  const step = pickCompactStep(steps, activeStepId);
  if (!step) return [];

  return [
    renderThinkingHeader(theme, width, isActive, nowMs),
    ...renderTreeStep(theme, width, step, isActive, "└─"),
  ];
}

function renderSummary(options: RenderThinkingStepsOptions): string[] {
  const { width, steps, theme, activeStepId, isActive, nowMs = Date.now() } = options;
  if (steps.length === 0) return [];

  const visibleSteps = steps.length > 6 ? [...steps.slice(0, 2), ...steps.slice(-4)] : steps;
  const lines = [renderThinkingHeader(theme, width, isActive, nowMs)];

  visibleSteps.forEach((step, index) => {
    const connector = index === visibleSteps.length - 1 ? "└─" : "├─";
    lines.push(...renderTreeStep(theme, width, step, step.id === activeStepId, connector));
  });

  return lines;
}

export function renderThinkingSteps(options: RenderThinkingStepsOptions): string[] {
  if (options.width <= 0 || options.steps.length === 0) return [];
  return options.mode === "compact" ? renderCompact(options) : renderSummary(options);
}
