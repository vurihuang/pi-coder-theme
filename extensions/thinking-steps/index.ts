import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { retainThinkingStepsPatch, resetCompactLineTracker } from "./internal-patch.js";
import { clearActiveThinkingState, setActiveThinkingState, setThinkingTheme } from "./state.js";

type AssistantMessageEventType =
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end";

type AssistantMessageEventPayload = {
  assistantMessageEvent?: {
    type?: unknown;
    contentIndex?: unknown;
  };
};

const thinkingEventTypes = new Set<AssistantMessageEventType>(["thinking_start", "thinking_delta"]);
const thinkingClearingEventTypes = new Set<AssistantMessageEventType>(["thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end"]);

function normalizeAssistantMessageEvent(event: unknown): { type: AssistantMessageEventType; contentIndex?: number } | undefined {
  const assistantMessageEvent = (event as AssistantMessageEventPayload | undefined)?.assistantMessageEvent;
  if (!assistantMessageEvent || typeof assistantMessageEvent.type !== "string") return undefined;
  if (!thinkingEventTypes.has(assistantMessageEvent.type as AssistantMessageEventType) && !thinkingClearingEventTypes.has(assistantMessageEvent.type as AssistantMessageEventType)) return undefined;

  return {
    type: assistantMessageEvent.type as AssistantMessageEventType,
    contentIndex: typeof assistantMessageEvent.contentIndex === "number" ? assistantMessageEvent.contentIndex : undefined,
  };
}

export function applyThinkingMessageUpdate(event: unknown): void {
  const normalized = normalizeAssistantMessageEvent(event);
  if (!normalized) return;

  if (thinkingEventTypes.has(normalized.type)) {
    setActiveThinkingState({ active: true, contentIndex: normalized.contentIndex });
    return;
  }

  clearActiveThinkingState();
}

function withActiveUI(ctx: ExtensionContext, callback: (ui: ExtensionContext["ui"]) => void): boolean {
  try {
    if (!ctx.hasUI) return false;
    callback(ctx.ui);
    return true;
  } catch {
    // Ignore stale UI contexts after session replacement or shutdown.
    return false;
  }
}

function requestRender(ctx: ExtensionContext): void {
  withActiveUI(ctx, (ui) => {
    (ui as { requestRender?: () => void }).requestRender?.();
  });
}

export default function piCoderThemeThinkingSteps(pi: ExtensionAPI) {
  let releasePatch: (() => void) | undefined;
  let degraded = false;

  pi.on("session_start", (_event, ctx) => {
    withActiveUI(ctx, (ui) => {
      setThinkingTheme(ui.theme);
      degraded = false;

      try {
        releasePatch = retainThinkingStepsPatch();
      } catch (error) {
        degraded = true;
        releasePatch = undefined;
        ui.notify(`Structured thinking unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });
  });

  pi.on("message_update", (event, ctx) => {
    if (degraded || !withActiveUI(ctx, () => undefined)) return;
    applyThinkingMessageUpdate(event);
  });

  pi.on("agent_end", (_event, ctx) => {
    clearActiveThinkingState();
    resetCompactLineTracker();
    if (!degraded) requestRender(ctx);
  });

  pi.on("session_shutdown", () => {
    releasePatch?.();
    releasePatch = undefined;
    degraded = false;
    clearActiveThinkingState();
    resetCompactLineTracker();
    setThinkingTheme(undefined);
  });
}
