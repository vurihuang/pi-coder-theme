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

function renderCompact(options: RenderThinkingStepsOptions): string[] {
  const { width, steps, theme, activeStepId, isActive, nowMs = Date.now() } = options;
  const step = pickCompactStep(steps, activeStepId);
  if (!step) return [];

  const activity = isActive ? pulseGlyph(theme, nowMs) : theme.fg("dim", "·");
  const prefix = `${theme.fg("muted", "│")} ${theme.fg("dim", "Thinking")} ${theme.fg(roleColor(step.role), step.icon)} `;
  const suffix = ` ${activity}`;
  const summaryWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  const summaryLines = wrapTextWithAnsi(styleSummary(theme, step.summary, isActive), summaryWidth);

  if (summaryLines.length <= 1) {
    return [fitLine(`${prefix}${summaryLines[0] ?? ""}${suffix}`, width)];
  }

  const continuationPrefix = `${theme.fg("muted", "│")} ${" ".repeat(visibleWidth(`Thinking ${step.icon} `))}`;
  const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix) - visibleWidth(suffix));
  const rewrapped = wrapTextWithAnsi(styleSummary(theme, step.summary, isActive), continuationWidth);

  return rewrapped.map((line, index) => {
    const isFirst = index === 0;
    const isLast = index === rewrapped.length - 1;
    return fitLine(`${isFirst ? prefix : continuationPrefix}${line}${isLast ? suffix : ""}`, width);
  });
}

function renderStepHeader(theme: ThinkingThemeLike, width: number, step: DerivedThinkingStep, active: boolean, connector: string): string[] {
  const prefix = `${theme.fg("muted", connector)} ${theme.fg(roleColor(step.role), step.icon)} `;
  const wrapped = wrapTextWithAnsi(styleSummary(theme, step.summary, active), Math.max(1, width - visibleWidth(prefix)));

  if (wrapped.length === 0) return [fitLine(prefix, width)];

  const continuationPrefix = `${theme.fg("muted", "│ ")}${" ".repeat(visibleWidth(step.icon) + 1)}`;
  return wrapped.map((line, index) => fitLine(`${index === 0 ? prefix : continuationPrefix}${line}`, width));
}

function renderSummary(options: RenderThinkingStepsOptions): string[] {
  const { width, steps, theme, activeStepId } = options;
  if (steps.length === 0) return [];

  const visibleSteps = steps.length > 6 ? [...steps.slice(0, 2), ...steps.slice(-4)] : steps;
  const lines = [fitLine(`${theme.fg("muted", "┆")} ${theme.fg("accent", "Thinking Steps")}`, width)];

  visibleSteps.forEach((step, index) => {
    const connector = index === visibleSteps.length - 1 ? "└─" : "├─";
    lines.push(...renderStepHeader(theme, width, step, step.id === activeStepId, connector));
  });

  return lines;
}

export function renderThinkingSteps(options: RenderThinkingStepsOptions): string[] {
  if (options.width <= 0 || options.steps.length === 0) return [];
  return options.mode === "compact" ? renderCompact(options) : renderSummary(options);
}
