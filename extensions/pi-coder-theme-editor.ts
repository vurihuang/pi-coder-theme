import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildBackgroundWorkerLabel,
  buildCwdLabel,
  buildElapsedTimeLabel,
  buildGitChangesLabel,
  buildModelLabel,
  buildStatusTickKey,
  buildUsageLabel,
  buildWorkingLabel,
  renderStatusRows,
  StatusLayoutCache,
  type EditorStatusLayout,
} from "./editor-status/status-layout.js";
import { StatusRenderScheduler, type StatusRenderDirtyReason } from "./editor-status/status-render-scheduler.js";
import { BUILTIN_COMMAND_PALETTE_ITEMS, CommandPaletteOverlay, type CommandPaletteItem, type CommandPaletteResult, stripAnsi } from "./pi-coder-theme-command-palette.js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MIN_BODY_LINES = 1;
const GIT_CACHE_MS = 2000;
const WORKSPACE_GIT_CHILD_LIMIT = 10;
const WORKSPACE_GIT_BUDGET_MS = 350;
const WORKING_FRAMES = ["~", "≈", "≋"];
const STATUS_TICK_MS = 1000;
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_CHATGPT_QUOTA_REFRESH_MINUTES = 5;
const CONFIG_CACHE_MS = 2000;

function getExtensionDataDir(): string {
  return join(process.env.HOME || homedir(), ".pi", "agent", "extensions", "pi-coder-themes");
}

function getConfigFile(): string {
  return join(getExtensionDataDir(), "config.json");
}

type WorkingState = {
  active: boolean;
  message: string;
  frame: string;
};

type ElapsedTimeState = {
  active: boolean;
  elapsedMs: number | undefined;
};

type SubagentTimingState = {
  activeRunIds: Set<string>;
};

type BackgroundWorkerState = {
  provider: string;
  state: "launching" | "running" | "verifying" | "recovering" | "failed";
  attempt: number;
  workerStartedAt: number | null;
  elapsedMs: number | null;
};

type GitInfo = {
  branch: string | null;
  changedFiles: number;
  added: number;
  modified: number;
  removed: number;
};

type UsageCost = {
  total: number;
  hasCost: boolean;
  usingSubscription: boolean;
};

type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  hasUsage: boolean;
};

type DisplayConfig = {
  tokenUsage: boolean;
  chatGptQuotaRefreshMs: number;
};

type StatusDataSnapshot = {
  cwd: string;
  model: ExtensionContext["model"];
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]> | undefined;
  tokenUsage: TokenUsage;
  cost: UsageCost;
  git: GitInfo;
  config: DisplayConfig;
};

type ChatGptQuotaWindow = {
  usedPercent: number;
  windowSeconds: number;
};

type ChatGptQuotaSnapshot = {
  fiveHour?: ChatGptQuotaWindow;
  weekly?: ChatGptQuotaWindow;
};

type QuotaModelRegistry = ExtensionContext["modelRegistry"] & {
  isUsingOAuth?: (model: NonNullable<ExtensionContext["model"]>) => boolean;
};

type SubCoreRateWindow = {
  label: string;
  usedPercent: number;
};

type SubCoreUsageSnapshot = {
  provider: string;
  windows: SubCoreRateWindow[];
};

type SubCoreState = {
  provider?: string;
  usage?: SubCoreUsageSnapshot;
};

type SubCoreRequest = {
  type?: "current";
  reply: (payload: { state: SubCoreState }) => void;
};

type SubCoreAction = {
  type: "refresh";
  force?: boolean;
};

type FooterData = {
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
};

type TuiLike = {
  requestRender(force?: boolean): void;
};

type HistoryCapableEditor = {
  addToHistory?: (text: string) => void;
};

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];
type SessionManagerLike = ExtensionContext["sessionManager"] & {
  getSessionDir?: () => string | undefined;
  getSessionFile?: () => string | undefined;
};

let gitCache: { cwd: string; at: number; info: GitInfo } | undefined;
let chatGptQuotaSnapshot: ChatGptQuotaSnapshot | undefined;
let chatGptQuotaInFlight: Promise<void> = Promise.resolve();
let displayConfigCache: { path: string; mtimeMs: number; at: number; config: DisplayConfig } | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeSubagentRunId(value: unknown): string | undefined {
  const record = asRecord(value);
  const id = record?.id ?? record?.asyncId ?? record?.runId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function normalizeBackgroundWorkerState(value: unknown): { action: "set"; state: BackgroundWorkerState } | { action: "clear" } | { action: "ignore" } {
  const record = asRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2) || record.provider !== "pi-goal-driven") return { action: "ignore" };

  const state = record.state;
  if (state === "idle" || state === "brainstorm" || state === "complete") return { action: "clear" };
  if (state !== "launching" && state !== "running" && state !== "verifying" && state !== "recovering" && state !== "failed") return { action: "ignore" };

  const attempt = typeof record.attempt === "number" && Number.isFinite(record.attempt) ? Math.max(0, Math.floor(record.attempt)) : 0;
  const workerStartedAt = typeof record.workerStartedAt === "number" && Number.isFinite(record.workerStartedAt) ? record.workerStartedAt : null;
  const elapsedMs = typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs) ? Math.max(0, record.elapsedMs) : null;

  return {
    action: "set",
    state: {
      provider: record.provider,
      state,
      attempt,
      workerStartedAt,
      elapsedMs,
    },
  };
}

function normalizeQuotaWindow(value: unknown): ChatGptQuotaWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const usedPercent = typeof record.used_percent === "number" ? record.used_percent : undefined;
  const windowSeconds = typeof record.limit_window_seconds === "number" ? record.limit_window_seconds : undefined;
  if (usedPercent === undefined || windowSeconds === undefined) return undefined;

  return { usedPercent, windowSeconds };
}

