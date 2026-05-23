import { expect, test } from "vitest";

import { renderFixedEditorCluster } from "./cluster.js";

test("renders widget lines as a fixed section above the editor", () => {
  const cluster = renderFixedEditorCluster({
    width: 80,
    terminalRows: 8,
    statusLines: ["status"],
    widgetLines: ["subagent running"],
    editorLines: ["editor"],
  });

  expect(cluster.lines).toEqual(["status", "subagent running", "editor"]);
});

test("caps multiple widget lines without pushing the editor off screen", () => {
  const cluster = renderFixedEditorCluster({
    width: 80,
    terminalRows: 4,
    statusLines: ["status"],
    widgetLines: ["widget 1", "widget 2", "widget 3"],
    editorLines: ["editor"],
  });

  expect(cluster.lines).toEqual(["widget 2", "widget 3", "editor"]);
});
