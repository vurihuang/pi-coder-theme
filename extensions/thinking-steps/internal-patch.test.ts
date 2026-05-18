import { afterEach, expect, test } from "vitest";

import { assertPatchableAssistantMessageComponent, retainThinkingStepsPatch } from "./internal-patch.js";
import { resetThinkingStepsStateForTests } from "./state.js";

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
