import { copyToClipboard, CustomEditor, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.js";
import { TerminalSplitCompositor } from "./fixed-editor/terminal-split.js";
import { BUILTIN_COMMAND_PALETTE_ITEMS, CommandPaletteOverlay, type CommandPaletteItem, type CommandPaletteResult, stripAnsi } from "./pi-coder-theme-command-palette.js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const MIN_BODY_LINES = 2;
const GIT_CACHE_MS = 2000;
const WORKSPACE_GIT_CHILD_LIMIT = 10;
const WORKSPACE_GIT_BUDGET_MS = 350;
const STATUS_LEFT_INSET = 1;
const STATUS_RIGHT_INSET = 1;
const WORKING_FRAMES = ["~", "≈", "≋"];
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
  children?: unknown[];
  terminal?: unknown;
  getShowHardwareCursor?: () => boolean;
};

type Renderable = {
  render(width: number): string[];
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

function compactPath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
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

    const usingSubscription = ctx.model
      ? Boolean((ctx.modelRegistry as { isUsingOAuth?: (model: NonNullable<ExtensionContext["model"]>) => boolean }).isUsingOAuth?.(ctx.model))
      : false;

    return { total, hasCost, usingSubscription };
  } catch {
    return { total: 0, hasCost: false, usingSubscription: false };
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

class PiCoderThemeEditor extends CustomEditor {
  constructor(
    tui: any,
    private readonly renderTheme: any,
    keybindings: any,
    private readonly getCtx: () => ExtensionContext,
    private readonly getThinkingLevel: () => string,
    private readonly getExtensionStatusLabel: () => string,
    private readonly getWorkingState: () => WorkingState,
    private readonly getElapsedTimeState: () => ElapsedTimeState,
    private readonly getBackgroundWorkerState: () => BackgroundWorkerState | undefined,
    private readonly clearCompletedElapsedTime: () => void,
    private readonly openCommandPalette: (initialQuery: string | undefined, onSelect: (result: CommandPaletteResult) => void) => void,
    private readonly getConfig: () => DisplayConfig,
  ) {
    super(tui, renderTheme, keybindings, { paddingX: 1 });
  }

  private get ctx(): ExtensionContext {
    return this.getCtx();
  }

  private get cwd(): string {
    try {
      return this.ctx.cwd;
    } catch {
      return process.cwd();
    }
  }

  private get model(): ExtensionContext["model"] {
    try {
      return this.ctx.model;
    } catch {
      return undefined;
    }
  }

  private get contextUsage(): ReturnType<ExtensionContext["getContextUsage"]> | undefined {
    try {
      return this.ctx.getContextUsage();
    } catch {
      return undefined;
    }
  }

  handleInput(data: string): void {
    if (data === "/" && this.getText().trim() === "") {
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
    super.handleInput(data);
    if (this.getText() !== before) this.clearCompletedElapsedTime();
  }

  private insertCommand(command: string): void {
    this.clearCompletedElapsedTime();
    this.setText(`/${command} `);
    this.tui.requestRender();
  }

  private submitCommand(command: string): void {
    this.clearCompletedElapsedTime();
    this.setText(`/${command}`);
    const submitValue = (this as unknown as { submitValue?: () => void }).submitValue;
    if (submitValue) {
      submitValue.call(this);
      return;
    }

    this.onSubmit?.(`/${command}`);
  }

  render(width: number): string[] {
    if (width < 12) return super.render(width);

    const innerWidth = Math.max(1, width - 2);
    const base = super.render(innerWidth);
    const { editorLines, popupLines } = splitEditorRender(base);
    const body = [...editorLines];

    while (body.length < MIN_BODY_LINES) {
      body.push(" ".repeat(innerWidth));
    }

    const leftTop = this.getUsageLabel();
    const rightTop = this.getModelLabel(Math.max(8, Math.floor(innerWidth * 0.48)));
    const cwdLabel = this.getCwdLabel();
    const workingLabel = this.getWorkingLabel();
    const elapsedTimeLabel = this.getElapsedTimeLabel();
    const backgroundWorkerLabel = this.getBackgroundWorkerLabel(innerWidth);
    const leftStatusLabel = [elapsedTimeLabel, backgroundWorkerLabel, workingLabel].filter(Boolean).join(this.fg("dim", " · "));
    const gitChangesLabel = this.getGitChangesLabel();

    return [
      this.borderWithLabels(width, leftTop, rightTop),
      ...body.map((line) => this.wrapBody(line, innerWidth)),
      this.borderWithRightLabel(width, cwdLabel),
      ...this.statusRows(width, leftStatusLabel, gitChangesLabel),
      ...this.wrapPopupBlock(popupLines, width),
    ];
  }

  private getUsageLabel(): string {
    const usage = this.contextUsage;
    const pct = usage?.percent == null ? "?" : `${Math.max(0, Math.floor(usage.percent))}%`;
    const contextWindow = usage?.contextWindow ?? this.model?.contextWindow ?? null;
    const parts = [` ${pct}/${formatCount(contextWindow)}`];
    const tokenUsage = formatTokenUsage(getSessionTokenUsage(this.ctx), this.getConfig());

    if (tokenUsage) {
      parts.push(tokenUsage);
    }

    const cost = getSessionCost(this.ctx);
    if (cost.hasCost || cost.usingSubscription) {
      parts.push(`${formatCost(cost.total)}${cost.usingSubscription ? " sub" : ""}`);
    }

    const chatGptQuota = formatChatGptQuota(chatGptQuotaSnapshot);
    if (chatGptQuota) {
      parts.push(chatGptQuota);
    }

    return `${parts.join(" · ")} `;
  }

  private getModelLabel(maxWidth: number): string {
    const thinkingLevel = this.getThinkingLevel();
    const extensionStatusLabel = this.getExtensionStatusLabel();
    const thinkingStatus = [thinkingLevel, extensionStatusLabel].filter(Boolean).join("  ");
    const thinkingStatusWidth = visibleWidth(thinkingStatus);
    const modelWidth = Math.max(1, maxWidth - thinkingStatusWidth - 3);
    const model = this.model;
    const modelLabel = model ? compactModelReference(model, modelWidth) : "model unknown";
    const styledModel = this.fg("text", modelLabel);
    const thinking = this.fg(this.getThinkingColor(), thinkingLevel);
    const extensionStatus = extensionStatusLabel ? `  ${this.fg("accent", extensionStatusLabel)}` : "";
    return ` ${styledModel} ${this.fg("dim", "·")} ${thinking}${extensionStatus} `;
  }

  private getThinkingColor(): ThemeColor {
    switch (this.getThinkingLevel()) {
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

  private getCwdLabel(): string {
    const cwd = this.cwd;
    const git = getGitInfo(cwd);
    return ` ${compactPath(cwd)}${git.branch ? ` (${git.branch})` : ""} `;
  }

  private getWorkingLabel(): string {
    const working = this.getWorkingState();
    if (!working.active) return "";

    const cancelHint = `${this.fg("accent", "Esc")}${this.fg("muted", " to cancel")}`;
    return `${this.fg("accent", working.frame)} ${this.fg("text", working.message)}  ${cancelHint}`;
  }

  private getElapsedTimeLabel(): string {
    const elapsed = this.getElapsedTimeState();
    if (elapsed.elapsedMs === undefined || (elapsed.active && elapsed.elapsedMs < 1000)) return "";

    const color: ThemeColor = elapsed.active ? "accent" : "muted";
    return `${this.fg(color, "⏱")} ${this.fg(color, formatAgentElapsedTime(elapsed.elapsedMs))}`;
  }

  private getBackgroundWorkerLabel(width: number): string {
    const worker = this.getBackgroundWorkerState();
    if (!worker) return "";

    const liveElapsedMs = worker.workerStartedAt !== null ? Date.now() - worker.workerStartedAt : null;
    const elapsedMs = liveElapsedMs !== null && worker.elapsedMs !== null ? Math.max(liveElapsedMs, worker.elapsedMs) : liveElapsedMs ?? worker.elapsedMs;
    const duration = elapsedMs !== null ? formatAgentElapsedTime(elapsedMs) : "";
    const color: ThemeColor = worker.state === "failed" ? "error" : worker.state === "recovering" ? "warning" : worker.state === "verifying" ? "muted" : "accent";
    const glyph = worker.state === "running" ? this.getWorkingState().frame : worker.state === "verifying" ? "✓" : worker.state === "recovering" ? "!" : worker.state === "failed" ? "×" : "·";
    const chart = worker.state === "running" ? this.fg(color, "▁▃▅") : worker.state === "recovering" ? this.fg(color, "▅▃▁") : "";
    const attempt = worker.attempt > 0 ? `#${worker.attempt}` : "";
    const rich = [this.fg(color, glyph), this.fg(color, "sub"), this.fg(color, attempt), duration ? this.fg(color, duration) : "", chart].filter(Boolean).join(" ");
    const normal = [this.fg(color, glyph), this.fg(color, "sub"), this.fg(color, attempt), duration ? this.fg(color, duration) : this.fg(color, worker.state)].filter(Boolean).join(" ");
    const compact = [this.fg(color, "sub"), attempt ? this.fg(color, attempt) : "", duration ? this.fg(color, duration) : this.fg(color, worker.state)].filter(Boolean).join(" ");

    if (width >= 96) return rich;
    if (width >= 56) return normal;
    return compact;
  }

  private getGitChangesLabel(): string {
    const git = getGitInfo(this.cwd);
    if (git.changedFiles === 0) return "";

    const fileLabel = this.fg("muted", `${git.changedFiles} ${git.changedFiles === 1 ? "file" : "files"} changed`);
    const added = git.added > 0 ? ` ${this.fg("toolDiffAdded", `+${git.added}`)}` : "";
    const modified = git.modified > 0 ? ` ${this.fg("warning", `~${git.modified}`)}` : "";
    const removed = git.removed > 0 ? ` ${this.fg("toolDiffRemoved", `-${git.removed}`)}` : "";
    return `${fileLabel}${added}${modified}${removed}`;
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

  private wrapPopupBlock(lines: string[], width: number): string[] {
    if (lines.length === 0) return [];

    return lines.map((line) => {
      const clipped = truncateToWidth(line, width, "");
      const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
      return clipped + padding;
    });
  }

  private statusRows(width: number, leftLabel: string, rightLabel: string): string[] {
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

  private borderWithLabels(width: number, leftLabel: string, rightLabel: string): string {
    const innerWidth = Math.max(0, width - 2);
    const maxLeft = Math.max(0, Math.floor(innerWidth * 0.44));
    const maxRight = Math.max(0, innerWidth - maxLeft - 2);
    const left = this.fg("muted", truncateToWidth(leftLabel, maxLeft, "…"));
    const right = truncateToWidth(rightLabel, maxRight, "…");
    const used = visibleWidth(left) + visibleWidth(right);
    const fill = Math.max(0, innerWidth - used);
    return this.borderColor("╭") + left + this.borderColor("─".repeat(fill)) + right + this.borderColor("╮");
  }

  private sideBorder(): string {
    return this.borderColor("│");
  }

  private borderWithRightLabel(width: number, label: string): string {
    const innerWidth = Math.max(0, width - 2);
    const right = this.fg("muted", truncateToWidth(label, Math.max(0, innerWidth - 2), "…"));
    const fill = Math.max(0, innerWidth - visibleWidth(right));
    return this.borderColor("╰") + this.borderColor("─".repeat(fill)) + right + this.borderColor("╯");
  }
}

function isRenderable(value: unknown): value is Renderable {
  return Boolean(value && typeof value === "object" && typeof (value as Renderable).render === "function");
}

function findContainerWithChild(tui: TuiLike | undefined, child: unknown): { container: Renderable; index: number } | undefined {
  const children = Array.isArray(tui?.children) ? tui.children : [];
  const index = children.findIndex((candidate) => Array.isArray((candidate as { children?: unknown[] })?.children)
    && (candidate as { children: unknown[] }).children.includes(child));
  if (index === -1) return undefined;

  const container = children[index];
  return isRenderable(container) ? { container, index } : undefined;
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
  let fixedEditorCompositor: TerminalSplitCompositor | undefined;
  let fixedStatusContainer: Renderable | undefined;
  let fixedEditorContainer: Renderable | undefined;
  let fixedWidgetContainerAbove: Renderable | undefined;
  let fixedWidgetContainerBelow: Renderable | undefined;
  let commandPaletteOpen = false;
  let backgroundWorkerState: BackgroundWorkerState | undefined;
  let isWorking = false;
  let workingMessage = "Waiting for response...";
  let workingFrameIndex = 0;
  let executionStartedAt: number | undefined;
  let completedElapsedMs: number | undefined;
  const subagentTiming: SubagentTimingState = { activeRunIds: new Set() };
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let quotaRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const configFile = getConfigFile();

  const requestRender = () => activeTui?.requestRender();
  const getConfig = () => readDisplayConfig(configFile);
  const getExtensionStatusLabel = () => [...(footerData?.getExtensionStatuses?.().values() ?? [])].filter(Boolean).join(" ");
  const readThinkingLevel = () => {
    try {
      return pi.getThinkingLevel();
    } catch {
      return activeThinkingLevel;
    }
  };
  const hasActiveExecution = () => isWorking || subagentTiming.activeRunIds.size > 0;
  const getElapsedTimeState = (): ElapsedTimeState => {
    if (hasActiveExecution() && executionStartedAt !== undefined) return { active: true, elapsedMs: Date.now() - executionStartedAt };
    return { active: false, elapsedMs: completedElapsedMs };
  };
  const clearCompletedElapsedTime = () => {
    if (isWorking || completedElapsedMs === undefined) return;
    completedElapsedMs = undefined;
    requestRender();
  };
  const getBackgroundWorkerState = () => backgroundWorkerState;

  const teardownFixedEditorCompositor = (resetExtendedKeyboardModes = false) => {
    fixedEditorCompositor?.dispose({ resetExtendedKeyboardModes });
    fixedEditorCompositor = undefined;
    fixedStatusContainer = undefined;
    fixedEditorContainer = undefined;
    fixedWidgetContainerAbove = undefined;
    fixedWidgetContainerBelow = undefined;
  };

  const installFixedEditorCompositor = (ctx: ExtensionContext, tui: TuiLike | undefined) => {
    if (!hasActiveUI(ctx) || !tui?.terminal || typeof (tui.terminal as { write?: unknown }).write !== "function" || !activeEditor) return;

    const editorContainerMatch = findContainerWithChild(tui, activeEditor);
    if (!editorContainerMatch) return;

    const tuiChildren = Array.isArray(tui.children) ? tui.children : [];
    const nextEditorContainer = editorContainerMatch.container;
    const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2];
    const nextStatusContainer = isRenderable(statusContainerCandidate) ? statusContainerCandidate : undefined;
    const aboveWidgetCandidate = tuiChildren[editorContainerMatch.index - 1];
    const nextWidgetContainerAbove = isRenderable(aboveWidgetCandidate) ? aboveWidgetCandidate : undefined;
    const belowWidgetCandidate = tuiChildren[editorContainerMatch.index + 1];
    const nextWidgetContainerBelow = isRenderable(belowWidgetCandidate) ? belowWidgetCandidate : undefined;

    if (
      fixedEditorCompositor &&
      fixedEditorContainer === nextEditorContainer &&
      fixedStatusContainer === nextStatusContainer &&
      fixedWidgetContainerAbove === nextWidgetContainerAbove &&
      fixedWidgetContainerBelow === nextWidgetContainerBelow
    ) {
      fixedEditorCompositor.requestRepaint();
      return;
    }

    teardownFixedEditorCompositor();

    fixedEditorContainer = nextEditorContainer;
    fixedStatusContainer = nextStatusContainer;
    fixedWidgetContainerAbove = nextWidgetContainerAbove;
    fixedWidgetContainerBelow = nextWidgetContainerBelow;

    let compositor: TerminalSplitCompositor;
    compositor = new TerminalSplitCompositor({
      tui,
      terminal: tui.terminal as ConstructorParameters<typeof TerminalSplitCompositor>[0]["terminal"],
      getShowHardwareCursor: () => Boolean(tui.getShowHardwareCursor?.()),
      onCopySelection: (text) => {
        void copyToClipboard(text).catch(() => {});
      },
      renderCluster: (width, terminalRows) => {
        const statusContainerLines = fixedStatusContainer
          ? compositor.renderHidden(fixedStatusContainer, width).filter((line) => visibleWidth(line) > 0)
          : [];
        const aboveWidgetLines = fixedWidgetContainerAbove ? compositor.renderHidden(fixedWidgetContainerAbove, width) : [];
        const editorLines = fixedEditorContainer ? compositor.renderHidden(fixedEditorContainer, width) : [];
        const belowWidgetLines = fixedWidgetContainerBelow ? compositor.renderHidden(fixedWidgetContainerBelow, width) : [];

        return renderFixedEditorCluster({
          width,
          terminalRows,
          statusLines: [...aboveWidgetLines, ...statusContainerLines],
          editorLines,
          secondaryLines: belowWidgetLines,
        });
      },
    });

    fixedEditorCompositor = compositor;
    if (fixedStatusContainer) compositor.hideRenderable(fixedStatusContainer);
    if (fixedWidgetContainerAbove) compositor.hideRenderable(fixedWidgetContainerAbove);
    compositor.hideRenderable(fixedEditorContainer);
    if (fixedWidgetContainerBelow) compositor.hideRenderable(fixedWidgetContainerBelow);
    compositor.install();
    tui.requestRender(true);
  };

  const stopWorkingTimer = () => {
    if (!workingTimer) return;
    clearInterval(workingTimer);
    workingTimer = undefined;
  };

  const startWorkingTimer = () => {
    stopWorkingTimer();
    workingTimer = setInterval(() => {
      workingFrameIndex = (workingFrameIndex + 1) % WORKING_FRAMES.length;
      requestRender();
    }, 160);
  };

  const setWorkingMessage = (message: string, ctx?: ExtensionContext) => {
    workingMessage = message;
    withActiveUI(ctx, (ui) => ui.setWorkingMessage(message));
    requestRender();
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
      if (hasActiveUI(latestCtx)) refreshChatGptQuotaFromSubCore(pi, latestCtx, requestRender, true);
    }, getConfig().chatGptQuotaRefreshMs);
  };

  const openCommandPalette = (initialQuery = "", onSelect: (result: CommandPaletteResult) => void) => {
    const ctx = activeCtx;
    if (!hasActiveUI(ctx) || commandPaletteOpen) return;

    const restoreFixedEditor = () => {
      commandPaletteOpen = false;
      if (fixedEditorCompositor) {
        fixedEditorCompositor.setClusterSuppressed(false);
      } else {
        queueMicrotask(() => installFixedEditorCompositor(ctx, activeTui));
      }
    };

    const showPalette = () => {
      if (!hasActiveUI(ctx)) {
        restoreFixedEditor();
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
          restoreFixedEditor();
          if (!result) return;
          onSelect(result);
        }).catch(() => {
          restoreFixedEditor();
        });
      } catch {
        restoreFixedEditor();
      }
    };

    commandPaletteOpen = true;
    if (!fixedEditorCompositor) installFixedEditorCompositor(ctx, activeTui);
    if (fixedEditorCompositor) {
      fixedEditorCompositor.setClusterSuppressed(true);
      queueMicrotask(showPalette);
    } else {
      showPalette();
    }
  };

  pi.events?.on("sub-core:ready", (payload) => {
    applySubCoreState(activeCtx, (payload as { state?: SubCoreState }).state, requestRender);
  });

  pi.events?.on("sub-core:update-current", (payload) => {
    applySubCoreState(activeCtx, (payload as { state?: SubCoreState }).state, requestRender);
  });

  pi.events?.on("goal-driven:runtime-status", (payload) => {
    const next = normalizeBackgroundWorkerState(payload);
    if (next.action === "ignore") return;
    backgroundWorkerState = next.action === "set" ? next.state : undefined;
    requestRender();
  });

  pi.events?.on("subagent:async-started", (payload) => {
    const id = normalizeSubagentRunId(payload);
    if (!id) return;
    if (executionStartedAt === undefined) {
      executionStartedAt = Date.now();
      completedElapsedMs = undefined;
    }
    subagentTiming.activeRunIds.add(id);
    requestRender();
  });

  pi.events?.on("subagent:async-complete", (payload) => {
    const id = normalizeSubagentRunId(payload);
    if (!id) return;
    if (!subagentTiming.activeRunIds.delete(id)) return;
    if (!hasActiveExecution() && executionStartedAt !== undefined) {
      completedElapsedMs = Date.now() - executionStartedAt;
      executionStartedAt = undefined;
    }
    requestRender();
  });

  pi.on("session_start", (_event, ctx) => {
    if (!hasActiveUI(ctx)) return;

    activeCtx = ctx;
    activeThinkingLevel = readThinkingLevel();
    refreshChatGptQuotaFromSubCore(pi, ctx, requestRender);
    startQuotaRefreshTimer(ctx);

    withActiveUI(ctx, (ui) => {
      ui.setEditorComponent((tui, theme, keybindings) => {
        activeTui = tui;
        const editor = new PiCoderThemeEditor(tui, theme, keybindings, () => activeCtx ?? ctx, () => activeThinkingLevel, getExtensionStatusLabel, () => ({
          active: isWorking,
          message: workingMessage,
          frame: WORKING_FRAMES[workingFrameIndex] ?? WORKING_FRAMES[0],
        }), getElapsedTimeState, getBackgroundWorkerState, clearCompletedElapsedTime, openCommandPalette, getConfig);
        activeEditor = editor;
        seedEditorHistory(editor, ctx);
        queueMicrotask(() => installFixedEditorCompositor(ctx, activeTui));
        return editor;
      });

      hideBuiltInWorking(ctx);

      ui.setFooter((tui: TuiLike, _theme: unknown, data?: FooterData) => {
        activeTui = tui;
        footerData = data;
        queueMicrotask(() => installFixedEditorCompositor(ctx, activeTui));
        return {
          invalidate() {
            requestRender();
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
    if (hasActiveUI(ctx)) requestRender();
  });

  pi.on("model_select", (_event, ctx) => {
    activeCtx = ctx;
    if (hasActiveUI(ctx)) refreshChatGptQuotaFromSubCore(pi, ctx, requestRender, true);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    activeThinkingLevel = readThinkingLevel();
    activeToolExecutions.clear();
    if (executionStartedAt === undefined) executionStartedAt = Date.now();
    isWorking = true;
    completedElapsedMs = undefined;
    workingFrameIndex = 0;
    startWorkingTimer();
    if (!hasActiveUI(ctx)) return;
    hideBuiltInWorking(ctx);
    setWorkingMessage("Waiting for response...", ctx);
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
    stopWorkingTimer();
    requestRender();
  });

  pi.on("session_shutdown", () => {
    executionStartedAt = undefined;
    completedElapsedMs = undefined;
    subagentTiming.activeRunIds.clear();
    backgroundWorkerState = undefined;
    isWorking = false;
    stopWorkingTimer();
    stopQuotaRefreshTimer();
    teardownFixedEditorCompositor(true);
    activeCtx = undefined;
    activeTui = undefined;
    activeEditor = undefined;
    footerData = undefined;
  });
}
