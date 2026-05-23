import { afterEach, describe, expect, test, vi } from "vitest";

const internalPatch = vi.hoisted(() => ({
  retainThinkingStepsPatch: vi.fn(() => vi.fn()),
  resetCompactLineTracker: vi.fn(),
}));

vi.mock("./internal-patch.js", () => internalPatch);

import piCoderThemeThinkingSteps, { applyThinkingMessageUpdate } from "./index.js";
import { getActiveThinkingState, resetThinkingStepsStateForTests, setActiveThinkingState } from "./state.js";

type Handler = (event: unknown, ctx: unknown) => void;

type FakePi = {
  handlers: Map<string, Handler>;
  on(eventName: string, handler: Handler): void;
};

afterEach(() => {
  resetThinkingStepsStateForTests();
  internalPatch.retainThinkingStepsPatch.mockReset();
  internalPatch.retainThinkingStepsPatch.mockImplementation(() => vi.fn());
  internalPatch.resetCompactLineTracker.mockReset();
});

function createFakePi(): FakePi {
  return {
    handlers: new Map(),
    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    },
  };
}

function createContext() {
  return {
    hasUI: true,
    ui: {
      theme: {},
      notify: vi.fn(),
      requestRender: vi.fn(),
    },
  };
}

describe("applyThinkingMessageUpdate", () => {
  test("thinking_delta sets active thinking state with content index", () => {
    applyThinkingMessageUpdate({ assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });

    expect(getActiveThinkingState()).toEqual({ active: true, contentIndex: 0 });
  });

  test("thinking_end clears active thinking state", () => {
    setActiveThinkingState({ active: true, contentIndex: 0 });

    applyThinkingMessageUpdate({ assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } });

    expect(getActiveThinkingState()).toEqual({ active: false });
  });

  test("text_delta clears active state even when retained message content still includes thinking", () => {
    setActiveThinkingState({ active: true, contentIndex: 0 });

    applyThinkingMessageUpdate({
      assistantMessageEvent: { type: "text_delta", contentIndex: 1 },
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Earlier reasoning" },
          { type: "text", text: "Streaming answer" },
        ],
      },
    });

    expect(getActiveThinkingState()).toEqual({ active: false });
  });

  test("missing or unrecognized assistant message event is ignored", () => {
    setActiveThinkingState({ active: true, contentIndex: 2 });

    expect(() => applyThinkingMessageUpdate({ message: { role: "assistant", content: [{ type: "thinking" }] } })).not.toThrow();
    expect(() => applyThinkingMessageUpdate({ assistantMessageEvent: { type: "unknown_event", contentIndex: 0 } })).not.toThrow();

    expect(getActiveThinkingState()).toEqual({ active: true, contentIndex: 2 });
  });
});

describe("piCoderThemeThinkingSteps", () => {
  test("message_update thinking_delta updates state without requesting render", () => {
    const pi = createFakePi();
    const ctx = createContext();
    piCoderThemeThinkingSteps(pi as never);

    pi.handlers.get("message_update")?.({ assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } }, ctx);

    expect(getActiveThinkingState()).toEqual({ active: true, contentIndex: 0 });
    expect(ctx.ui.requestRender).not.toHaveBeenCalled();
  });

  test("message_update text_delta clears state without requesting render", () => {
    const pi = createFakePi();
    const ctx = createContext();
    piCoderThemeThinkingSteps(pi as never);
    setActiveThinkingState({ active: true, contentIndex: 0 });

    pi.handlers.get("message_update")?.(
      {
        assistantMessageEvent: { type: "text_delta", contentIndex: 1 },
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Earlier reasoning" },
            { type: "text", text: "Streaming answer" },
          ],
        },
      },
      ctx,
    );

    expect(getActiveThinkingState()).toEqual({ active: false });
    expect(ctx.ui.requestRender).not.toHaveBeenCalled();
  });

  test("agent_end clears state and requests one final render", () => {
    const pi = createFakePi();
    const ctx = createContext();
    piCoderThemeThinkingSteps(pi as never);
    setActiveThinkingState({ active: true, contentIndex: 0 });

    pi.handlers.get("agent_end")?.({}, ctx);

    expect(getActiveThinkingState()).toEqual({ active: false });
    expect(internalPatch.resetCompactLineTracker).toHaveBeenCalledOnce();
    expect(ctx.ui.requestRender).toHaveBeenCalledOnce();
  });

  test("degraded patch state skips render attempts", () => {
    internalPatch.retainThinkingStepsPatch.mockImplementation(() => {
      throw new Error("patch unavailable");
    });
    const pi = createFakePi();
    const ctx = createContext();
    piCoderThemeThinkingSteps(pi as never);

    pi.handlers.get("session_start")?.({}, ctx);
    pi.handlers.get("agent_end")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Structured thinking unavailable: patch unavailable", "warning");
    expect(ctx.ui.requestRender).not.toHaveBeenCalled();
  });
});
