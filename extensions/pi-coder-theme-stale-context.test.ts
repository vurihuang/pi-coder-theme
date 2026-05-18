import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { UserMessageComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import piCoderThemeEditorExtension, { formatAgentElapsedTime, formatChatGptQuota, parseChatGptQuotaSnapshot } from "./pi-coder-theme-editor.js";
import { stripAnsi } from "./pi-coder-theme-command-palette.js";
import piCoderThemeUserMessageExtension from "./pi-coder-theme-user-message.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type ThemeStub = {
  borderColor(text: string): string;
  fg(color: string, text: string): string;
  italic?(text: string): string;
};

function expectDefined<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();
  return value as T;
}

function createPiStub(getThinkingLevel: () => string) {
  const handlers = new Map<string, EventHandler>();
  const eventHandlers = new Map<string, (payload: unknown) => void>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        eventHandlers.set(event, handler);
      },
      emit(event: string, payload: unknown) {
        emittedEvents.push({ event, payload });
        eventHandlers.get(event)?.(payload);
      },
    },
    getThinkingLevel,
  } as unknown as ExtensionAPI;

  return { pi, handlers, eventHandlers, emittedEvents };
}

function createThemeStub(): ThemeStub {
  return {
    borderColor(text: string) {
      return text;
    },
    fg(_color: string, text: string) {
      return text;
    },
    italic(text: string) {
      return text;
    },
  };
}

function createTaggedThemeStub(): ThemeStub {
  return {
    borderColor(text: string) {
      return text;
    },
    fg(color: string, text: string) {
      return `[${color}]${text}`;
    },
    italic(text: string) {
      return text;
    },
  };
}

function createSessionManager(thinkingLevel = "medium") {
  const entries = [
    {
      type: "thinking_level_change",
      id: "thinking-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    },
  ];

  return {
    getEntries() {
      return entries;
    },
    getLeafId() {
      return "thinking-1";
    },
    getSessionName() {
      return undefined;
    },
  };
}

function createSessionManagerWithoutThinking() {
  return {
    getEntries() {
      return [];
    },
    getLeafId() {
      return undefined;
    },
    getSessionName() {
      return undefined;
    },
  };
}

function createSessionManagerWithCost(cost: number) {
  return createSessionManagerWithUsage({ cost: { total: cost } });
}

function createSessionManagerWithUsage(usage: Record<string, unknown>) {
  const entries = [
    {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        usage,
      },
    },
  ];

  return {
    getEntries() {
      return entries;
    },
    getLeafId() {
      return "assistant-1";
    },
    getSessionName() {
      return undefined;
    },
  };
}

