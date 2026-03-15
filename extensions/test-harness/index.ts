/**
 * Test harness — registers /test-* commands that exercise
 * every component in the UI library. Used for manual
 * validation passes after migrations.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	renderCode,
	renderDiff,
	renderMarkdown,
} from "../lib/ui/content-renderer.js";
import { prompt, view } from "../lib/ui/panel.js";
import type { ContentFn, PromptResult, TabbedResult } from "../lib/ui/types.js";

// ---- Result formatting ----

/** Format a single PromptResult for notify output. */
function formatResult(result: PromptResult | null): string {
	if (result === null) return "cancelled";
	if (result.type === "steer") return `steer: ${result.note}`;
	let msg = `action: ${result.value}`;
	if (result.note) msg += ` note: ${result.note}`;
	if (result.editorText) msg += ` editor: ${result.editorText}`;
	return msg;
}

/** Format a TabbedResult for notify output. */
function formatTabbedResult(result: TabbedResult | null): string {
	if (result === null) return "cancelled";
	const parts: string[] = [];
	for (const [index, item] of result.items) {
		parts.push(`  [${index}] ${formatResult(item)}`);
	}
	parts.push(`  userItems: ${result.userItems.length}`);
	if (result.userItems.length > 0) {
		for (const ui of result.userItems) {
			parts.push(`    - ${ui}`);
		}
	}
	return `tabbed result:\n${parts.join("\n")}`;
}

// ---- Content helpers ----

/** Generate numbered lines for scroll testing. */
function numberedLines(count: number): ContentFn {
	return (_theme, _width) => {
		const lines: string[] = [];
		for (let i = 1; i <= count; i++) {
			lines.push(`  Line ${i} of ${count}`);
		}
		return lines;
	};
}

/** Static text content from an array of strings. */
function staticContent(text: string[]): ContentFn {
	return (_theme, _width) => text.map((line) => `  ${line}`);
}

// ---- Test data ----

const MARKDOWN_SAMPLE = `# Heading 1

## Heading 2

### Heading 3

This has **bold**, *italic*, and \`inline code\`.

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

> This is a blockquote.
> It can span multiple lines.

1. First ordered item
2. Second ordered item
3. Third ordered item

- Unordered item A
- Unordered item B
- Unordered item C

[A link to example.com](https://example.com)

---

| Column A | Column B |
|----------|----------|
| Row 1A   | Row 1B   |
| Row 2A   | Row 2B   |
| Row 3A   | Row 3B   |
`;

const CODE_SAMPLE = `import { readFile } from "fs/promises";

interface Config {
  port: number;
  host: string;
  debug: boolean;
}

async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  return {
    port: parsed.port ?? 3000,
    host: parsed.host ?? "localhost",
    debug: parsed.debug ?? false,
  };
}

export { loadConfig };
export type { Config };
`;

const DIFF_SAMPLE = `diff --git a/src/config.ts b/src/config.ts
index abc1234..def5678 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -5,8 +5,10 @@ interface Config {
   port: number;
   host: string;
   debug: boolean;
+  logLevel: string;
 }
 
-function getPort(): number {
-  return 3000;
+function getPort(config: Config): number {
+  return config.port;
 }
+
+export { getPort };
`;

// ---- Commands ----