function normalizeDisplayConfig(value: unknown): DisplayConfig {
  const record = asRecord(value);
  const display = asRecord(record?.display) ?? record;
  const chatGptQuota = asRecord(record?.chatGptQuota);
  const refreshMinutes = typeof chatGptQuota?.refreshMinutes === "number" && Number.isFinite(chatGptQuota.refreshMinutes) && chatGptQuota.refreshMinutes > 0
    ? chatGptQuota.refreshMinutes
    : DEFAULT_CHATGPT_QUOTA_REFRESH_MINUTES;

  return {
    tokenUsage: display?.tokenUsage !== false,
    chatGptQuotaRefreshMs: refreshMinutes * 60 * 1000,
  };
}

function readDisplayConfig(configFile = getConfigFile()): DisplayConfig {
  const now = Date.now();

  try {
    const mtimeMs = statSync(configFile).mtimeMs;
    if (displayConfigCache?.path === configFile && displayConfigCache.mtimeMs === mtimeMs && now - displayConfigCache.at < CONFIG_CACHE_MS) {
      return displayConfigCache.config;
    }

    const config = normalizeDisplayConfig(JSON.parse(readFileSync(configFile, "utf8")));
    displayConfigCache = { path: configFile, mtimeMs, at: now, config };
    return config;
  } catch {
    const config = normalizeDisplayConfig(undefined);
    displayConfigCache = { path: configFile, mtimeMs: 0, at: now, config };
    return config;
  }
}

export function parseChatGptQuotaSnapshot(data: unknown): ChatGptQuotaSnapshot | undefined {
  const rateLimit = asRecord(asRecord(data)?.rate_limit);
  if (!rateLimit) return undefined;

  const windows = [
    normalizeQuotaWindow(rateLimit.primary_window),
    normalizeQuotaWindow(rateLimit.secondary_window),
  ].filter((window): window is ChatGptQuotaWindow => Boolean(window));

  const snapshot = {
    fiveHour: windows.find((window) => Math.abs(window.windowSeconds - FIVE_HOUR_SECONDS) <= 120),
    weekly: windows.find((window) => Math.abs(window.windowSeconds - WEEK_SECONDS) <= 120),
  } satisfies ChatGptQuotaSnapshot;

  return snapshot.fiveHour || snapshot.weekly ? snapshot : undefined;
}

function formatQuotaPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function formatRemainingQuotaPercent(window: ChatGptQuotaWindow): string {
  return formatQuotaPercent(100 - window.usedPercent);
}

export function formatChatGptQuota(snapshot: ChatGptQuotaSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;

  const parts = [];
  if (snapshot.fiveHour) parts.push(`5h ${formatRemainingQuotaPercent(snapshot.fiveHour)}`);
  if (snapshot.weekly) parts.push(`W ${formatRemainingQuotaPercent(snapshot.weekly)}`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

export function formatAgentElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(elapsedMs) ? elapsedMs / 1000 : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function isChatGptQuotaProvider(provider: string | undefined): boolean {
  return provider === "openai-codex" || /^openai-codex-\d+$/.test(provider || "") || provider === "openai";
}

function getActiveModel(ctx: ExtensionContext | undefined): ExtensionContext["model"] | undefined {
  try {
    return ctx?.model;
  } catch {
    return undefined;
  }
}

function isUsingOAuth(ctx: ExtensionContext): boolean {
  try {
    const model = ctx.model;
    if (!model) return false;
    return Boolean((ctx.modelRegistry as QuotaModelRegistry).isUsingOAuth?.(model));
  } catch {
    return false;
  }
}

function quotaSnapshotFromSubCoreUsage(usage: SubCoreUsageSnapshot | undefined): ChatGptQuotaSnapshot | undefined {
  if (!usage || usage.provider !== "codex") return undefined;

  const snapshot = {
    fiveHour: usage.windows.find((window) => window.label === "3h" || window.label === "5h")
      ? {
          usedPercent: usage.windows.find((window) => window.label === "3h" || window.label === "5h")!.usedPercent,
          windowSeconds: FIVE_HOUR_SECONDS,
        }
      : undefined,
    weekly: usage.windows.find((window) => window.label === "Week")
      ? {
          usedPercent: usage.windows.find((window) => window.label === "Week")!.usedPercent,
          windowSeconds: WEEK_SECONDS,
        }
      : undefined,
  } satisfies ChatGptQuotaSnapshot;

  return snapshot.fiveHour || snapshot.weekly ? snapshot : undefined;
}

function applySubCoreState(ctx: ExtensionContext | undefined, state: SubCoreState | undefined, requestRender: () => void): void {
  const model = getActiveModel(ctx);
  if (!ctx || !model || !isChatGptQuotaProvider(model.provider) || !isUsingOAuth(ctx)) {
    chatGptQuotaSnapshot = undefined;
    requestRender();
    return;
  }

  chatGptQuotaSnapshot = quotaSnapshotFromSubCoreUsage(state?.usage);
  requestRender();
}

async function ensureSubCoreLoaded(pi: ExtensionAPI): Promise<void> {
  try {
    const specifier = "@marckrenn/pi-sub-core";
    const module = await import(specifier) as { default?: unknown };
    const createCore = module.default as undefined | ((api: unknown) => void | Promise<void>);
    if (typeof createCore === "function") {
      await createCore(pi);
    }
  } catch (error) {
    console.warn("Failed to load @marckrenn/pi-sub-core:", error);
  }
}

function requestSubCoreState(pi: ExtensionAPI, timeoutMs = 1000): Promise<SubCoreState | undefined> {
  if (!pi.events) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();

    const request: SubCoreRequest = {
      type: "current",
      reply: (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload.state);
      },
    };

    pi.events.emit("sub-core:request", request);
  });
}

