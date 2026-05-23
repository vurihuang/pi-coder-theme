export type StatusRenderDirtyReason = "editor" | "status";

export interface StatusRenderSchedulerOptions {
  onRender: (reasons: StatusRenderDirtyReason[]) => void;
  debounceMs?: number;
}

export class StatusRenderScheduler {
  private readonly onRender: (reasons: StatusRenderDirtyReason[]) => void;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly dirtyReasons = new Set<StatusRenderDirtyReason>();

  constructor(options: StatusRenderSchedulerOptions) {
    this.onRender = options.onRender;
    this.debounceMs = options.debounceMs ?? 80;
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

    this.timer = setTimeout(() => this.flush(), this.debounceMs);
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
