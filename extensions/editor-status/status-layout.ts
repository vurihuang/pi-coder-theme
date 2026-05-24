import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_LEFT_INSET = 1;
const STATUS_RIGHT_INSET = 1;

export type StatusColorizer = (color: ThemeColor, text: string) => string;

export interface EditorStatusLayout {
  topLeft: string;
  topRight: string;
  cwd: string;
  statusLeft: string;
  statusRight: string;
}

export interface WorkingStatusInput {
  active: boolean;
  message: string;
  frame: string;
}

export interface ElapsedStatusInput {
  active: boolean;
  elapsedMs: number | undefined;
}

export interface BackgroundWorkerStatusInput {
  state: "launching" | "running" | "verifying" | "recovering" | "failed";
  attempt: number;
  workerStartedAt: number | null;
  elapsedMs: number | null;
}

export interface GitChangesStatusInput {
  changedFiles: number;
  added: number;
  modified: number;
  removed: number;
}

export interface StatusLayoutCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export class StatusLayoutCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached: { width: number; at: number; layout: EditorStatusLayout } | undefined;
  recomputeCount = 0;

  constructor(options: StatusLayoutCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  get(width: number, build: () => EditorStatusLayout): EditorStatusLayout {
    const now = this.now();
    if (this.cached && this.cached.width === width && now - this.cached.at < this.ttlMs) {
      return this.cached.layout;
    }

    const layout = build();
    this.cached = { width, at: now, layout };
    this.recomputeCount += 1;
    return layout;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

export function renderStatusRows(width: number, leftLabel: string, rightLabel: string): string[] {
  if (!leftLabel && !rightLabel) return [];

  const contentWidth = Math.max(1, width - STATUS_LEFT_INSET - STATUS_RIGHT_INSET);
  const maxLeft = Math.max(0, Math.floor(contentWidth * 0.44));
  const maxRight = Math.max(0, contentWidth - maxLeft - 2);
  const left = truncateToWidth(leftLabel, maxLeft, "…");
  const right = truncateToWidth(rightLabel, maxRight, "…");
  const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(right)));
  const leftPadding = " ".repeat(Math.min(STATUS_LEFT_INSET, Math.max(0, width - contentWidth)));
  const rightPadding = " ".repeat(Math.min(STATUS_RIGHT_INSET, Math.max(0, width - contentWidth - visibleWidth(leftPadding))));
  return [`${leftPadding}${left}${gap}${right}${rightPadding}`];
}

export function thinkingColor(thinkingLevel: string): ThemeColor {
  switch (thinkingLevel) {
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "off":
    default:
      return "thinkingOff";
  }
}

export function statusTextColor(active: boolean): ThemeColor {
  return active ? "accent" : "muted";
}

export function buildUsageLabel(parts: string[]): string {
  return `${parts.join(" · ")} `;
}

export function buildModelLabel(
  maxWidth: number,
  thinkingLevel: string,
  extensionStatusLabel: string,
  compactModel: (maxWidth: number) => string,
  fg: StatusColorizer,
): string {
  const thinkingStatus = [thinkingLevel, extensionStatusLabel].filter(Boolean).join("  ");
  const thinkingStatusWidth = visibleWidth(thinkingStatus);
  const modelWidth = Math.max(1, maxWidth - thinkingStatusWidth - 3);
  const styledModel = fg("text", compactModel(modelWidth));
  const thinking = fg(thinkingColor(thinkingLevel), thinkingLevel);
  const extensionStatus = extensionStatusLabel ? `  ${fg("accent", extensionStatusLabel)}` : "";
  return ` ${styledModel} ${fg("dim", "·")} ${thinking}${extensionStatus} `;
}

export function buildCwdLabel(pathLabel: string, branch: string | null): string {
  return ` ${pathLabel}${branch ? ` (${branch})` : ""} `;
}

export function buildWorkingLabel(working: WorkingStatusInput, fg: StatusColorizer): string {
  if (!working.active) return "";

  const cancelHint = `${fg("accent", "Esc")}${fg("muted", " to cancel")}`;
  return `${fg("accent", working.frame)} ${fg("text", working.message)}  ${cancelHint}`;
}

function getElapsedDuration(elapsed: ElapsedStatusInput, formatElapsed: (elapsedMs: number) => string): string {
  if (elapsed.elapsedMs === undefined || (elapsed.active && elapsed.elapsedMs < 1000)) return "";
  return formatElapsed(elapsed.elapsedMs);
}

