export type StatusRenderDirtyReason = "editor" | "status";

export interface StatusRenderSchedulerOptions {
  onRender: (reasons: StatusRenderDirtyReason[]) => void;
  debounceMs?: number;
  inputDeferMs?: number;
  now?: () => number;
}

export class StatusRenderScheduler {
  private readonly onRender: (reasons: StatusRenderDirtyReason[]) => void;
  private readonly debounceMs: number;
  private readonly inputDeferMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEditorInputAt = Number.NEGATIVE_INFINITY;
  private readonly dirtyReasons = new Set<StatusRenderDirtyReason>();

  constructor(options: StatusRenderSchedulerOptions) {
    this.onRender = options.onRender;
    this.debounceMs = options.debounceMs ?? 80;
    this.inputDeferMs = options.inputDeferMs ?? 120;
    this.now = options.now ?? Date.now;
  }

  markEditorInput(): void {
    this.lastEditorInputAt = this.now();
  }

  markStatusDirty(): void {
    this.markDirty("status");
  }

  markDirty(reason: StatusRenderDirtyReason, immediate = false): void {
    this.dirtyReasons.add(reason);
    if (immediate) {
      this.flush();
      return;
    }

    this.schedule();
  }

  forceRefresh(reason: StatusRenderDirtyReason = "status"): void {
    this.dirtyReasons.add(reason);
    this.flush();
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirtyReasons.clear();
  }

  private schedule(): void {
    if (this.timer) return;

    const sinceInput = this.now() - this.lastEditorInputAt;
    const deferMs = sinceInput >= 0 && sinceInput < this.inputDeferMs ? this.inputDeferMs - sinceInput : 0;
    this.timer = setTimeout(() => this.flush(), Math.max(this.debounceMs, deferMs));
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.dirtyReasons.size === 0) return;

    const reasons = [...this.dirtyReasons];
    this.dirtyReasons.clear();
    this.onRender(reasons);
  }
}
