import { afterEach, expect, test } from "vitest";

import { assertPatchableAssistantMessageComponent, retainThinkingStepsPatch } from "./internal-patch.js";
import { resetThinkingStepsStateForTests, setActiveThinkingState } from "./state.js";

type FakePrototype = {
  updateContent(message: unknown): void;
  setHideThinkingBlock(hide: boolean): void;
  setHiddenThinkingLabel(label: string): void;
};

afterEach(() => {
  resetThinkingStepsStateForTests();
});

function createFakeComponent() {
  class FakeAssistantMessageComponent {
    contentContainer = { clear() {}, addChild(_component: unknown) {} };
    hideThinkingBlock = false;
    markdownTheme = {};
    hiddenThinkingLabel = "Thinking...";
    lastMessage?: unknown;
    updateContent(message: unknown) {
      this.lastMessage = message;
    }
    setHideThinkingBlock(hide: boolean) {
      this.hideThinkingBlock = hide;
    }
    setHiddenThinkingLabel(label: string) {
      this.hiddenThinkingLabel = label;
    }
  }

  return FakeAssistantMessageComponent as unknown as { prototype: FakePrototype };
}

test("assertPatchableAssistantMessageComponent rejects incompatible prototypes", () => {
  expect(() => assertPatchableAssistantMessageComponent(function Broken() {})).toThrow(/missing updateContent/);
});

test("retainThinkingStepsPatch restores originals after matching releases", () => {
  const component = createFakeComponent();
  const originalUpdateContent = component.prototype.updateContent;

  const firstRelease = retainThinkingStepsPatch(component);
  const patchedUpdateContent = component.prototype.updateContent;
  const secondRelease = retainThinkingStepsPatch(component);

  expect(component.prototype.updateContent).toBe(patchedUpdateContent);
  expect(component.prototype.updateContent).not.toBe(originalUpdateContent);

  secondRelease();
  expect(component.prototype.updateContent).toBe(patchedUpdateContent);

  firstRelease();
  expect(component.prototype.updateContent).toBe(originalUpdateContent);
});

test("thinking steps do not keep stale padded height after content shrinks", () => {
  const children: Array<{ render?: (width: number) => string[] }> = [];
  class FakeAssistantMessageComponent {
    contentContainer = {
      clear() {
        children.length = 0;
      },
      addChild(component: { render?: (width: number) => string[] }) {
        children.push(component);
      },
    };
    hideThinkingBlock = false;
    markdownTheme = {};
    hiddenThinkingLabel = "Thinking...";
    lastMessage?: unknown;
    updateContent(message: unknown) {
      this.lastMessage = message;
    }
    setHideThinkingBlock(hide: boolean) {
      this.hideThinkingBlock = hide;
    }
    setHiddenThinkingLabel(label: string) {
      this.hiddenThinkingLabel = label;
    }
  }

  const release = retainThinkingStepsPatch(FakeAssistantMessageComponent as unknown as { prototype: FakePrototype });
  const instance = new FakeAssistantMessageComponent();
  setActiveThinkingState({ active: true, contentIndex: 0 });

  instance.updateContent({
    content: [{ type: "thinking", thinking: "Inspect an extremely long renderer summary that must wrap across multiple terminal lines in a narrow viewport without being shortened before it wraps" }],
  });
  const longLines = children[1]?.render?.(24) ?? [];
  expect(longLines.length).toBeGreaterThan(1);

  instance.updateContent({
    content: [{ type: "thinking", thinking: "Done." }],
  });
  const shortLines = children[1]?.render?.(24) ?? [];
  expect(shortLines).toHaveLength(2);

  release();
});
