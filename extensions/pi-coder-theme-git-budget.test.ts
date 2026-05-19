import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type ThemeStub = {
  borderColor(text: string): string;
  fg(color: string, text: string): string;
};

function expectDefined<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();
  return value as T;
}

function createPiStub() {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    events: {
      on() {},
      emit() {},
    },
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

function createThemeStub(): ThemeStub {
  return {
    borderColor(text: string) {
      return text;
    },
    fg(_color: string, text: string) {
      return text;
    },
  };
}

function createSessionManager() {
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

test("workspace Git commands share the overall aggregation timeout budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-coder-git-budget-"));
  try {
    await mkdir(join(workspace, "repo-a"));
    await mkdir(join(workspace, "repo-b"));

    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { default: piCoderThemeEditorExtension } = await import("./pi-coder-theme-editor.js");
    const timeouts: number[] = [];

    execFileSyncMock.mockImplementation((_command: string, args: string[], options: { cwd: string; timeout: number }) => {
      timeouts.push(options.timeout);
      now += 125;

      if (args[0] === "rev-parse") return options.cwd === workspace ? "false" : "true";
      if (args[0] === "status") return " M tracked.txt";
      if (args[0] === "diff") return "1\t1\ttracked.txt";
      return "";
    });

    const { pi, handlers } = createPiStub();
    piCoderThemeEditorExtension(pi);

    let editorFactory:
      | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
      | undefined;

    expectDefined(handlers.get("session_start"), "session_start handler should be registered")(
      { type: "session_start", reason: "startup" },
      {
        hasUI: true,
        cwd: workspace,
        model: { id: "claude-sonnet-4-20250514", contextWindow: 200000, reasoning: true },
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

    const editor = expectDefined(editorFactory, "editor factory should be registered")(
      { requestRender() {}, terminal: { rows: 24 } },
      createThemeStub(),
      { matches: () => false },
    );

    editor.render(200);

    expect(timeouts).toEqual([500, 225, 100]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
    nowSpy.mockRestore();
  } finally {
    execFileSyncMock.mockReset();
    await rm(workspace, { recursive: true, force: true });
  }
});