export default function testHarness(ctx: ExtensionContext) {
	// /test-scroll — ScrollRegion + view()
	ctx.registerCommand("/test-scroll", "Test scroll region", async () => {
		await view(ctx, {
			title: "Scroll Test",
			content: numberedLines(50),
		});
		ctx.ui.notify("scroll test dismissed", "info");
	});

	// /test-actions — ActionBar + prompt(single)
	ctx.registerCommand("/test-actions", "Test action bar", async () => {
		const result = await prompt(ctx, {
			content: staticContent([
				"This tests the action bar.",
				"Try each action key.",
				"Hold Shift for steer layer.",
			]),
			actions: [
				{ key: "a", label: "Approve" },
				{ key: "r", label: "Reject" },
				{ key: "d", label: "Defer" },
			],
		});
		ctx.ui.notify(formatResult(result), "info");
	});

	// /test-options — OptionList + prompt(single)
	ctx.registerCommand("/test-options", "Test option list", async () => {
		const result = await prompt(ctx, {
			content: staticContent([
				"Pick an option.",
				"Descriptions show on the selected item only.",
			]),
			options: [
				{
					label: "Quick fix",
					value: "quick",
					description: "Fast but incomplete",
				},
				{
					label: "Full rewrite",
					value: "full",
					description: "Complete but slow",
				},
				{ label: "Partial refactor", value: "partial" },
				{
					label: "Custom approach",
					value: "custom",
					opensEditor: true,
					editorPreFill: "describe your approach",
				},
				{ label: "Skip", value: "skip" },
			],
		});
		ctx.ui.notify(formatResult(result), "info");
	});

	// /test-tabs — TabStrip + prompt(tabbed)
	ctx.registerCommand("/test-tabs", "Test tabbed prompt", async () => {
		const sharedActions = [
			{ key: "a", label: "Approve" },
			{ key: "r", label: "Reject" },
		];

		const result = await prompt(ctx, {
			items: [
				{
					label: "T1",
					content: staticContent(["First tab"]),
					actions: sharedActions,
				},
				{
					label: "T2",
					content: staticContent(["Second tab"]),
					actions: sharedActions,
				},
				{
					label: "T3",
					content: staticContent(["Third tab — options"]),
					options: [
						{ label: "Option A", value: "a" },
						{ label: "Option B", value: "b" },
					],
				},
				{
					label: "T4",
					content: staticContent(["Fourth tab"]),
					actions: sharedActions,
				},
				{
					label: "T5",
					content: numberedLines(30),
					actions: sharedActions,
				},
			],
			canAddItems: true,
			autoResolve: false,
		});
		ctx.ui.notify(formatTabbedResult(result), "info");
	});

	// /test-steer — Steer annotations
	ctx.registerCommand("/test-steer", "Test steer annotations", async () => {
		const result = await prompt(ctx, {
			content: staticContent(["Test steer annotations on actions."]),
			actions: [
				{ key: "a", label: "Approve" },
				{ key: "r", label: "Reject" },
			],
		});
		if (result === null) {
			ctx.ui.notify("cancelled", "info");
		} else {
			ctx.ui.notify(
				`type: ${result.type}, ${JSON.stringify(result, null, 2)}`,
				"info",
			);
		}
	});

	// /test-editor — NoteEditor via opensEditor
	ctx.registerCommand("/test-editor", "Test inline editor", async () => {
		const result = await prompt(ctx, {
			content: staticContent(["Test the inline editor."]),
			options: [
				{ label: "Write something", value: "write", opensEditor: true },
				{
					label: "Pre-filled",
					value: "prefill",
					opensEditor: true,
					editorPreFill: "edit this text",
				},
				{ label: "Plain option", value: "plain" },
			],
		});
		ctx.ui.notify(formatResult(result), "info");
	});

	// /test-markdown — renderMarkdown via view()
	ctx.registerCommand("/test-markdown", "Test markdown rendering", async () => {
		await view(ctx, {
			title: "Markdown Rendering",
			content: (theme, width) => renderMarkdown(MARKDOWN_SAMPLE, theme, width),
		});
		ctx.ui.notify("markdown test dismissed", "info");
	});

	// /test-code — renderCode via view()
	ctx.registerCommand("/test-code", "Test code rendering", async () => {
		await view(ctx, {
			title: "Code Rendering",
			content: (theme, width) =>
				renderCode(CODE_SAMPLE, theme, width, {
					startLine: 10,
					highlightLines: new Set([15, 18]),
					language: "typescript",
				}),
		});
		ctx.ui.notify("code test dismissed", "info");
	});

	// /test-diff — renderDiff via view()
	ctx.registerCommand("/test-diff", "Test diff rendering", async () => {
		await view(ctx, {
			title: "Diff Rendering",
			content: (theme, width) => renderDiff(DIFF_SAMPLE, theme, width),
		});
		ctx.ui.notify("diff test dismissed", "info");
	});
}