function refreshChatGptQuotaFromSubCore(pi: ExtensionAPI, ctx: ExtensionContext, requestRender: () => void, force = false): void {
  chatGptQuotaInFlight = chatGptQuotaInFlight
    .catch(() => undefined)
    .then(async () => {
      const model = getActiveModel(ctx);
      if (!model || !isChatGptQuotaProvider(model.provider) || !isUsingOAuth(ctx)) {
        chatGptQuotaSnapshot = undefined;
        requestRender();
        return;
      }

      if (!pi.events) {
        chatGptQuotaSnapshot = undefined;
        requestRender();
        return;
      }

      await ensureSubCoreLoaded(pi);
      if (force) {
        const action: SubCoreAction = { type: "refresh", force: true };
        pi.events.emit("sub-core:action", action);
      }
      const state = await requestSubCoreState(pi);
      applySubCoreState(ctx, state, requestRender);
    });
}

function remainingGitBudget(deadline: number | undefined): number {
  return deadline === undefined ? 500 : Math.max(0, Math.min(500, deadline - Date.now()));
}

function runGit(cwd: string, args: string[], deadline?: number): string {
  const timeout = remainingGitBudget(deadline);
  if (timeout <= 0) return "";

  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch {
    return "";
  }
}

function emptyGitInfo(branch: string | null = null): GitInfo {
  return { branch, changedFiles: 0, added: 0, modified: 0, removed: 0 };
}

function isGitWorkTree(cwd: string, deadline?: number): boolean {
  return runGit(cwd, ["rev-parse", "--is-inside-work-tree"], deadline) === "true";
}

function collectRepoGitInfo(cwd: string, includeBranch: boolean, deadline?: number): GitInfo {
  const branch = includeBranch ? runGit(cwd, ["branch", "--show-current"], deadline) || null : null;
  const porcelain = runGit(cwd, ["status", "--short"], deadline);
  const changedFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  const numstat = runGit(cwd, ["diff", "--numstat"], deadline);
  let added = 0;
  let removed = 0;

  for (const line of numstat.split("\n")) {
    const [a, r] = line.split("\t");
    const add = Number(a);
    const rem = Number(r);
    if (Number.isFinite(add)) added += add;
    if (Number.isFinite(rem)) removed += rem;
  }

  const modified = Math.min(added, removed);
  return { branch, changedFiles, added: added - modified, modified, removed: removed - modified };
}

function addGitInfo(total: GitInfo, next: GitInfo): void {
  total.changedFiles += next.changedFiles;
  total.added += next.added;
  total.modified += next.modified;
  total.removed += next.removed;
}

function collectWorkspaceGitInfo(cwd: string, startedAt: number): GitInfo {
  const deadline = startedAt + WORKSPACE_GIT_BUDGET_MS;
  let children: string[] = [];
  try {
    children = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cwd, entry.name));
  } catch {
    return emptyGitInfo();
  }

  if (children.length > WORKSPACE_GIT_CHILD_LIMIT) return emptyGitInfo();

  const total = emptyGitInfo();
  for (const child of children) {
    if (Date.now() >= deadline) break;
    if (!isGitWorkTree(child, deadline)) continue;
    addGitInfo(total, collectRepoGitInfo(child, false, deadline));
  }
  return total;
}

function getGitInfo(cwd: string): GitInfo {
  const now = Date.now();
  if (gitCache && gitCache.cwd === cwd && now - gitCache.at < GIT_CACHE_MS) return gitCache.info;

  const info = isGitWorkTree(cwd) ? collectRepoGitInfo(cwd, true) : collectWorkspaceGitInfo(cwd, now);
  gitCache = { cwd, at: now, info };
  return info;
}

function formatCount(value: number | null | undefined): string {
  if (value == null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatCost(value: number): string {
  if (value === 0) return "$0.000";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function compactModelId(modelId: string, maxWidth: number): string {
  if (visibleWidth(modelId) <= maxWidth) return modelId;

  const simplified = modelId
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");

  if (visibleWidth(simplified) <= maxWidth) return simplified;
  return truncateToWidth(simplified, maxWidth, "…");
}

function compactModelReference(model: NonNullable<ExtensionContext["model"]>, maxWidth: number): string {
  if (!model.provider) return compactModelId(model.id, maxWidth);

  const modelRef = `${model.provider}/${model.id}`;
  if (visibleWidth(modelRef) <= maxWidth) return modelRef;

  const providerPrefix = `${model.provider}/`;
  const idWidth = maxWidth - visibleWidth(providerPrefix);
  if (idWidth > 1) return `${providerPrefix}${compactModelId(model.id, idWidth)}`;

  return truncateToWidth(modelRef, maxWidth, "…");
}

function compactProjectPath(cwd: string): string {
  return basename(cwd) || cwd;
}

function isEditorRule(line: string): boolean {
  const plain = stripAnsi(line).trim();
  return plain.includes("─") && [...plain].every((char) => "─↑↓ 0123456789more".includes(char));
}

function splitEditorRender(lines: string[]): { editorLines: string[]; popupLines: string[] } {
  const withoutTop = lines.slice(1);
  const bottomRuleIndex = withoutTop.findIndex(isEditorRule);

  if (bottomRuleIndex === -1) {
    return { editorLines: withoutTop, popupLines: [] };
  }

  return {
    editorLines: withoutTop.slice(0, bottomRuleIndex),
    popupLines: withoutTop.slice(bottomRuleIndex + 1),
  };
}

function getUsingSubscription(ctx: ExtensionContext): boolean {
  try {
    return ctx.model
      ? Boolean((ctx.modelRegistry as { isUsingOAuth?: (model: NonNullable<ExtensionContext["model"]>) => boolean }).isUsingOAuth?.(ctx.model))
      : false;
  } catch {
    return false;
  }
}

function getSessionCost(ctx: ExtensionContext): UsageCost {
  try {
    let total = 0;
    let hasCost = false;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;

      const cost = entry.message.usage?.cost?.total;
      if (typeof cost !== "number" || !Number.isFinite(cost)) continue;

      total += cost;
      if (cost > 0) hasCost = true;
    }

    return { total, hasCost, usingSubscription: getUsingSubscription(ctx) };
  } catch {
    return { total: 0, hasCost: false, usingSubscription: getUsingSubscription(ctx) };
  }
}

function getSessionTokenUsage(ctx: ExtensionContext): TokenUsage {
  try {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let hasUsage = false;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;

      const usage = entry.message.usage;
      if (!usage) continue;

      const inputTokens = Number.isFinite(usage.input) ? usage.input : 0;
      const outputTokens = Number.isFinite(usage.output) ? usage.output : 0;
      const readTokens = Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
      const writeTokens = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
      input += inputTokens;
      output += outputTokens;
      cacheRead += readTokens;
      cacheWrite += writeTokens;
      hasUsage ||= inputTokens > 0 || outputTokens > 0 || readTokens > 0 || writeTokens > 0;
    }

    return { input, output, cacheRead, cacheWrite, hasUsage };
  } catch {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false };
  }
}