function getElapsedTimeBucket(elapsed: ElapsedStatusInput, formatElapsed: (elapsedMs: number) => string): string {
  const duration = getElapsedDuration(elapsed, formatElapsed);
  return duration ? `${elapsed.active ? "active" : "complete"}:${duration}` : "";
}

function getBackgroundWorkerElapsedMs(worker: BackgroundWorkerStatusInput): number | null {
  const liveElapsedMs = worker.workerStartedAt !== null ? Date.now() - worker.workerStartedAt : null;
  return liveElapsedMs !== null && worker.elapsedMs !== null ? Math.max(liveElapsedMs, worker.elapsedMs) : liveElapsedMs ?? worker.elapsedMs;
}

function getBackgroundWorkerBucket(worker: BackgroundWorkerStatusInput | undefined, formatElapsed: (elapsedMs: number) => string): string {
  if (!worker) return "";
  const elapsedMs = getBackgroundWorkerElapsedMs(worker);
  return `${worker.state}:${worker.attempt}:${elapsedMs === null ? "" : formatElapsed(elapsedMs)}`;
}

export function buildStatusTickKey(
  elapsed: ElapsedStatusInput,
  worker: BackgroundWorkerStatusInput | undefined,
  formatElapsed: (elapsedMs: number) => string,
): string {
  return `${getElapsedTimeBucket(elapsed, formatElapsed)}|${getBackgroundWorkerBucket(worker, formatElapsed)}`;
}

export function buildElapsedTimeLabel(
  elapsed: ElapsedStatusInput,
  formatElapsed: (elapsedMs: number) => string,
  fg: StatusColorizer,
): string {
  const duration = getElapsedDuration(elapsed, formatElapsed);
  if (!duration) return "";

  const color = statusTextColor(elapsed.active);
  return `${fg(color, "⏱")} ${fg(color, duration)}`;
}

export function buildBackgroundWorkerLabel(
  worker: BackgroundWorkerStatusInput | undefined,
  working: WorkingStatusInput,
  width: number,
  formatElapsed: (elapsedMs: number) => string,
  fg: StatusColorizer,
): string {
  if (!worker) return "";

  const elapsedMs = getBackgroundWorkerElapsedMs(worker);
  const duration = elapsedMs !== null ? formatElapsed(elapsedMs) : "";
  const color: ThemeColor = worker.state === "failed" ? "error" : worker.state === "recovering" ? "warning" : worker.state === "verifying" ? "muted" : "accent";
  const glyph = worker.state === "running" ? working.frame : worker.state === "verifying" ? "✓" : worker.state === "recovering" ? "!" : worker.state === "failed" ? "×" : "·";
  const chart = worker.state === "running" ? fg(color, "▁▃▅") : worker.state === "recovering" ? fg(color, "▅▃▁") : "";
  const attempt = worker.attempt > 0 ? `#${worker.attempt}` : "";
  const rich = [fg(color, glyph), fg(color, "sub"), fg(color, attempt), duration ? fg(color, duration) : "", chart].filter(Boolean).join(" ");
  const normal = [fg(color, glyph), fg(color, "sub"), fg(color, attempt), duration ? fg(color, duration) : fg(color, worker.state)].filter(Boolean).join(" ");
  const compact = [fg(color, "sub"), attempt ? fg(color, attempt) : "", duration ? fg(color, duration) : fg(color, worker.state)].filter(Boolean).join(" ");

  if (width >= 96) return rich;
  if (width >= 56) return normal;
  return compact;
}

export function buildGitChangesLabel(git: GitChangesStatusInput, fg: StatusColorizer): string {
  if (git.changedFiles === 0) return "";

  const fileLabel = fg("muted", `${git.changedFiles} ${git.changedFiles === 1 ? "file" : "files"} changed`);
  const added = git.added > 0 ? ` ${fg("toolDiffAdded", `+${git.added}`)}` : "";
  const modified = git.modified > 0 ? ` ${fg("warning", `~${git.modified}`)}` : "";
  const removed = git.removed > 0 ? ` ${fg("toolDiffRemoved", `-${git.removed}`)}` : "";
  return `${fileLabel}${added}${modified}${removed}`;
}
