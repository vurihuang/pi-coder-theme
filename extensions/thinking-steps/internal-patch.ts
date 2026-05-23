import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

import { deriveThinkingSteps } from "./parse.js";
import { getActiveThinkingState, getPatchRefCount, getThinkingTheme, incrementPatchRefCount, decrementPatchRefCount, setPatchCleanup, takePatchCleanup } from "./state.js";
import { renderThinkingSteps } from "./render.js";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js";

type AssistantContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall" }
  | Record<string, unknown>;

type AssistantMessageLike = {
  content: AssistantContent[];
  stopReason?: string;
  errorMessage?: string;
};

type RenderableContainer = {
  clear(): void;
  addChild(component: unknown): void;
};

type AssistantMessageComponentPrototype = {
  updateContent(message: AssistantMessageLike): void;
  setHideThinkingBlock(hide: boolean): void;
  setHiddenThinkingLabel(label: string): void;
  contentContainer: RenderableContainer;
  lastMessage?: AssistantMessageLike;
  hideThinkingBlock: boolean;
  markdownTheme: unknown;
  hiddenThinkingLabel: string;
  hasToolCalls?: boolean;
};

type PatchableComponent = { prototype: AssistantMessageComponentPrototype };

export function resetCompactLineTracker(): void {}

class ThinkingStepsComponent {
  constructor(
    private readonly blocks: ThinkingSourceBlock[],
    private readonly theme: ThinkingThemeLike,
    private readonly mode: "compact" | "summary",
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const steps = deriveThinkingSteps(this.blocks);
    const active = getActiveThinkingState();
    return renderThinkingSteps({
      mode: this.mode,
      width,
      steps,
      theme: this.theme,
      activeStepId: active.contentIndex === undefined ? undefined : steps.find((step) => step.contentIndex === active.contentIndex)?.id,
      isActive: active.active,
    });
  }
}

export function assertPatchableAssistantMessageComponent(value: unknown): PatchableComponent {
  const prototype = (value as { prototype?: unknown } | undefined)?.prototype;
  if (!prototype || typeof prototype !== "object") {
    throw new Error("Thinking steps patch failed: AssistantMessageComponent.prototype is missing.");
  }

  const candidate = prototype as Record<string, unknown>;
  const missing = ["updateContent", "setHideThinkingBlock", "setHiddenThinkingLabel"].filter((name) => typeof candidate[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`Thinking steps patch failed: AssistantMessageComponent prototype is incompatible (missing ${missing.join(", ")}).`);
  }

  return value as PatchableComponent;
}

function hasVisibleThinking(content: AssistantContent): content is { type: "thinking"; thinking: string; redacted?: boolean } {
  return content.type === "thinking" && typeof content.thinking === "string" && (content.redacted === true || content.thinking.trim().length > 0);
}

function hasVisibleText(content: AssistantContent): content is { type: "text"; text: string } {
  return content.type === "text" && typeof content.text === "string" && content.text.trim().length > 0;
}

function hasVisibleContent(message: AssistantMessageLike): boolean {
  return message.content.some((content) => hasVisibleText(content) || hasVisibleThinking(content));
}

function hasVisibleContentAfter(message: AssistantMessageLike, contentIndex: number): boolean {
  return message.content.slice(contentIndex + 1).some((content) => hasVisibleText(content) || hasVisibleThinking(content));
}

function collectThinkingBlock(content: { type: "thinking"; thinking: string; redacted?: boolean }, contentIndex: number): ThinkingSourceBlock {
  return {
    contentIndex,
    text: content.thinking,
    redacted: content.redacted,
  };
}

function fallbackTheme(): ThinkingThemeLike {
  return {
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
    italic(text) {
      return text;
    },
  };
}

function renderStructuredContent(instance: AssistantMessageComponentPrototype, message: AssistantMessageLike, originalUpdateContent: (message: AssistantMessageLike) => void): void {
  const container = instance.contentContainer;
  if (!container || typeof container.clear !== "function" || typeof container.addChild !== "function") {
    originalUpdateContent.call(instance, message);
    return;
  }

  instance.lastMessage = message;
  container.clear();

  const visibleContent = hasVisibleContent(message);
  if (visibleContent) container.addChild(new Spacer(1));

  const theme = getThinkingTheme() ?? fallbackTheme();
  const markdownTheme = (instance.markdownTheme ?? getMarkdownTheme()) as MarkdownTheme;

  message.content.forEach((content, index) => {
    if (hasVisibleText(content)) {
      container.addChild(new Markdown(content.text.trim(), 1, 0, markdownTheme));
      return;
    }

    if (!hasVisibleThinking(content)) return;

    if (instance.hideThinkingBlock) {
      const label = theme.italic ? theme.italic(theme.fg("thinkingText", instance.hiddenThinkingLabel)) : theme.fg("thinkingText", instance.hiddenThinkingLabel);
      container.addChild(new Text(label, 1, 0));
    } else {
      const active = getActiveThinkingState();
      const mode = active.active ? "compact" : "summary";
      container.addChild(new ThinkingStepsComponent([collectThinkingBlock(content, index)], theme, mode));
    }

    if (hasVisibleContentAfter(message, index)) {
      container.addChild(new Spacer(1));
    }
  });

  instance.hasToolCalls = message.content.some((content) => content.type === "toolCall");
  if (instance.hasToolCalls) return;

  if (message.stopReason === "aborted") {
    const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
  } else if (message.stopReason === "error") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", `Error: ${message.errorMessage || "Unknown error"}`), 1, 0));
  }
}

export function retainThinkingStepsPatch(component: unknown = AssistantMessageComponent): () => void {
  const AssistantComponent = assertPatchableAssistantMessageComponent(component);
  incrementPatchRefCount();

  if (getPatchRefCount() > 1) {
    return releaseThinkingStepsPatch;
  }

  const prototype = AssistantComponent.prototype;
  const originalUpdateContent = prototype.updateContent;
  const originalSetHideThinkingBlock = prototype.setHideThinkingBlock;
  const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;

  prototype.updateContent = function updateContentWithThinkingSteps(this: AssistantMessageComponentPrototype, message: AssistantMessageLike): void {
    try {
      renderStructuredContent(this, message, originalUpdateContent);
    } catch {
      originalUpdateContent.call(this, message);
    }
  };

  prototype.setHideThinkingBlock = function setHideThinkingBlockWithThinkingSteps(this: AssistantMessageComponentPrototype, hide: boolean): void {
    this.hideThinkingBlock = hide;
    if (this.lastMessage) this.updateContent(this.lastMessage);
  };

  prototype.setHiddenThinkingLabel = function setHiddenThinkingLabelWithThinkingSteps(this: AssistantMessageComponentPrototype, label: string): void {
    this.hiddenThinkingLabel = label;
    if (this.lastMessage) this.updateContent(this.lastMessage);
  };

  setPatchCleanup(() => {
    if (prototype.updateContent !== originalUpdateContent) prototype.updateContent = originalUpdateContent;
    if (prototype.setHideThinkingBlock !== originalSetHideThinkingBlock) prototype.setHideThinkingBlock = originalSetHideThinkingBlock;
    if (prototype.setHiddenThinkingLabel !== originalSetHiddenThinkingLabel) prototype.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;
  });

  return releaseThinkingStepsPatch;
}

export function releaseThinkingStepsPatch(): void {
  if (decrementPatchRefCount() > 0) return;
  takePatchCleanup()?.();
}
