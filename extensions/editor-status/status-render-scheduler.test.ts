import { expect, test, vi } from "vitest";

import { StatusRenderScheduler } from "./status-render-scheduler.js";

test("coalesces multiple editor/status invalidations into one render callback", () => {
  vi.useFakeTimers();
  try {
    const onRender = vi.fn();
    const scheduler = new StatusRenderScheduler({ onRender, debounceMs: 80 });

    scheduler.markStatusDirty();
    scheduler.markStatusDirty();
    scheduler.markDirty("editor");

    vi.advanceTimersByTime(79);
    expect(onRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenLastCalledWith(["status", "editor"]);
  } finally {
    vi.useRealTimers();
  }
});

test("editor input records timing without scheduling a duplicate render", () => {
  vi.useFakeTimers();
  try {
    let now = 1_000;
    const onRender = vi.fn();
    const scheduler = new StatusRenderScheduler({ onRender, debounceMs: 40, inputDeferMs: 120, now: () => now });

    scheduler.markEditorInput();
    vi.advanceTimersByTime(200);

    expect(onRender).not.toHaveBeenCalled();

    now += 20;
    scheduler.markStatusDirty();
    vi.advanceTimersByTime(99);
    expect(onRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenLastCalledWith(["status"]);
  } finally {
    vi.useRealTimers();
  }
});

test("cancel prevents pending callbacks after shutdown", () => {
  vi.useFakeTimers();
  try {
    const onRender = vi.fn();
    const scheduler = new StatusRenderScheduler({ onRender, debounceMs: 80 });

    scheduler.markStatusDirty();
    scheduler.cancel();
    vi.advanceTimersByTime(80);

    expect(onRender).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("forced refresh bypasses normal delay", () => {
  vi.useFakeTimers();
  try {
    const onRender = vi.fn();
    const scheduler = new StatusRenderScheduler({ onRender, debounceMs: 80 });

    scheduler.markStatusDirty();
    scheduler.forceRefresh("editor");

    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenLastCalledWith(["status", "editor"]);
  } finally {
    vi.useRealTimers();
  }
});