async function waitForCondition(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 20; index++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

function chatGptUsagePayload(primaryWindow: unknown, secondaryWindow?: unknown): unknown {
  return {
    rate_limit: {
      primary_window: primaryWindow,
      secondary_window: secondaryWindow,
    },
  };
}

function resetUserMessagePatch(): void {
  const prototype = UserMessageComponent.prototype as unknown as {
    render: UserMessageComponent["render"];
    __piCoderThemeUserMessageOriginalRender?: UserMessageComponent["render"];
    __piCoderThemeUserMessagePatched?: boolean;
    __piCoderThemeUserMessageGetTheme?: () => unknown;
    __piCoderThemeUserMessageGetThinkingLevel?: () => string;
  };

  if (prototype.__piCoderThemeUserMessageOriginalRender) {
    prototype.render = prototype.__piCoderThemeUserMessageOriginalRender;
  }

  delete prototype.__piCoderThemeUserMessageOriginalRender;
  delete prototype.__piCoderThemeUserMessagePatched;
  delete prototype.__piCoderThemeUserMessageGetTheme;
  delete prototype.__piCoderThemeUserMessageGetThinkingLevel;
}

test("chatgpt quota formatter renders 5-hour and weekly remaining quota", () => {
  const snapshot = parseChatGptQuotaSnapshot(chatGptUsagePayload(
    { used_percent: 24.4, limit_window_seconds: 18000 },
    { used_percent: 72.6, limit_window_seconds: 604800 },
  ));

  expect(formatChatGptQuota(snapshot)).toBe("5h 76% / W 27%");
});

test("chatgpt quota formatter omits missing windows", () => {
  const snapshot = parseChatGptQuotaSnapshot(chatGptUsagePayload(
    { used_percent: 41, limit_window_seconds: 604800 },
  ));

  expect(formatChatGptQuota(snapshot)).toBe("W 59%");
});

test("chatgpt quota formatter clamps percentages", () => {
  const snapshot = parseChatGptQuotaSnapshot(chatGptUsagePayload(
    { used_percent: -10, limit_window_seconds: 18000 },
    { used_percent: 130, limit_window_seconds: 604800 },
  ));

  expect(formatChatGptQuota(snapshot)).toBe("5h 100% / W 0%");
});

test.each([
  [5_900, "5s"],
  [60_000, "1m"],
  [130_000, "2m10s"],
  [3_600_000, "1h"],
  [5_400_000, "1h30m"],
  [-1, "0s"],
  [Number.NaN, "0s"],
] satisfies Array<[number, string]>)
("agent elapsed time formatter renders compact readable duration for %s", (elapsedMs, expected) => {
  expect(formatAgentElapsedTime(elapsedMs)).toBe(expected);
});

test("chatgpt quota parser ignores malformed and unknown windows", () => {
  expect(parseChatGptQuotaSnapshot({})).toBeUndefined();
  expect(formatChatGptQuota(parseChatGptQuotaSnapshot(chatGptUsagePayload(
    { used_percent: 12, limit_window_seconds: 60 },
  )))).toBeUndefined();
});

test("pi-coder-theme editor renders chatgpt quota from sub-core updates", async () => {
  let intervalCallback: (() => void) | undefined;
  let intervalMs: number | undefined;
  const setIntervalMock = vi.spyOn(globalThis, "setInterval").mockImplementation((callback: TimerHandler, timeout?: number) => {
    intervalCallback = callback as () => void;
    intervalMs = timeout;
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalMock = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
  const { pi, handlers, eventHandlers } = createPiStub(() => "medium");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("theme should not fetch quota directly"));

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: { id: "gpt-5-codex", provider: "openai-codex", contextWindow: 200000 },
      modelRegistry: { isUsingOAuth: () => true },
      sessionManager: createSessionManagerWithCost(0),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  expectDefined(intervalCallback, "quota interval should be registered");
  expect(intervalMs).toBe(5 * 60 * 1000);

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor({ requestRender() {}, terminal: { rows: 24 } }, createThemeStub(), { matches: () => false });

  eventHandlers.get("sub-core:update-current")?.({
    state: {
      provider: "codex",
      usage: {
        provider: "codex",
        windows: [
          { label: "5h", usedPercent: 12 },
          { label: "Week", usedPercent: 34 },
        ],
      },
    },
  });

  expect(editor.render(200).join("\n")).toMatch(/\$0\.000 sub · 5h 88% \/ W 66%/);
  expect(fetchMock).not.toHaveBeenCalled();

  const sessionShutdown = expectDefined(handlers.get("session_shutdown"), "session_shutdown handler should be registered");
  sessionShutdown({ type: "session_shutdown" }, {} as ExtensionContext);
  fetchMock.mockRestore();
  setIntervalMock.mockRestore();
  clearIntervalMock.mockRestore();
});

test("pi-coder-theme editor hides sub-core quota for api-key sessions", async () => {
  const setIntervalMock = vi.spyOn(globalThis, "setInterval").mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  const clearIntervalMock = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
  const { pi, handlers, eventHandlers } = createPiStub(() => "medium");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("theme should not fetch quota directly"));

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: { id: "gpt-5-codex", provider: "openai-codex", contextWindow: 200000 },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManagerWithCost(0),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor({ requestRender() {}, terminal: { rows: 24 } }, createThemeStub(), { matches: () => false });

  eventHandlers.get("sub-core:update-current")?.({
    state: {
      provider: "codex",
      usage: {
        provider: "codex",
        windows: [
          { label: "5h", usedPercent: 9 },
          { label: "Week", usedPercent: 18 },
        ],
      },
    },
  });

  const rendered = editor.render(200).join("\n");
  expect(rendered).not.toMatch(/5h 91% \/ W 82%/);
  expect(fetchMock).not.toHaveBeenCalled();

  const sessionShutdown = expectDefined(handlers.get("session_shutdown"), "session_shutdown handler should be registered");
  sessionShutdown({ type: "session_shutdown" }, {} as ExtensionContext);
  fetchMock.mockRestore();
  setIntervalMock.mockRestore();
  clearIntervalMock.mockRestore();
});

test("pi-coder-theme user message render stays safe after session manager becomes stale", () => {
  resetUserMessagePatch();

  let stale = false;
  const sessionManager = createSessionManager();
  const staleAwareSessionManager = {
    ...sessionManager,
    getEntries() {
      if (stale) throw new Error("stale session manager");
      return sessionManager.getEntries();
    },
    getLeafId() {
      if (stale) throw new Error("stale session manager");
      return sessionManager.getLeafId();
    },
  };

  const { pi, handlers } = createPiStub(() => "medium");

  piCoderThemeUserMessageExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      sessionManager: staleAwareSessionManager,
      ui: { theme: createThemeStub() },
    } as unknown as ExtensionContext,
  );

  const message = new UserMessageComponent("hello from pi-coder-theme");
  expect(() => message.render(48)).not.toThrow();

  stale = true;
  expect(() => message.render(48)).not.toThrow();

  resetUserMessagePatch();
});

