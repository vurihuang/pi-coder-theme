import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import piCoderThemeEditorExtension from "./pi-coder-theme-editor.js";
import { CommandPaletteOverlay, stripAnsi, type CommandPaletteItem, type CommandPaletteResult } from "./pi-coder-theme-command-palette.js";

type ThemeStub = {
  borderColor(text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type PiCoderThemeEditorLike = {
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  render(width: number): string[];
  setAutocompleteProvider(provider: unknown): void;
  onSubmit?: (text: string) => void;
};

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

function createThemeStub(): ThemeStub {
  return {
    borderColor(text: string) {
      return text;
    },
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

function createOverlay(items: CommandPaletteItem[], initialQuery = ""): CommandPaletteOverlay {
  return new CommandPaletteOverlay(
    items,
    initialQuery,
    { requestRender() {} } as never,
    createThemeStub() as never,
    { matches: () => false } as never,
    () => {},
  );
}

function createPaletteKeybindings() {
  return {
    matches(data: string, action: string) {
      return (data === "tab" && action === "tui.input.tab") || (data === "enter" && action === "tui.select.confirm");
    },
  };
}

function pickPaletteItem(
  item: CommandPaletteItem,
  key: "tab" | "enter" | "\r",
  keybindings: { matches(data: string, action: string): boolean } = createPaletteKeybindings(),
): CommandPaletteResult | null | undefined {
  let result: CommandPaletteResult | null | undefined;
  new CommandPaletteOverlay([item], "", { requestRender() {} } as never, createThemeStub() as never, keybindings as never, (value) => {
    result = value;
  }).handleInput(key);
  return result;
}

function createPiCoderThemeEditor(
  paletteResult: CommandPaletteResult,
  entries: SessionEntry[] = [],
  options: { sessionDir?: string; sessionFile?: string; requestRender?: () => void } = {},
): PiCoderThemeEditorLike {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      handlers.set(event, handler);
    },
    getThinkingLevel: () => "medium",
    getCommands: () => [],
  };

  piCoderThemeEditorExtension(pi as never);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(data: string, action: string): boolean }) => PiCoderThemeEditorLike)
    | undefined;

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();

  sessionStart?.(
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
      sessionManager: {
        getEntries: () => entries,
        getLeafId: () => undefined,
        getSessionName: () => undefined,
        getSessionDir: () => options.sessionDir,
        getSessionFile: () => options.sessionFile,
      },
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        custom: () => Promise.resolve(paletteResult),
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setWorkingVisible() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  expect(editorFactory).toBeDefined();
  return editorFactory!(
    { requestRender: options.requestRender ?? (() => {}), terminal: { rows: 24 } },
    createThemeStub(),
    {
      matches(data: string, action: string) {
        return (matchesKey(data, "up") && action === "tui.editor.cursorUp") || (matchesKey(data, "tab") && action === "tui.input.tab");
      },
    },
  );
}

test("editor requests repaint for cursor movement inputs that do not change text", () => {
  let renderRequests = 0;
  const editor = createPiCoderThemeEditor(
    { command: "compact", action: "insert" },
    [],
    { requestRender: () => { renderRequests += 1; } },
  );

  editor.handleInput("a");
  editor.handleInput("b");
  renderRequests = 0;

  editor.handleInput("\x02");

  expect(editor.getText()).toBe("ab");
  expect(renderRequests).toBe(1);
});

test("editor schedules follow-up repaints for inputs that may update text asynchronously", () => {
  vi.useFakeTimers();
  try {
    let renderRequests = 0;
    const editor = createPiCoderThemeEditor(
      { command: "compact", action: "insert" },
      [],
      { requestRender: () => { renderRequests += 1; } },
    );

    editor.handleInput("\x16");

    expect(renderRequests).toBe(1);
    vi.advanceTimersByTime(600);
    expect(renderRequests).toBeGreaterThanOrEqual(4);
  } finally {
    vi.useRealTimers();
  }
});

