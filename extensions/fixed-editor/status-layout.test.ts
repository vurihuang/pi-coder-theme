import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import {
  buildBackgroundWorkerLabel,
  buildElapsedTimeLabel,
  buildGitChangesLabel,
  buildModelLabel,
  buildUsageLabel,
  buildWorkingLabel,
  renderStatusRows,
  StatusLayoutCache,
  type EditorStatusLayout,
} from "./status-layout.js";

function layout(label: string): EditorStatusLayout {
  return { topLeft: label, topRight: "model", cwd: "cwd", statusLeft: "left", statusRight: "right" };
}

test("reuses status layout within the cache ttl for the same width", () => {
  let now = 1_000;
  const cache = new StatusLayoutCache({ ttlMs: 250, now: () => now });
  let builds = 0;

  const first = cache.get(80, () => {
    builds += 1;
    return layout("first");
  });
  const second = cache.get(80, () => {
    builds += 1;
    return layout("second");
  });

  expect(second).toBe(first);
  expect(builds).toBe(1);
  expect(cache.recomputeCount).toBe(1);

  now += 251;
  expect(cache.get(80, () => layout("third")).topLeft).toBe("third");
  expect(cache.recomputeCount).toBe(2);
});

test("invalidates status layout on width or explicit dirty state", () => {
  const cache = new StatusLayoutCache({ ttlMs: 250, now: () => 1_000 });

  expect(cache.get(80, () => layout("first")).topLeft).toBe("first");
  expect(cache.get(100, () => layout("wide")).topLeft).toBe("wide");

  cache.invalidate();
  expect(cache.get(100, () => layout("dirty")).topLeft).toBe("dirty");
  expect(cache.recomputeCount).toBe(3);
});

test("status rows truncate without exceeding terminal width", () => {
  const [row] = renderStatusRows(20, "left label that is long", "right label that is long");

  expect(row).toBeDefined();
  expect(visibleWidth(row ?? "")).toBeLessThanOrEqual(20);
});

test("status label helpers render active work, elapsed time, model, usage, and git labels", () => {
  const fg = (color: string, text: string) => `[${color}]${text}`;

  expect(buildUsageLabel([" 12%/200k", "↑1k", "$0.010"])).toBe(" 12%/200k · ↑1k · $0.010 ");
  expect(buildModelLabel(60, "medium", "ext", (width) => `model-${width}`, fg)).toContain("[thinkingMedium]medium");
  expect(buildWorkingLabel({ active: true, message: "Running tools...", frame: "~" }, fg)).toContain("[accent]~");
  expect(buildElapsedTimeLabel({ active: true, elapsedMs: 1_500 }, (ms) => `${Math.floor(ms / 1000)}s`, fg)).toBe("[accent]⏱ [accent]1s");
  expect(buildBackgroundWorkerLabel({ state: "running", attempt: 2, workerStartedAt: null, elapsedMs: 60_000 }, { active: true, message: "Working", frame: "≈" }, 120, () => "1m", fg)).toContain("[accent]#2");
  expect(buildGitChangesLabel({ changedFiles: 2, added: 3, modified: 1, removed: 4 }, fg)).toContain("[toolDiffAdded]+3");
});