test("pi-coder-theme editor working message waits until assistant update before streaming", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const workingMessages: Array<string | undefined> = [];

  piCoderThemeEditorExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: createSessionManager(),
    getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
    ui: {
      theme: createThemeStub(),
      setEditorComponent() {},
      setWorkingIndicator() {},
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
      setFooter() {},
    },
  } as unknown as ExtensionContext;

  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  expect(workingMessages).toEqual([]);

  const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
  beforeAgentStart({ type: "before_agent_start" }, ctx);
  expect(workingMessages.at(-1)).toBe("Waiting for response...");

  const messageStart = handlers.get("message_start");
  messageStart?.({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  expect(workingMessages.at(-1)).toBe("Waiting for response...");

  const messageUpdate = expectDefined(handlers.get("message_update"), "message_update handler should be registered");
  messageUpdate(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    },
    ctx,
  );
  expect(workingMessages.at(-1)).toBe("Streaming response...");
});

test("pi-coder-theme editor shows running tools while tool execution is active", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const workingMessages: Array<string | undefined> = [];

  piCoderThemeEditorExtension(pi);

  const toolExecutionStart = expectDefined(handlers.get("tool_execution_start"), "tool_execution_start handler should be registered");

  toolExecutionStart(
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} },
    {
      hasUI: true,
      ui: {
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
      },
    } as unknown as ExtensionContext,
  );

  expect(workingMessages.at(-1)).toBe("Running tools...");
});

test("pi-coder-theme editor hides Pi's built-in working row during agent start", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const visibility: boolean[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: createSessionManager(),
    getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
    ui: {
      theme: createThemeStub(),
      setEditorComponent() {},
      setWorkingIndicator() {},
      setWorkingMessage() {},
      setWorkingVisible(visible: boolean) {
        visibility.push(visible);
      },
      setFooter() {},
    },
  } as unknown as ExtensionContext;

  piCoderThemeEditorExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
  const agentStart = expectDefined(handlers.get("agent_start"), "agent_start handler should be registered");

  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  beforeAgentStart({ type: "before_agent_start" }, ctx);
  agentStart({ type: "agent_start" }, ctx);

  expect(visibility).toEqual([false, false, false]);
});

