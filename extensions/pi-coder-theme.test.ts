import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const requiredColorTokens = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

type ThemeFile = {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
};

function readTheme(fileName: string): ThemeFile {
  return JSON.parse(readFileSync(join(process.cwd(), "themes", fileName), "utf8")) as ThemeFile;
}

test("pi-coder-theme uses the current Pi package namespace", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, unknown>;
  };

  expect(packageJson.peerDependencies).toHaveProperty("@earendil-works/pi-coding-agent");
  expect(packageJson.peerDependencies).toHaveProperty("@earendil-works/pi-tui");
  expect(packageJson.devDependencies).toHaveProperty("@earendil-works/pi-coding-agent");
  expect(packageJson.devDependencies).toHaveProperty("@earendil-works/pi-tui");
  expect(packageJson.peerDependenciesMeta).toHaveProperty("@earendil-works/pi-coding-agent");
  expect(packageJson.peerDependenciesMeta).toHaveProperty("@earendil-works/pi-tui");

  const serializedPackageJson = JSON.stringify(packageJson);
  expect(serializedPackageJson).not.toContain("@mariozechner/pi-coding-agent");
  expect(serializedPackageJson).not.toContain("@mariozechner/pi-tui");
});

test("extension source imports Pi packages from the current namespace", () => {
  const extensionFiles = readdirSync(join(process.cwd(), "extensions"), { recursive: true })
    .map((fileName) => String(fileName))
    .filter((fileName) => fileName.endsWith(".ts"))
    .filter((fileName) => !fileName.endsWith(".test.ts"));

  for (const fileName of extensionFiles) {
    const source = readFileSync(join(process.cwd(), "extensions", fileName), "utf8");

    expect(source, fileName).not.toContain("@mariozechner/pi-coding-agent");
    expect(source, fileName).not.toContain("@mariozechner/pi-tui");
  }
});

test("package registers the structured thinking steps extension", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  };

  expect(packageJson.pi.extensions).toContain("./extensions/thinking-steps/index.ts");
});

test("pi-coder-theme-dark defines every required Pi color token", () => {
  const theme = readTheme("pi-coder-theme-dark.json");

  expect(theme.name).toBe("pi-coder-theme-dark");
  expect(Object.keys(theme.colors).sort()).toEqual([...requiredColorTokens].sort());

  for (const [token, value] of Object.entries(theme.colors)) {
    expect(value, `pi-coder-theme-dark.json:${token}`).not.toBe("");
  }
});

test("pi-coder-theme-dark uses the card gray for message and tool backgrounds", () => {
  const theme = readTheme("pi-coder-theme-dark.json");

  expect(theme.vars?.["pi-coder-theme-tool-card"]).toBe("#42464d");
  expect(theme.colors).toMatchObject({
    userMessageBg: "pi-coder-theme-tool-card",
    customMessageBg: "pi-coder-theme-tool-card",
    toolPendingBg: "pi-coder-theme-tool-card",
    toolSuccessBg: "pi-coder-theme-tool-card",
    toolErrorBg: "pi-coder-theme-tool-card",
  });
});