function formatTokenUsage(usage: TokenUsage, config = readDisplayConfig()): string | undefined {
  if (!usage.hasUsage || !config.tokenUsage) return undefined;

  const parts = [];
  if (usage.input > 0) parts.push(`↑${formatCount(usage.input)}`);
  if (usage.output > 0) parts.push(`↓${formatCount(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`R${formatCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`W${formatCount(usage.cacheWrite)}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function hasActiveUI(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
  if (!ctx) return false;
  try {
    return ctx.hasUI;
  } catch {
    return false;
  }
}

function withActiveUI(ctx: ExtensionContext | undefined, callback: (ui: ExtensionContext["ui"]) => void): void {
  if (!hasActiveUI(ctx)) return;

  try {
    callback(ctx.ui);
  } catch {
    // Ignore stale UI contexts after session replacement or shutdown.
  }
}

function hideBuiltInWorking(ctx: ExtensionContext): void {
  withActiveUI(ctx, (ui) => {
    (ui as typeof ui & { setWorkingVisible?: (visible: boolean) => void }).setWorkingVisible?.(false);
  });
}

function getUserMessageText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;

  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((part) => part.type === "text" ? part.text : undefined)
    .filter((part): part is string => typeof part === "string")
    .join("\n");

  return text || undefined;
}

function parseSessionHistoryEntries(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.type === "message") entries.push(entry);
    } catch {
      // Ignore partially-written or incompatible session lines.
    }
  }
  return entries;
}

function getRecentSessionHistoryEntries(sessionManager: SessionManagerLike, limit = 20): SessionEntry[] {
  const sessionDir = sessionManager.getSessionDir?.();
  if (!sessionDir) return [];

  try {
    const currentSessionFile = sessionManager.getSessionFile?.();
    const files = readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(sessionDir, file))
      .filter((file) => file !== currentSessionFile)
      .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(-limit);

    return files.flatMap(({ file }) => parseSessionHistoryEntries(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

function seedEditorHistory(editor: HistoryCapableEditor, ctx: ExtensionContext): void {
  try {
    const sessionManager = ctx.sessionManager as SessionManagerLike;
    const entries = [
      ...getRecentSessionHistoryEntries(sessionManager),
      ...sessionManager.getEntries(),
    ];

    for (const entry of entries) {
      const text = getUserMessageText(entry);
      if (text) editor.addToHistory?.(text);
    }
  } catch {
    // Ignore stale session managers while the UI is being replaced.
  }
}

function safeModel(ctx: ExtensionContext): ExtensionContext["model"] {
  try {
    return ctx.model;
  } catch {
    return undefined;
  }
}

function safeContextUsage(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> | undefined {
  try {
    return ctx.getContextUsage();
  } catch {
    return undefined;
  }
}

function safeCwd(ctx: ExtensionContext): string {
  try {
    return ctx.cwd;
  } catch {
    return process.cwd();
  }
}

type EditorRenderRequestTracker = {
  handlingInput: boolean;
  requested: boolean;
};

function wrapEditorTui(tui: any, invalidateEditorBody: () => void, tracker?: EditorRenderRequestTracker): any {
  return Object.create(tui, {
    requestRender: {
      configurable: true,
      value(force?: boolean) {
        invalidateEditorBody();
        if (tracker?.handlingInput) tracker.requested = true;
        return tui.requestRender?.(force);
      },
    },
  });
}

class PiCoderThemeEditor extends CustomEditor {
  private readonly renderRequestTracker: EditorRenderRequestTracker;
  private bodySnapshot: { innerWidth: number; editorLines: string[]; popupLines: string[] } | undefined;
  private bodyDirty = true;
  private asyncInputRenderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly baseTui: any,
    private readonly renderTheme: any,
    keybindings: any,
    private readonly getCtx: () => ExtensionContext,
    private readonly getStatusLayout: (width: number) => EditorStatusLayout,
    private readonly clearCompletedElapsedTime: () => void,
    private readonly invalidateEditorBodySnapshot: () => void,
    private readonly openCommandPalette: (initialQuery: string | undefined, onSelect: (result: CommandPaletteResult) => void) => void,
  ) {
    const renderRequestTracker: EditorRenderRequestTracker = { handlingInput: false, requested: false };
    super(wrapEditorTui(baseTui, invalidateEditorBodySnapshot, renderRequestTracker), renderTheme, keybindings, { paddingX: 1 });
    this.renderRequestTracker = renderRequestTracker;
  }

  invalidateEditorBody(): void {
    this.bodyDirty = true;
  }

  private requestEditorRender(force?: boolean): void {
    this.invalidateEditorBodySnapshot();
    this.baseTui.requestRender?.(force);
  }

  private get ctx(): ExtensionContext {
    return this.getCtx();
  }

  handleInput(data: string): void {
    if (data === "/" && this.getText().trim() === "") {
      this.invalidateEditorBodySnapshot();
      this.openCommandPalette(undefined, (result) => {
        if (result.action === "insert") {
          this.insertCommand(result.command);
        } else {
          this.submitCommand(result.command);
        }
      });
      return;
    }

    const before = this.getText();
    this.renderRequestTracker.handlingInput = true;
    this.renderRequestTracker.requested = false;
    try {
      super.handleInput(data);
    } finally {
      this.renderRequestTracker.handlingInput = false;
    }
    if (this.getText() !== before) {
      this.clearCompletedElapsedTime();
    } else {
      this.scheduleAsyncInputRender();
    }
    if (!this.renderRequestTracker.requested) this.requestEditorRender();
  }

  private scheduleAsyncInputRender(): void {
    if (this.asyncInputRenderTimer) clearTimeout(this.asyncInputRenderTimer);
    this.asyncInputRenderTimer = setTimeout(() => {
      this.asyncInputRenderTimer = undefined;
      this.requestEditorRender();
    }, 80);
    this.asyncInputRenderTimer.unref?.();
  }

  private insertCommand(command: string): void {
    this.clearCompletedElapsedTime();
    this.setText(`/${command} `);
    this.requestEditorRender();
  }

  private submitCommand(command: string): void {
    this.clearCompletedElapsedTime();
    this.setText(`/${command}`);
    this.requestEditorRender();
    (this as unknown as { submitValue(): void }).submitValue();
  }

  render(width: number): string[] {
    if (width < 12) return super.render(width);

    const innerWidth = Math.max(1, width - 2);
    if (this.bodyDirty || !this.bodySnapshot || this.bodySnapshot.innerWidth !== innerWidth) {
      const base = super.render(innerWidth);
      const { editorLines, popupLines } = splitEditorRender(base);
      this.bodySnapshot = { innerWidth, editorLines, popupLines };
      this.bodyDirty = false;
    }
    const { editorLines, popupLines } = this.bodySnapshot;
    const body = [...editorLines];

    while (body.length < MIN_BODY_LINES) {
      body.push(" ".repeat(innerWidth));
    }

    const statusLayout = this.getStatusLayout(width);

    const lastBodyIndex = body.length - 1;

    return [
      this.borderWithLabels(width, statusLayout.topLeft, statusLayout.topRight),
      ...body.map((line, index) => index === lastBodyIndex
        ? this.wrapBottomBody(line, innerWidth, statusLayout.cwd)
        : this.wrapBody(line, innerWidth)),
      ...renderStatusRows(width, statusLayout.statusLeft, statusLayout.statusRight),
      ...this.wrapPopupBlock(popupLines, width),
    ];
  }

  private fg(color: ThemeColor, text: string): string {
    const renderTheme = this.renderTheme as { fg?: (color: ThemeColor, text: string) => string };
    if (typeof renderTheme.fg === "function") return renderTheme.fg(color, text);

    try {
      return this.ctx.ui.theme.fg(color, text);
    } catch {
      return text;
    }
  }

  private wrapBody(line: string, innerWidth: number): string {
    const clipped = truncateToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    const content = clipped ? this.fg("text", clipped) : clipped;
    return this.sideBorder() + content + padding + this.sideBorder();
  }

  private wrapBottomBody(line: string, innerWidth: number, rightLabel: string): string {
    const contentWidth = Math.max(0, innerWidth - 2);
    const clipped = truncateToWidth(line.trimEnd(), contentWidth, "");
    const content = clipped ? this.fg("text", clipped) : clipped;
    const labelWidth = Math.max(0, contentWidth - visibleWidth(clipped) - 1);
    const right = rightLabel && labelWidth > 0 ? this.fg("muted", truncateToWidth(rightLabel, labelWidth, "…")) : "";
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped) - visibleWidth(right)));
    return this.editorBorderColor("╰─") + content + padding + right + this.editorBorderColor("─╯");
  }

  private editorBorderColor(text: string): string {
    return this.borderColor(text);
  }

  private wrapPopupBlock(lines: string[], width: number): string[] {
    if (lines.length === 0) return [];

    return lines.map((line) => {
      const clipped = truncateToWidth(line, width, "");
      const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
      return clipped + padding;
    });
  }

  private borderWithLabels(width: number, leftLabel: string, rightLabel: string): string {
    const innerWidth = Math.max(0, width - 2);
    const maxLeft = Math.max(0, Math.floor(innerWidth * 0.44));
    const maxRight = Math.max(0, innerWidth - maxLeft - 2);
    const left = this.fg("muted", truncateToWidth(leftLabel, maxLeft, "…"));
    const right = truncateToWidth(rightLabel, maxRight, "…");
    const used = visibleWidth(left) + visibleWidth(right);
    const fill = Math.max(0, innerWidth - used);
    return this.editorBorderColor("╭") + left + this.editorBorderColor("─".repeat(fill)) + right + this.editorBorderColor("╮");
  }

  private sideBorder(): string {
    return this.editorBorderColor("│");
  }

}

function getCommandPaletteItems(pi: ExtensionAPI): CommandPaletteItem[] {
  const items = [
    ...BUILTIN_COMMAND_PALETTE_ITEMS,
    ...pi.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
      source: command.source,
    })),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export default function (pi: ExtensionAPI) {
  const activeToolExecutions = new Set<string>();
  let activeThinkingLevel = "off";
  let activeCtx: ExtensionContext | undefined;
  let activeTui: TuiLike | undefined;
  let activeEditor: PiCoderThemeEditor | undefined;
  let footerData: FooterData | undefined;
  let commandPaletteOpen = false;
  let backgroundWorkerState: BackgroundWorkerState | undefined;
  let isWorking = false;
  let workingMessage = "Waiting for response...";
  let workingFrameIndex = 0;
  let executionStartedAt: number | undefined;
  let completedElapsedMs: number | undefined;
  const subagentTiming: SubagentTimingState = { activeRunIds: new Set() };
  const statusLayoutCache = new StatusLayoutCache();
  let statusScheduler: StatusRenderScheduler | undefined;
  let statusDataSnapshot: StatusDataSnapshot | undefined;
  let statusDataRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let statusDataRefreshVersion = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let lastStatusTickKey: string | undefined;
  let quotaRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const configFile = getConfigFile();

  const requestRender = (force?: boolean) => activeTui?.requestRender(force);
  const getConfig = () => readDisplayConfig(configFile);
  const getExtensionStatusLabel = () => [...(footerData?.getExtensionStatuses?.().values() ?? [])].filter(Boolean).join(" ");
  const readThinkingLevel = () => {
    try {
      return pi.getThinkingLevel();
    } catch {
      return activeThinkingLevel;
    }
  };
  const syncEditorBorderColor = (ctx: ExtensionContext | undefined = activeCtx, level = readThinkingLevel()) => {
    if (!activeEditor || !hasActiveUI(ctx)) return;

    const theme = ctx.ui.theme as typeof ctx.ui.theme & {
      getThinkingBorderColor?: (level: string) => (text: string) => string;
    };
    const borderColor = theme.getThinkingBorderColor?.(level);
    if (borderColor) activeEditor.borderColor = borderColor;
  };
  const hasActiveExecution = () => isWorking || subagentTiming.activeRunIds.size > 0;
  const getElapsedTimeState = (): ElapsedTimeState => {
    if (hasActiveExecution() && executionStartedAt !== undefined) return { active: true, elapsedMs: Date.now() - executionStartedAt };
    return { active: false, elapsedMs: completedElapsedMs };
  };
  const emptyTokenUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false });
  const emptyCost = (ctx: ExtensionContext): UsageCost => ({ total: 0, hasCost: false, usingSubscription: getUsingSubscription(ctx) });
  const fallbackStatusDataSnapshot = (ctx: ExtensionContext): StatusDataSnapshot => ({
    cwd: safeCwd(ctx),
    model: safeModel(ctx),
    contextUsage: safeContextUsage(ctx),
    tokenUsage: emptyTokenUsage(),
    cost: emptyCost(ctx),
    git: emptyGitInfo(),
    config: getConfig(),
  });
  const collectStatusDataSnapshot = (ctx: ExtensionContext): StatusDataSnapshot => {
    const cwd = safeCwd(ctx);
    return {
      cwd,
      model: safeModel(ctx),
      contextUsage: safeContextUsage(ctx),
      tokenUsage: getSessionTokenUsage(ctx),
      cost: getSessionCost(ctx),
      git: getGitInfo(cwd),
      config: getConfig(),
    };
  };
  const seedStatusDataSnapshot = (ctx: ExtensionContext, preserveExpensiveFields = false) => {
    const cwd = safeCwd(ctx);
    const previous = preserveExpensiveFields ? statusDataSnapshot : undefined;
    statusDataSnapshot = {
      cwd,
      model: safeModel(ctx),
      contextUsage: safeContextUsage(ctx),
      tokenUsage: previous?.tokenUsage ?? emptyTokenUsage(),
      cost: previous?.cost ?? emptyCost(ctx),
      git: previous?.cwd === cwd ? previous.git : emptyGitInfo(),
      config: getConfig(),
    };
    statusLayoutCache.invalidate();
  };
  const scheduleStatusDataRefresh = (ctx: ExtensionContext | undefined = activeCtx, force = false) => {
    if (!ctx) return;
    const version = ++statusDataRefreshVersion;
    if (statusDataRefreshTimer) {
      clearTimeout(statusDataRefreshTimer);
      statusDataRefreshTimer = undefined;
    }
    statusDataRefreshTimer = setTimeout(() => {
      statusDataRefreshTimer = undefined;
      if (version !== statusDataRefreshVersion) return;
      const latestCtx = activeCtx ?? ctx;
      if (!hasActiveUI(latestCtx)) return;
      statusDataSnapshot = collectStatusDataSnapshot(latestCtx);
      statusLayoutCache.invalidate();
      if (force) {
        forceStatusRefresh("status");
      } else {
        invalidateStatus("status");
      }
    }, 0);
    statusDataRefreshTimer.unref?.();
  };
  const getStatusDataSnapshot = (ctx: ExtensionContext): StatusDataSnapshot => statusDataSnapshot ?? fallbackStatusDataSnapshot(ctx);
  const invalidateStatus = (reason: StatusRenderDirtyReason = "status") => {
    statusLayoutCache.invalidate();
    statusScheduler?.markDirty(reason);
  };
  const forceStatusRefresh = (reason: StatusRenderDirtyReason = "status") => {
    statusLayoutCache.invalidate();
    statusScheduler?.forceRefresh(reason);
  };
  const invalidateEditorBody = () => {
    activeEditor?.invalidateEditorBody();
  };
  statusScheduler = new StatusRenderScheduler({
    onRender: () => requestRender(),
  });
  const clearCompletedElapsedTime = () => {
    if (isWorking || completedElapsedMs === undefined) return;
    completedElapsedMs = undefined;
    invalidateStatus("status");
  };
  const getBackgroundWorkerState = () => backgroundWorkerState;

  const getStatusTickKey = () => buildStatusTickKey(getElapsedTimeState(), backgroundWorkerState, formatAgentElapsedTime);

  const resetStatusTickKey = () => {
    lastStatusTickKey = getStatusTickKey();
  };

  const stopWorkingTimer = () => {
    if (!workingTimer) return;
    clearInterval(workingTimer);
    workingTimer = undefined;
    lastStatusTickKey = undefined;
  };

  const startWorkingTimer = () => {
    resetStatusTickKey();
    if (workingTimer) return;
    workingTimer = setInterval(() => {
      const nextStatusTickKey = getStatusTickKey();
      if (nextStatusTickKey === lastStatusTickKey) return;
      lastStatusTickKey = nextStatusTickKey;
      workingFrameIndex = (workingFrameIndex + 1) % WORKING_FRAMES.length;
      invalidateStatus("status");
    }, STATUS_TICK_MS);
    workingTimer.unref?.();
  };

  const setWorkingMessage = (message: string, ctx?: ExtensionContext, force = false) => {
    if (!force && workingMessage === message) return;
    workingMessage = message;
    withActiveUI(ctx, (ui) => ui.setWorkingMessage(message));
    invalidateStatus("status");
  };

  const stopQuotaRefreshTimer = () => {
    if (!quotaRefreshTimer) return;
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = undefined;
  };

  const startQuotaRefreshTimer = (ctx: ExtensionContext) => {
    stopQuotaRefreshTimer();
    quotaRefreshTimer = setInterval(() => {
      const latestCtx = activeCtx ?? ctx;
      if (hasActiveUI(latestCtx)) refreshChatGptQuotaFromSubCore(pi, latestCtx, () => invalidateStatus("status"), true);
    }, getConfig().chatGptQuotaRefreshMs);
  };

  const openCommandPalette = (initialQuery = "", onSelect: (result: CommandPaletteResult) => void) => {
    const ctx = activeCtx;
    if (!hasActiveUI(ctx) || commandPaletteOpen) return;

    const restoreEditor = () => {
      commandPaletteOpen = false;
    };

    const showPalette = () => {
      if (!hasActiveUI(ctx)) {
        restoreEditor();
        return;
      }

      try {
        void ctx.ui.custom<CommandPaletteResult | null>(
          (tui, theme, keybindings, done) => new CommandPaletteOverlay(
            getCommandPaletteItems(pi),
            initialQuery,
            tui,
            theme,
            keybindings,
            done,
          ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "90%",
              minWidth: 42,
              maxHeight: "80%",
              margin: 1,
            },
          },
        ).then((result) => {
          restoreEditor();
          if (!result) return;
          onSelect(result);
        }).catch(() => {
          restoreEditor();
        });
      } catch {
        restoreEditor();
      }
    };

    commandPaletteOpen = true;
    showPalette();
  };

  pi.events?.on("sub-core:ready", (payload) => {
    applySubCoreState(activeCtx, (payload as { state?: SubCoreState }).state, () => invalidateStatus("status"));
  });

  pi.events?.on("sub-core:update-current", (payload) => {
    applySubCoreState(activeCtx, (payload as { state?: SubCoreState }).state, () => invalidateStatus("status"));
  });

  pi.events?.on("goal-driven:runtime-status", (payload) => {
    const next = normalizeBackgroundWorkerState(payload);
    if (next.action === "ignore") return;
    backgroundWorkerState = next.action === "set" ? next.state : undefined;
    if (backgroundWorkerState) startWorkingTimer();
    if (!backgroundWorkerState && !hasActiveExecution()) stopWorkingTimer();
    invalidateStatus("status");
  });

  pi.events?.on("subagent:async-started", (payload) => {
    const id = normalizeSubagentRunId(payload);
    if (!id) return;
    if (executionStartedAt === undefined) {
      executionStartedAt = Date.now();
      completedElapsedMs = undefined;
    }
    subagentTiming.activeRunIds.add(id);
    startWorkingTimer();
    invalidateStatus("status");
  });

  pi.events?.on("subagent:async-complete", (payload) => {
    const id = normalizeSubagentRunId(payload);
    if (!id) return;
    if (!subagentTiming.activeRunIds.delete(id)) return;
    if (!hasActiveExecution() && executionStartedAt !== undefined) {
      completedElapsedMs = Date.now() - executionStartedAt;
      executionStartedAt = undefined;
    }
    if (!hasActiveExecution() && !backgroundWorkerState) stopWorkingTimer();
    invalidateStatus("status");
  });

  pi.on("session_start", (_event, ctx) => {
    if (!hasActiveUI(ctx)) return;

    activeCtx = ctx;
    seedStatusDataSnapshot(ctx);
    activeThinkingLevel = readThinkingLevel();
    scheduleStatusDataRefresh(ctx);
    refreshChatGptQuotaFromSubCore(pi, ctx, () => invalidateStatus("status"));
    startQuotaRefreshTimer(ctx);

    withActiveUI(ctx, (ui) => {
      ui.setEditorComponent((tui, theme, keybindings) => {
        activeTui = tui;
        const fg = (color: ThemeColor, text: string) => {
          const renderTheme = theme as { fg?: (color: ThemeColor, text: string) => string };
          if (typeof renderTheme.fg === "function") return renderTheme.fg(color, text);
          try {
            return (activeCtx ?? ctx).ui.theme.fg(color, text);
          } catch {
            return text;
          }
        };
        const getWorkingState = (): WorkingState => ({
          active: isWorking,
          message: workingMessage,
          frame: WORKING_FRAMES[workingFrameIndex] ?? WORKING_FRAMES[0],
        });
        const getStatusLayout = (width: number) => statusLayoutCache.get(width, () => {
          const latestCtx = activeCtx ?? ctx;
          const snapshot = getStatusDataSnapshot(latestCtx);
          const innerWidth = Math.max(1, width - 2);
          const working = getWorkingState();
          const model = snapshot.model;
          const usage = snapshot.contextUsage;
          const pct = usage?.percent == null ? "?" : `${Math.max(0, Math.floor(usage.percent))}%`;
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? null;
          const usageParts = [` ${pct}/${formatCount(contextWindow)}`];
          const tokenUsage = formatTokenUsage(snapshot.tokenUsage, snapshot.config);
          const cost = snapshot.cost;
          const git = snapshot.git;
          const chatGptQuota = formatChatGptQuota(chatGptQuotaSnapshot);
          const elapsedTimeLabel = buildElapsedTimeLabel(getElapsedTimeState(), formatAgentElapsedTime, fg);
          const backgroundWorkerLabel = buildBackgroundWorkerLabel(getBackgroundWorkerState(), working, innerWidth, formatAgentElapsedTime, fg);
          const workingLabel = buildWorkingLabel(working, fg);
          const gitChangesLabel = buildGitChangesLabel(git, fg);
          const extensionStatusLabel = getExtensionStatusLabel();

          if (tokenUsage) usageParts.push(tokenUsage);
          if (cost.hasCost || cost.usingSubscription) usageParts.push(`${formatCost(cost.total)}${cost.usingSubscription ? " sub" : ""}`);
          if (chatGptQuota) usageParts.push(chatGptQuota);

          return {
            topLeft: buildUsageLabel(usageParts),
            topRight: buildModelLabel(
              Math.max(8, Math.floor(innerWidth * 0.48)),
              readThinkingLevel(),
              (maxWidth) => model ? compactModelReference(model, maxWidth) : "model unknown",
              fg,
            ),
            cwd: buildCwdLabel(compactProjectPath(snapshot.cwd), git.branch),
            statusLeft: [elapsedTimeLabel, backgroundWorkerLabel, workingLabel].filter(Boolean).join(fg("dim", " · ")),
            statusRight: [gitChangesLabel, extensionStatusLabel].filter(Boolean).join(fg("dim", " · ")),
          };
        });
        const editor = new PiCoderThemeEditor(tui, theme, keybindings, () => activeCtx ?? ctx, getStatusLayout, clearCompletedElapsedTime, invalidateEditorBody, openCommandPalette);
        activeEditor = editor;
        syncEditorBorderColor(activeCtx ?? ctx);
        seedEditorHistory(editor, ctx);
        return editor;
      });

      hideBuiltInWorking(ctx);

      ui.setFooter((tui: TuiLike, _theme: unknown, data?: FooterData) => {
        activeTui = tui;
        footerData = data;
        return {
          invalidate() {
            invalidateStatus("status");
          },
          render() {
            return [];
          },
        };
      });
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    activeThinkingLevel = event.level;
    syncEditorBorderColor(ctx, event.level);
    if (hasActiveUI(ctx)) forceStatusRefresh("status");
  });

  pi.on("model_select", (_event, ctx) => {
    activeCtx = ctx;
    activeThinkingLevel = readThinkingLevel();
    syncEditorBorderColor(ctx, activeThinkingLevel);
    if (hasActiveUI(ctx)) {
      seedStatusDataSnapshot(ctx, true);
      scheduleStatusDataRefresh(ctx, true);
      refreshChatGptQuotaFromSubCore(pi, ctx, () => forceStatusRefresh("status"), true);
      forceStatusRefresh("status");
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    activeThinkingLevel = readThinkingLevel();
    syncEditorBorderColor(ctx, activeThinkingLevel);
    activeToolExecutions.clear();
    if (executionStartedAt === undefined) executionStartedAt = Date.now();
    isWorking = true;
    completedElapsedMs = undefined;
    workingFrameIndex = 0;
    startWorkingTimer();
    if (!hasActiveUI(ctx)) return;
    hideBuiltInWorking(ctx);
    setWorkingMessage("Waiting for response...", ctx, true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!hasActiveUI(ctx)) return;
    hideBuiltInWorking(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!hasActiveUI(ctx) || event.message.role !== "assistant") return;
    if (activeToolExecutions.size > 0) return;
    setWorkingMessage("Streaming response...", ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!hasActiveUI(ctx) || event.message.role !== "assistant") return;
    activeCtx = ctx;
    scheduleStatusDataRefresh(ctx, true);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeToolExecutions.add(event.toolCallId);
    if (!hasActiveUI(ctx)) return;
    setWorkingMessage("Running tools...", ctx);
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    if (!hasActiveUI(ctx)) return;
    setWorkingMessage("Running tools...", ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeToolExecutions.delete(event.toolCallId);
    if (!hasActiveUI(ctx)) return;
    if (activeToolExecutions.size === 0) {
      setWorkingMessage("Waiting for response...", ctx);
    }
  });

  pi.on("agent_end", (_event, _ctx) => {
    isWorking = false;
    if (!hasActiveExecution() && executionStartedAt !== undefined) {
      completedElapsedMs = Date.now() - executionStartedAt;
      executionStartedAt = undefined;
    }
    activeToolExecutions.clear();
    if (!hasActiveExecution() && !backgroundWorkerState) stopWorkingTimer();
    scheduleStatusDataRefresh();
    invalidateStatus("status");
  });

  pi.on("session_shutdown", () => {
    executionStartedAt = undefined;
    completedElapsedMs = undefined;
    subagentTiming.activeRunIds.clear();
    backgroundWorkerState = undefined;
    isWorking = false;
    stopWorkingTimer();
    stopQuotaRefreshTimer();
    if (statusDataRefreshTimer) {
      clearTimeout(statusDataRefreshTimer);
      statusDataRefreshTimer = undefined;
    }
    statusDataRefreshVersion += 1;
    statusScheduler?.cancel();
    statusLayoutCache.invalidate();
    statusDataSnapshot = undefined;
    activeCtx = undefined;
    activeTui = undefined;
    activeEditor = undefined;
    footerData = undefined;
  });
}
