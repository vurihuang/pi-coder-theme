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

function requestRender(ctx: ExtensionContext): void {
  try {
    (ctx.ui as { requestRender?: () => void }).requestRender?.();
  } catch {
    // Ignore stale UI contexts after session replacement or shutdown.
  }
}

export default function piCoderThemeThinkingSteps(pi: ExtensionAPI) {
  let releasePatch: (() => void) | undefined;
  let degraded = false;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    setThinkingTheme(ctx.ui.theme);
    degraded = false;

    try {
      releasePatch = retainThinkingStepsPatch();
    } catch (error) {
      degraded = true;
      releasePatch = undefined;
      ctx.ui.notify(`Structured thinking unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI || degraded) return;

    if (hasThinkingContent(event as AssistantMessageEvent)) {
      const contentIndex = (event as AssistantMessageEvent).message?.content?.findIndex((content) => content.type === "thinking");
      setActiveThinkingState({ active: true, contentIndex: contentIndex === -1 ? undefined : contentIndex });
      requestRender(ctx);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    clearActiveThinkingState();
    if (ctx.hasUI && !degraded) requestRender(ctx);
  });

  pi.on("session_shutdown", () => {
    releasePatch?.();
    releasePatch = undefined;
    degraded = false;
    clearActiveThinkingState();
    setThinkingTheme(undefined);
  });
}
