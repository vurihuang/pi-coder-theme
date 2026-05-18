export type ThinkingStepsMode = "compact" | "summary";

export type ThinkingSemanticRole =
  | "inspect"
  | "plan"
  | "compare"
  | "verify"
  | "write"
  | "search"
  | "error"
  | "default";

export type ThinkingSourceBlock = {
  contentIndex: number;
  text: string;
  redacted?: boolean;
};

export type DerivedThinkingStep = {
  id: string;
  contentIndex: number;
  blockIndex: number;
  stepIndex: number;
  summary: string;
  body: string;
  role: ThinkingSemanticRole;
  icon: string;
  redacted?: boolean;
  collapsedPriority: number;
};

export type ActiveThinkingState = {
  active: boolean;
  contentIndex?: number;
};

export type ThinkingThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  italic?(text: string): string;
};
