import type { ActiveThinkingState, ThinkingThemeLike } from "./types.js";

let activeThinkingState: ActiveThinkingState = { active: false };
let activeTheme: ThinkingThemeLike | undefined;
let patchRefCount = 0;
let patchCleanup: (() => void) | undefined;

export function setActiveThinkingState(state: ActiveThinkingState): void {
  activeThinkingState = state;
}

export function getActiveThinkingState(): ActiveThinkingState {
  return activeThinkingState;
}

export function clearActiveThinkingState(): void {
  activeThinkingState = { active: false };
}

export function setThinkingTheme(theme: ThinkingThemeLike | undefined): void {
  activeTheme = theme;
}

export function getThinkingTheme(): ThinkingThemeLike | undefined {
  return activeTheme;
}

export function incrementPatchRefCount(): number {
  patchRefCount += 1;
  return patchRefCount;
}

export function decrementPatchRefCount(): number {
  patchRefCount = Math.max(0, patchRefCount - 1);
  return patchRefCount;
}

export function getPatchRefCount(): number {
  return patchRefCount;
}

export function setPatchCleanup(cleanup: (() => void) | undefined): void {
  patchCleanup = cleanup;
}

export function takePatchCleanup(): (() => void) | undefined {
  const cleanup = patchCleanup;
  patchCleanup = undefined;
  return cleanup;
}

export function resetThinkingStepsStateForTests(): void {
  activeThinkingState = { active: false };
  activeTheme = undefined;
  patchRefCount = 0;
  patchCleanup = undefined;
}
