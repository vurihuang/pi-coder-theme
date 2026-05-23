import { expect, test, vi } from "vitest";

import { TerminalSplitCompositor, type TerminalLike } from "./terminal-split.js";

type InputResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputResult;
type TestClusterRender = (width: number, terminalRows: number) => { lines: string[]; cursor: null };

function mouse(code: number, col: number, row: number, final: "M" | "m" = "M"): string {
  return `\x1b[<${code};${col};${row}${final}`;
}

function createCompositor(
  lines: string[],
  onCopySelection = vi.fn(),
  renderCluster: TestClusterRender = () => ({ lines: ["editor"], cursor: null }),
  onInvalidateCluster = vi.fn(),
) {
  let listener: InputListener | undefined;
  const writes: string[] = [];
  const terminal: TerminalLike = {
    columns: 80,
    get rows() {
      return 8;
    },
    write(data: string) {
      writes.push(data);
    },
  };
  const tui = {
    addInputListener(nextListener: InputListener) {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    doRender: vi.fn(),
    render(_width: number) {
      return lines;
    },
    requestRender: vi.fn(),
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection,
    onInvalidateCluster,
    renderCluster,
  });
  compositor.install();
  tui.render(80);

  return {
    compositor,
    input(data: string) {
      return listener?.(data);
    },
    onCopySelection,
    onInvalidateCluster,
    terminal,
    tui,
    writes,
  };
}

test("double-click selects and copies a zellij-like non-whitespace segment", () => {
  const { compositor, input, onCopySelection } = createCompositor([
    "alpha beta/gamma.delta omega",
  ]);

  input(mouse(0, 9, 1));
  input(mouse(0, 9, 1, "m"));
  input(mouse(0, 9, 1));
  input(mouse(0, 9, 1, "m"));

  expect(onCopySelection).toHaveBeenLastCalledWith("beta/gamma.delta");
  compositor.dispose();
});

test("drag selection copies the selected span on release", () => {
  const { compositor, input, onCopySelection } = createCompositor([
    "copy this span now",
  ]);

  input(mouse(0, 6, 1));
  input(mouse(32, 15, 1));
  input(mouse(0, 15, 1, "m"));

  expect(onCopySelection).toHaveBeenLastCalledWith("this span");
  compositor.dispose();
});

test("reuses cached fixed cluster during unchanged terminal writes", () => {
  const renderCluster = vi.fn(() => ({ lines: ["editor"], cursor: null }));
  const { compositor, terminal } = createCompositor(["line"], vi.fn(), renderCluster);
  renderCluster.mockClear();

  terminal.write("first output\n");
  terminal.write("second output\n");

  expect(renderCluster).not.toHaveBeenCalled();
  compositor.dispose();
});

test("emits dirty reasons when invalidating cached fixed cluster", () => {
  const onInvalidateCluster = vi.fn();
  const { compositor } = createCompositor(["line"], vi.fn(), () => ({ lines: ["editor"], cursor: null }), onInvalidateCluster);

  compositor.invalidateCluster("status");

  expect(onInvalidateCluster).toHaveBeenLastCalledWith("status");
  compositor.dispose();
});

test("invalidates cached fixed cluster on TUI render so widget/status content can refresh", () => {
  let clusterLine = "widget one";
  const renderCluster = vi.fn(() => ({ lines: [clusterLine], cursor: null }));
  const { compositor, tui, writes } = createCompositor(["line"], vi.fn(), renderCluster);
  renderCluster.mockClear();
  writes.length = 0;

  clusterLine = "widget two";
  tui.doRender();

  expect(renderCluster).toHaveBeenCalledTimes(1);
  expect(writes.join("\n")).toContain("widget two");
  compositor.dispose();
});

test("skips unchanged fixed cluster repaints during high-volume terminal writes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));

  try {
    const { compositor, terminal, writes } = createCompositor(["line"]);
    writes.length = 0;

    terminal.write("first output\n");
    terminal.write("second output\n");

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("editor");
    expect(writes[1]).not.toContain("editor");
    expect(writes[1]).toContain("\x1b[r");
    expect(writes[1]).toContain("\x1b[?25l");

    vi.advanceTimersByTime(50);

    expect(writes).toHaveLength(2);
    compositor.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("visible overlays bypass fixed-cluster terminal wrapping", () => {
  const { compositor, terminal, tui, writes } = createCompositor(["line"]);
  (tui as typeof tui & { hasOverlay?: () => boolean }).hasOverlay = () => true;
  writes.length = 0;

  terminal.write("overlay output\n");

  expect(writes.at(-1)).toBe("overlay output\n");
  compositor.dispose();
});

test("visible overlays clear the fixed cluster and reset terminal state", () => {
  const { compositor, terminal, tui, writes } = createCompositor(["line"]);
  writes.length = 0;

  compositor.requestRepaint();
  expect(writes.join("")).toContain("editor");

  (tui as typeof tui & { hasOverlay?: () => boolean }).hasOverlay = () => true;
  terminal.write("overlay output\n");

  const output = writes.join("");
  expect(output).toContain("\x1b[r");
  expect(output).toContain("\x1b[?25h");
  expect(writes.at(-1)).toBe("overlay output\n");
  compositor.dispose();
});

test("resize invalidation repaints the fixed cluster at the new width", () => {
  const renderCluster = vi.fn((width: number, rows: number) => ({ lines: [`editor ${width}x${rows}`], cursor: null }));
  const { compositor, terminal, writes } = createCompositor(["line"], vi.fn(), renderCluster);
  writes.length = 0;

  compositor.requestRepaint();
  expect(writes.join("\n")).toContain("editor 80x8");

  terminal.columns = 100;
  compositor.invalidateCluster("resize");
  compositor.requestRepaint();

  expect(writes.join("\n")).toContain("editor 100x8");
  compositor.dispose();
});

test("selection changes repaint the fixed cluster even when raw lines are unchanged", () => {
  const { compositor, input, writes } = createCompositor(
    ["root"],
    vi.fn(),
    () => ({ lines: ["cluster selectable"], cursor: null }),
  );
  writes.length = 0;

  input(mouse(0, 1, 8));
  input(mouse(32, 8, 8));
  input(mouse(0, 8, 8, "m"));
  compositor.requestRepaint();

  expect(writes.join("\n")).toContain("\x1b[7mcluster");
  compositor.dispose();
});

test("repaints changed fixed cluster after write throttle window", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));

  try {
    let editorLine = "editor";
    const { compositor, terminal, writes } = createCompositor(
      ["line"],
      vi.fn(),
      () => ({ lines: [editorLine], cursor: null }),
    );
    writes.length = 0;

    terminal.write("first output\n");
    editorLine = "editor updated";
    compositor.invalidateCluster("editor");
    terminal.write("second output\n");

    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toContain("editor updated");

    vi.advanceTimersByTime(50);

    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain("editor updated");
    compositor.dispose();
  } finally {
    vi.useRealTimers();
  }
});