test("pi-coder-theme editor keeps working message ordered while tools are active", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const workingMessages: Array<string | undefined> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
    },
  } as unknown as ExtensionContext;

  piCoderThemeEditorExtension(pi);

  const messageUpdate = expectDefined(handlers.get("message_update"), "message_update handler should be registered");
  const toolExecutionStart = expectDefined(handlers.get("tool_execution_start"), "tool_execution_start handler should be registered");
  const toolExecutionEnd = expectDefined(handlers.get("tool_execution_end"), "tool_execution_end handler should be registered");

  messageUpdate({ type: "message_update", message: { role: "assistant", content: [] } }, ctx);
  expect(workingMessages).toEqual(["Streaming response..."]);

  toolExecutionStart({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} }, ctx);
  expect(workingMessages).toEqual(["Streaming response...", "Running tools..."]);

  messageUpdate({ type: "message_update", message: { role: "assistant", content: [] } }, ctx);
  expect(workingMessages).toEqual(["Streaming response...", "Running tools..."]);

  toolExecutionEnd({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false }, ctx);
  expect(workingMessages).toEqual(["Streaming response...", "Running tools...", "Waiting for response..."]);

  const agentEnd = expectDefined(handlers.get("agent_end"), "agent_end handler should be registered");
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  expect(workingMessages).toEqual(["Streaming response...", "Running tools...", "Waiting for response..."]);
});

test("pi-coder-theme editor renders elapsed task time while active and after completion", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));

  try {
    const { pi, handlers } = createPiStub(() => "medium");

    piCoderThemeEditorExtension(pi);

    let editorFactory:
      | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[]; handleInput(data: string): void; getText(): string })
      | undefined;
    let renderRequests = 0;
    const ctx = {
      hasUI: true,
      cwd: "/tmp",
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setWorkingVisible() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext;

    const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
    sessionStart({ type: "session_start", reason: "startup" }, ctx);

    const createEditor = expectDefined(editorFactory, "editor factory should be registered");
    const editor = createEditor(
      { requestRender() { renderRequests += 1; }, terminal: { rows: 24 } },
      createThemeStub(),
      { matches: () => false },
    );

    const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
    beforeAgentStart({ type: "before_agent_start" }, ctx);
    vi.setSystemTime(new Date("2026-05-18T00:02:10.000Z"));

    expect(stripAnsi(editor.render(200).join("\n"))).toContain("⏱ 2m10s");
    expect(stripAnsi(editor.render(200).join("\n"))).toContain("Waiting for response...");

    const agentEnd = expectDefined(handlers.get("agent_end"), "agent_end handler should be registered");
    agentEnd({ type: "agent_end", messages: [] }, ctx);
    vi.setSystemTime(new Date("2026-05-18T00:03:00.000Z"));

    const completedRender = stripAnsi(editor.render(200).join("\n"));
    expect(completedRender).toContain("⏱ 2m10s");
    expect(completedRender).not.toContain("Waiting for response...");

    editor.handleInput("h");
    expect(stripAnsi(editor.render(200).join("\n"))).not.toContain("⏱ 2m10s");
    expect(renderRequests).toBeGreaterThan(0);
  } finally {
    vi.useRealTimers();
  }
});

test("pi-coder-theme editor keeps completed elapsed time when opening the command palette without selection", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));

  try {
    const { pi, handlers } = createPiStub(() => "medium");

    piCoderThemeEditorExtension(pi);

    let editorFactory:
      | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[]; handleInput(data: string): void })
      | undefined;
    const ctx = {
      hasUI: true,
      cwd: "/tmp",
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        custom: () => Promise.resolve(null),
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setWorkingVisible() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext;

    expectDefined(handlers.get("session_start"), "session_start handler should be registered")({ type: "session_start", reason: "startup" }, ctx);
    const editor = expectDefined(editorFactory, "editor factory should be registered")(
      { requestRender() {}, terminal: { rows: 24 } },
      createThemeStub(),
      { matches: () => false },
    );

    expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered")({ type: "before_agent_start" }, ctx);
    vi.setSystemTime(new Date("2026-05-18T00:00:05.000Z"));
    expectDefined(handlers.get("agent_end"), "agent_end handler should be registered")({ type: "agent_end", messages: [] }, ctx);

    editor.handleInput("/");
    await Promise.resolve();

    expect(stripAnsi(editor.render(200).join("\n"))).toContain("⏱ 5s");
  } finally {
    vi.useRealTimers();
  }
});

