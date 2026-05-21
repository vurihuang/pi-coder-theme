import { expect, test, vi } from "vitest";

import { TerminalSplitCompositor, type TerminalLike } from "./terminal-split.js";

type InputResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputResult;

function mouse(code: number, col: number, row: number, final: "M" | "m" = "M"): string {
  return `\x1b[<${code};${col};${row}${final}`;
}

function createCompositor(lines: string[], onCopySelection = vi.fn()) {
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
    render(_width: number) {
      return lines;
    },
    requestRender: vi.fn(),
  };

  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    onCopySelection,
    renderCluster: () => ({ lines: ["editor"], cursor: null }),
  });
  compositor.install();
  tui.render(80);

  return {
    compositor,
    input(data: string) {
      return listener?.(data);
    },
    onCopySelection,
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

test("throttles fixed cluster repaints during high-volume terminal writes", () => {
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

    vi.advanceTimersByTime(50);

    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain("editor");
    compositor.dispose();
  } finally {
    vi.useRealTimers();
  }
});
