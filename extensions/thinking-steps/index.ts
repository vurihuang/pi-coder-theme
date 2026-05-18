import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { retainThinkingStepsPatch } from "./internal-patch.js";
import { clearActiveThinkingState, setActiveThinkingState, setThinkingTheme } from "./state.js";

type AssistantMessageEvent = {
  message?: {
    role?: string;
    content?: Array<{ type?: string }>;
  };
};

function hasThinkingContent(event: AssistantMessageEvent): boolean {
  return event.message?.role === "assistant" && Array.isArray(event.message.content) && event.message.content.some((content) => content.type === "thinking");
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

    if (hasThinkingContent(event as AssistantMessageEvent)) {
      const contentIndex = (event as AssistantMessageEvent).message?.content?.findIndex((content) => content.type === "thinking");
      setActiveThinkingState({ active: true, contentIndex: contentIndex === -1 ? undefined : contentIndex });
      requestRender(ctx);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    clearActiveThinkingState();
    if (!degraded) requestRender(ctx);
  });

  pi.on("session_shutdown", () => {
    releasePatch?.();
    releasePatch = undefined;
    degraded = false;
    clearActiveThinkingState();
    setThinkingTheme(undefined);
  });
}