test("pi-coder-theme editor renders working status with an Esc cancel hint", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: createSessionManager(),
    getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
    ui: {
      theme: createTaggedThemeStub(),
      setEditorComponent(factory: typeof editorFactory) {
        editorFactory = factory;
      },
      setWorkingIndicator() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setFooter() {},
    },
  } as unknown as ExtensionContext;

  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
  beforeAgentStart({ type: "before_agent_start" }, ctx);

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createTaggedThemeStub(),
    { matches: () => false },
  );

  expect(editor.render(200).join("\n")).toContain("[accent]Esc[muted] to cancel");
});

test("pi-coder-theme editor renders extension statuses next to the thinking level", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;
  let footerFactory:
    | ((tui: unknown, theme: ThemeStub, footerData: { getExtensionStatuses(): Map<string, string> }) => { render(): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createTaggedThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter(factory: typeof footerFactory) {
          footerFactory = factory;
        },
      },
    } as unknown as ExtensionContext,
  );

  const statuses = new Map<string, string>();
  const createFooter = expectDefined(footerFactory, "footer factory should be registered");
  createFooter(
    { requestRender() {}, terminal: { rows: 24 } },
    createTaggedThemeStub(),
    { getExtensionStatuses: () => statuses },
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createTaggedThemeStub(),
    { matches: () => false },
  );

  statuses.set("fast-mode", "⚡ fast");

  expect(editor.render(200).join("\n")).toMatch(/\[thinkingMedium\]medium  \[accent\]⚡ fast/);
});

test("pi-coder-theme editor applies the theme text color to typed input", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[]; setText(text: string): void })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createTaggedThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createTaggedThemeStub(),
    { matches: () => false },
  );
  editor.setText("为啥老是报错？");

  expect(editor.render(100).join("\n")).toContain("[text] 为啥老是报错？");
});

test("pi-coder-theme editor hides token usage disabled in config", async () => {
  const originalHome = process.env.HOME;
  const homeDir = await mkdtemp(join(tmpdir(), "pi-coder-theme-config-test-"));
  process.env.HOME = homeDir;
  const configDir = join(homeDir, ".pi", "agent", "extensions", "pi-coder-themes");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ display: { tokenUsage: false } }));

  const { pi, handlers } = createPiStub(() => "medium");
  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: { id: "claude-sonnet-4-20250514", contextWindow: 200000, reasoning: true },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManagerWithUsage({ input: 1200, output: 3400, cacheRead: 5600, cacheWrite: 7800 }),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor({ requestRender() {}, terminal: { rows: 24 } }, createThemeStub(), { matches: () => false });
  const rendered = editor.render(100).join("\n");

  expect(rendered).toMatch(/12%\/200k/);
  expect(rendered).not.toContain("↑");
  expect(rendered).not.toContain("↓");
  expect(rendered).not.toContain("R6k");
  expect(rendered).not.toContain("W8k");

  process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

test("pi-coder-theme editor uses latest context and cost after reload", () => {
  const { pi, handlers } = createPiStub(() => "high");

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  const createCtx = (percent: number, cost: number) => ({
    hasUI: true,
    cwd: process.cwd(),
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 272000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => true },
    sessionManager: createSessionManagerWithCost(cost),
    getContextUsage: () => ({ percent, contextWindow: 272000 }),
    ui: {
      theme: createThemeStub(),
      setEditorComponent(factory: typeof editorFactory) {
        editorFactory = factory;
      },
      setWorkingIndicator() {},
      setWorkingMessage() {},
      setFooter() {},
    },
  }) as unknown as ExtensionContext;

  sessionStart({ type: "session_start", reason: "startup" }, createCtx(12, 1.23));
  const createEditor = expectDefined(editorFactory, "editor factory should be registered");

  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );

  expect(editor.render(100).join("\n")).toMatch(/12%\/272k · \$1\.23 sub/);

  sessionStart({ type: "session_start", reason: "reload" }, createCtx(72, 16.37));

  expect(editor.render(100).join("\n")).toMatch(/72%\/272k · \$16\.37 sub/);
});