test("async autocomplete results request a fixed editor repaint", async () => {
  let renderRequests = 0;
  let resolveSuggestions: ((value: unknown) => void) | undefined;
  const editor = createPiCoderThemeEditor(
    { command: "compact", action: "insert" },
    [],
    { requestRender: () => { renderRequests += 1; } },
  );
  editor.setAutocompleteProvider({
    getSuggestions: vi.fn(() => new Promise((resolve) => { resolveSuggestions = resolve; })),
    shouldTriggerFileCompletion: () => true,
  });
  editor.setText("@docs/plans/");

  editor.handleInput("\t");
  await Promise.resolve();
  renderRequests = 0;
  resolveSuggestions?.({
    prefix: "@docs/plans/",
    items: [
      { value: "@docs/plans/a.md", label: "a.md" },
      { value: "@docs/plans/b.md", label: "b.md" },
    ],
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(renderRequests).toBeGreaterThan(0);
});

test("command palette renders multiline descriptions as one terminal row", () => {
  const overlay = createOverlay([
    {
      name: "skill:pi-subagents",
      source: "skill",
      description: "Delegate work.\nContinue safely.",
    },
  ]);

  const rendered = overlay.render(96).map(stripAnsi);

  expect(rendered.every((line) => !/[\r\n]/.test(line))).toBe(true);
  expect(rendered.join("\n")).toContain("Delegate work. Continue safely.");
});

test.each([
  [{ name: "settings", source: "builtin" }, "submit"],
  [{ name: "btw:new", source: "extension" }, "insert"],
  [{ name: "skill:pi-subagents", source: "skill" }, "insert"],
  [{ name: "component", source: "prompt" }, "insert"],
] satisfies Array<[CommandPaletteItem, CommandPaletteResult["action"]]>)
("command palette enter action follows command source for %s", (item, expectedAction) => {
  expect(pickPaletteItem(item, "enter")).toEqual({ command: item.name, action: expectedAction });
});

test("command palette enter also confirms through the native input submit binding", () => {
  const keybindings = {
    matches(data: string, action: string) {
      return data === "\r" && action === "tui.input.submit";
    },
  };

  expect(pickPaletteItem({ name: "goal", source: "extension" }, "\r", keybindings)).toEqual({ command: "goal", action: "insert" });
});

test.each([
  { name: "settings", source: "builtin" },
  { name: "btw:new", source: "extension" },
  { name: "skill:pi-subagents", source: "skill" },
  { name: "component", source: "prompt" },
] satisfies CommandPaletteItem[])("command palette tab always inserts %s", (item) => {
  expect(pickPaletteItem(item, "tab")).toEqual({ command: item.name, action: "insert" });
});

test("submitting a command from the palette uses the native editor submit path", async () => {
  const editor = createPiCoderThemeEditor({ command: "compact", action: "submit" });
  const onSubmit = vi.fn();
  editor.onSubmit = onSubmit;

  editor.handleInput("/");
  await Promise.resolve();

  expect(onSubmit).toHaveBeenCalledWith("/compact");
  expect(editor.getText()).toBe("");
});

test("pressing enter on an extension command from the palette inserts it for arguments", async () => {
  const editor = createPiCoderThemeEditor({ command: "goal", action: "insert" });
  const onSubmit = vi.fn();
  editor.onSubmit = onSubmit;

  editor.handleInput("/");
  await Promise.resolve();

  expect(onSubmit).not.toHaveBeenCalled();
  expect(editor.getText()).toBe("/goal ");
});

test("inserting a command from the palette leaves it editable without submitting", async () => {
  let renderRequests = 0;
  const editor = createPiCoderThemeEditor(
    { command: "compact", action: "insert" },
    [],
    { requestRender: () => { renderRequests += 1; } },
  );
  const onSubmit = vi.fn();
  editor.onSubmit = onSubmit;

  editor.handleInput("/");
  await Promise.resolve();

  expect(onSubmit).not.toHaveBeenCalled();
  expect(editor.getText()).toBe("/compact ");
  expect(renderRequests).toBeGreaterThan(0);
});

test("pi-coder-theme editor restores previous user messages into input history", () => {
  const editor = createPiCoderThemeEditor({ command: "compact", action: "insert" }, [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "first prompt" }],
      },
    } as SessionEntry,
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "assistant response" }],
      },
    } as SessionEntry,
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "latest prompt" }],
      },
    } as SessionEntry,
  ]);

  editor.handleInput("\x1b[A");

  expect(editor.getText()).toBe("latest prompt");
});

test("pi-coder-theme editor restores input history when starting an empty new session", () => {
  const sessionDir = mkdtempSync(`${tmpdir()}/pi-coder-theme-history-test-`);

  try {
    writeFileSync(join(sessionDir, "2026-01-01T00-00-00_old.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "old", cwd: process.cwd() }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "old prompt" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant response" }] } }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "newest previous prompt" }] } }),
      "",
    ].join("\n"));

    const currentSessionFile = join(sessionDir, "2026-01-02T00-00-00_current.jsonl");
    writeFileSync(currentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "current", cwd: process.cwd() })}\n`);

    const editor = createPiCoderThemeEditor(
      { command: "compact", action: "insert" },
      [],
      { sessionDir, sessionFile: currentSessionFile },
    );

    editor.handleInput("\x1b[A");

    expect(editor.getText()).toBe("newest previous prompt");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("pi-coder-theme editor shows compact context and token usage", async () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(`${tmpdir()}/pi-coder-theme-command-test-`);
  process.env.HOME = homeDir;

  try {
    const editor = createPiCoderThemeEditor({ command: "compact", action: "insert" }, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "assistant response" }],
          usage: {
            input: 1234,
            output: 2345,
            cacheRead: 3456,
            cacheWrite: 456,
            cost: { total: 0 },
          },
        },
      } as SessionEntry,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rendered = editor.render(100).map(stripAnsi).join("\n");

    expect(rendered).toContain("12%/200k");
    expect(rendered).toContain("↑1k ↓2k R3k W456");
  } finally {
    process.env.HOME = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
