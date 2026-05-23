import type { DerivedThinkingStep, ThinkingSemanticRole, ThinkingSourceBlock } from "./types.js";

const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+)/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const LEADING_SUMMARY_PHRASE_RE = /^(?:i\s+(?:need|should|want)\s+to|need\s+to|i(?:'m| am)\s+going\s+to|i(?:'ll| will)|let\s+me|let'?s|first,?\s+|next,?\s+|then,?\s+|now,?\s+|okay,?\s+)/i;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(HEADING_RE, "")
    .replace(LIST_ITEM_RE, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[^\w/.-])\*(?=\S)([\s\S]*?\S)\*(?=[^\w/.-]|$)/g, "$1$2")
    .replace(/(^|[^\w/.-])_(?=\S)([\s\S]*?\S)_(?=[^\w/.-]|$)/g, "$1$2")
    .trim();
}

function stripLeadingSummaryPhrase(text: string): string {
  const stripped = text.replace(LEADING_SUMMARY_PHRASE_RE, "").trim();
  return stripped || text.trim();
}

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Thinking.";
  if (/[.!?…]$/u.test(trimmed)) return trimmed;
  return `${trimmed.replace(/[;:,]+$/g, "")}.`;
}

function firstMeaningfulLine(text: string): string {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function firstSentence(text: string): string {
  const normalized = collapseWhitespace(text);
  // Match sentence boundaries for both Western (.!?) and CJK (。！？) punctuation.
  // CJK fullwidth marks are standalone terminators (no trailing space required).
  const match = normalized.match(/^(.{1,120}?)(?:[.!?](?:\s|$)|[。！？])/);
  return match?.[1]?.trim() ?? normalized;
}

function isStandaloneHeading(chunk: string): boolean {
  const lines = normalizeNewlines(chunk)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && HEADING_RE.test(lines[0] ?? "");
}

function isListChunk(chunk: string): boolean {
  return normalizeNewlines(chunk)
    .split("\n")
    .some((line) => LIST_ITEM_RE.test(line));
}

function mergeHeadingChunks(chunks: string[]): string[] {
  const merged: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const next = chunks[index + 1];
    if (isStandaloneHeading(chunk) && next) {
      merged.push(`${chunk}\n\n${next}`);
      index += 1;
      continue;
    }
    merged.push(chunk);
  }

  return merged;
}

function splitListChunk(chunk: string): string[] {
  const lines = normalizeNewlines(chunk).split("\n");
  const itemIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (LIST_ITEM_RE.test(line)) indexes.push(index);
    return indexes;
  }, []);

  if (itemIndexes.length < 2) return [chunk.trim()];

  return itemIndexes.map((start, index) => {
    const end = itemIndexes[index + 1] ?? lines.length;
    return lines.slice(start, end).join("\n").trim();
  }).filter(Boolean);
}

export function splitThinkingIntoStepTexts(text: string): string[] {
  const normalized = normalizeNewlines(text).trim();
  if (!normalized) return [];

  const paragraphChunks = normalized
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const merged = mergeHeadingChunks(paragraphChunks);
  return merged.flatMap((chunk) => isListChunk(chunk) ? splitListChunk(chunk) : [chunk]);
}

function roleForSummary(summary: string): ThinkingSemanticRole {
  if (/\b(error|failed|failure|bug|broken|throw|crash)\b/i.test(summary)) return "error";
  if (/\b(verify|test|check|confirm|validate)\b/i.test(summary)) return "verify";
  if (/\b(compare|versus|vs\.?|tradeoff|alternative)\b/i.test(summary)) return "compare";
  if (/\b(inspect|read|look|review|scan)\b/i.test(summary)) return "inspect";
  if (/\b(search|find|grep|discover|research)\b/i.test(summary)) return "search";
  if (/\b(write|edit|create|update|implement|add)\b/i.test(summary)) return "write";
  if (/\b(plan|design|approach|scope|decide)\b/i.test(summary)) return "plan";
  return "default";
}

function iconForRole(role: ThinkingSemanticRole): string {
  switch (role) {
    case "inspect":
      return "◫";
    case "plan":
      return "◇";
    case "compare":
      return "↔";
    case "verify":
      return "✓";
    case "write":
      return "✎";
    case "search":
      return "⌕";
    case "error":
      return "!";
    default:
      return "·";
  }
}

function priorityForRole(role: ThinkingSemanticRole): number {
  switch (role) {
    case "error":
      return 90;
    case "verify":
      return 80;
    case "plan":
    case "compare":
      return 70;
    case "write":
    case "inspect":
    case "search":
      return 60;
    default:
      return 50;
  }
}

function summarizeStepText(text: string): string {
  const line = firstMeaningfulLine(text);
  const summary = stripLeadingSummaryPhrase(stripMarkdown(firstSentence(line)));
  return ensureSentence(summary);
}

export function deriveThinkingSteps(blocks: ThinkingSourceBlock[]): DerivedThinkingStep[] {
  const steps: DerivedThinkingStep[] = [];

  blocks.forEach((block, blockIndex) => {
    const stepTexts = splitThinkingIntoStepTexts(block.text);
    const effectiveStepTexts = stepTexts.length > 0 ? stepTexts : block.redacted ? ["Hidden reasoning."] : [];

    effectiveStepTexts.forEach((body, stepIndex) => {
      const summary = block.redacted && !block.text.trim() ? "Hidden reasoning." : summarizeStepText(body);
      const role = roleForSummary(summary);
      steps.push({
        id: `thinking-${block.contentIndex}-${blockIndex}-${stepIndex}`,
        contentIndex: block.contentIndex,
        blockIndex,
        stepIndex,
        summary,
        body,
        role,
        icon: iconForRole(role),
        redacted: block.redacted,
        collapsedPriority: priorityForRole(role),
      });
    });
  });

  return steps;
}