test("pi-coder-theme editor border follows the runtime border color function", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[]; borderColor?: (text: string) => string })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );

  editor.borderColor = (text: string) => `[border]${text}`;

  expect(editor.render(80).join("\n")).toContain("[border]╭");
});

test("pi-coder-theme editor uses runtime thinking level after resume when session has no thinking entry", () => {
  const { pi, handlers } = createPiStub(() => "high");

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "resume" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManagerWithoutThinking(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");

  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );

  expect(editor.render(80).join("\n")).toMatch(/ high /);
});

test("pi-coder-theme user message follows thinking_level_select changes after session start", () => {
  resetUserMessagePatch();

  let thinkingLevel = "off";
  const { pi, handlers } = createPiStub(() => thinkingLevel);

  piCoderThemeUserMessageExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  thinkingLevel = "medium";
  const thinkingLevelSelect = expectDefined(handlers.get("thinking_level_select"), "thinking_level_select handler should be registered");
  thinkingLevelSelect({ level: "medium", previousLevel: "off" }, {} as ExtensionContext);

  const message = new UserMessageComponent("hello from pi-coder-theme");
  expect(message.render(48).join("\n")).toMatch(/\[thinkingMedium\]▌/);

  resetUserMessagePatch();
});

test("pi-coder-theme user message uses runtime thinking level after resume when session has no thinking entry", () => {
  resetUserMessagePatch();

  const { pi, handlers } = createPiStub(() => "high");

  piCoderThemeUserMessageExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "resume" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  const message = new UserMessageComponent("hello from pi-coder-theme");
  expect(message.render(48).join("\n")).toMatch(/\[thinkingHigh\]▌/);

  resetUserMessagePatch();
});

test("pi-coder-theme user message refreshes prototype state after extension reload", () => {
  resetUserMessagePatch();

  let firstThinkingLevel = "low";
  const first = createPiStub(() => firstThinkingLevel);
  piCoderThemeUserMessageExtension(first.pi);

  const firstSessionStart = expectDefined(first.handlers.get("session_start"), "first session_start handler should be registered");
  firstSessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[first:${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  const beforeReload = new UserMessageComponent("hello from pi-coder-theme");
  expect(beforeReload.render(48).join("\n")).toMatch(/\[first:thinkingLow\]▌/);

  const second = createPiStub(() => "high");
  piCoderThemeUserMessageExtension(second.pi);

  const secondSessionStart = expectDefined(second.handlers.get("session_start"), "second session_start handler should be registered");
  secondSessionStart(
    { type: "session_start", reason: "reload" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[second:${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  firstThinkingLevel = "minimal";

  const afterReload = new UserMessageComponent("hello from pi-coder-theme");
  const rendered = afterReload.render(48).join("\n");
  expect(rendered).toMatch(/\[second:thinkingHigh\]▌/);
  expect(rendered).not.toMatch(/\[first:thinkingMinimal\]▌/);

  resetUserMessagePatch();
});

test("pi-coder-theme editor render stays safe after pi runtime becomes stale", () => {
  let stale = false;
  const { pi, handlers } = createPiStub(() => {
    if (stale) throw new Error("stale runtime");
    return "medium";
  });

  piCoderThemeEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const theme = createTaggedThemeStub();
  const editorTheme = {
    borderColor(text: string) {
      return text;
    },
  } as ThemeStub;
  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme,
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");

  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    editorTheme,
    { matches: () => false },
  );

  expect(editor.render(80).join("\n")).toContain("[text]claude-sonnet-4-20250514");

  stale = true;
  expect(() => editor.render(80)).not.toThrow();
});
