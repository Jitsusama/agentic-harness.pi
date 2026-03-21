/**
 * Test harness: registers /test-* commands that exercise
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

/** Format a single PromptResult for notify output. */
function formatResult(result: PromptResult | null): string {
	if (result === null) return "cancelled";
	if (result.type === "redirect") return `redirect: ${result.note}`;
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

const WIDE_CODE_SAMPLE = `// This file tests horizontal scrolling with lines that far exceed the terminal width
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, basename, extname, dirname, normalize, isAbsolute } from "path";

interface VeryDetailedConfigurationWithAnExtremelyLongTypeName {
  serverHostname: string;  serverPort: number;  enableDebugMode: boolean;  maxConcurrentConnections: number;  requestTimeoutMilliseconds: number;  corsAllowedOrigins: string[];
}

const DEFAULT_CONFIG: VeryDetailedConfigurationWithAnExtremelyLongTypeName = { serverHostname: "0.0.0.0", serverPort: 8080, enableDebugMode: false, maxConcurrentConnections: 100, requestTimeoutMilliseconds: 30000, corsAllowedOrigins: ["http://localhost:3000", "https://example.com", "https://staging.example.com"] };

export function processIncomingRequestAndReturnFormattedResponseWithDetailedLogging(request: IncomingMessage, response: ServerResponse, config: VeryDetailedConfigurationWithAnExtremelyLongTypeName): Promise<void> {
  const startTime = performance.now(); const method = request.method ?? "GET"; const url = request.url ?? "/"; const headers = JSON.stringify(request.headers);
  console.log(\`[\${new Date().toISOString()}] \${method} \${url} headers=\${headers} config.debug=\${config.enableDebugMode} config.timeout=\${config.requestTimeoutMilliseconds}ms\`);
  return new Promise((resolve) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "ok", elapsed: performance.now() - startTime })); resolve(); });
}
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

export default function testHarness(ctx: ExtensionContext) {
	// /test-scroll: ScrollRegion + view()
	ctx.registerCommand("test-scroll", {
		description: "Test scroll region",
		handler: async (_args, handlerCtx) => {
			await view(handlerCtx, {
				title: "Scroll Test",
				content: numberedLines(50),
			});
			handlerCtx.ui.notify("scroll test dismissed", "info");
		},
	});

	// /test-actions: ActionBar + prompt(single)
	ctx.registerCommand("test-actions", {
		description: "Test action bar",
		handler: async (_args, handlerCtx) => {
			const result = await prompt(handlerCtx, {
				content: (theme, _width) => [
					` ${theme.fg("accent", theme.bold("Action Bar Test"))}`,
					"",
					"  This tests the action bar.",
					"  Try each action key.",
					"  Shift+key to annotate.",
				],
				actions: [
					{ key: "a", label: "Approve" },
					{ key: "r", label: "Reject" },
					{ key: "d", label: "Defer" },
				],
			});
			handlerCtx.ui.notify(formatResult(result), "info");
		},
	});

	// /test-options: OptionList + prompt(single)
	ctx.registerCommand("test-options", {
		description: "Test option list",
		handler: async (_args, handlerCtx) => {
			const result = await prompt(handlerCtx, {
				content: (theme, _width) => [
					` ${theme.fg("accent", theme.bold("Option List Test"))}`,
					"",
					"  Pick an option.",
					"  Descriptions show on the selected item only.",
				],
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
			handlerCtx.ui.notify(formatResult(result), "info");
		},
	});

	// /test-tabs: TabStrip + prompt(tabbed)
	ctx.registerCommand("test-tabs", {
		description: "Test tabbed prompt",
		handler: async (_args, handlerCtx) => {
			const sharedActions = [
				{ key: "a", label: "Approve" },
				{ key: "r", label: "Reject" },
			];

			const result = await prompt(handlerCtx, {
				items: [
					{
						label: "Actions",
						content: staticContent(["First tab: basic actions"]),
						actions: sharedActions,
					},
					{
						label: "Also Actions",
						content: staticContent(["Second tab: same actions"]),
						actions: sharedActions,
					},
					{
						label: "Options",
						content: staticContent(["Third tab: option list"]),
						options: [
							{ label: "Option A", value: "a" },
							{ label: "Option B", value: "b" },
						],
					},
					{
						label: "More Actions",
						content: staticContent(["Fourth tab: more actions"]),
						actions: sharedActions,
					},
					{
						label: "Scroll",
						content: numberedLines(30),
						actions: sharedActions,
					},
				],
				canAddItems: true,
				autoResolve: false,
			});
			handlerCtx.ui.notify(formatTabbedResult(result), "info");
		},
	});

	// /test-redirect: Redirect annotations
	ctx.registerCommand("test-redirect", {
		description: "Test redirect annotations",
		handler: async (_args, handlerCtx) => {
			const result = await prompt(handlerCtx, {
				content: (theme, _width) => [
					` ${theme.fg("accent", theme.bold("Redirect Annotations Test"))}`,
					"",
					"  Test redirect annotations on actions.",
				],
				actions: [
					{ key: "a", label: "Approve" },
					{ key: "r", label: "Reject" },
				],
			});
			if (result === null) {
				handlerCtx.ui.notify("cancelled", "info");
			} else {
				handlerCtx.ui.notify(
					`type: ${result.type}, ${JSON.stringify(result, null, 2)}`,
					"info",
				);
			}
		},
	});

	// /test-editor: NoteEditor via opensEditor
	ctx.registerCommand("test-editor", {
		description: "Test inline editor",
		handler: async (_args, handlerCtx) => {
			const result = await prompt(handlerCtx, {
				content: (theme, _width) => [
					` ${theme.fg("accent", theme.bold("Inline Editor Test"))}`,
					"",
					"  Test the inline editor.",
				],
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
			handlerCtx.ui.notify(formatResult(result), "info");
		},
	});

	// /test-markdown: renderMarkdown via view()
	ctx.registerCommand("test-markdown", {
		description: "Test markdown rendering",
		handler: async (_args, handlerCtx) => {
			await view(handlerCtx, {
				title: "Markdown Rendering",
				content: (theme, width) =>
					renderMarkdown(MARKDOWN_SAMPLE, theme, width),
			});
			handlerCtx.ui.notify("markdown test dismissed", "info");
		},
	});

	// /test-code: renderCode via view()
	ctx.registerCommand("test-code", {
		description: "Test code rendering",
		handler: async (_args, handlerCtx) => {
			await view(handlerCtx, {
				title: "Code Rendering",
				content: (theme, width) =>
					renderCode(CODE_SAMPLE, theme, width, {
						startLine: 10,
						highlightLines: new Set([15, 18]),
						language: "typescript",
					}),
				allowHScroll: true,
			});
			handlerCtx.ui.notify("code test dismissed", "info");
		},
	});

	// /test-diff: renderDiff via view()
	ctx.registerCommand("test-diff", {
		description: "Test diff rendering",
		handler: async (_args, handlerCtx) => {
			await view(handlerCtx, {
				title: "Diff Rendering",
				content: (theme, width) => renderDiff(DIFF_SAMPLE, theme, width),
				allowHScroll: true,
			});
			handlerCtx.ui.notify("diff test dismissed", "info");
		},
	});

	// /test-hscroll: horizontal scrolling with wide code
	ctx.registerCommand("test-hscroll", {
		description: "Test horizontal scrolling",
		handler: async (_args, handlerCtx) => {
			await view(handlerCtx, {
				title: "Horizontal Scroll Test",
				content: (theme, width) =>
					renderCode(WIDE_CODE_SAMPLE, theme, width, {
						highlightLines: new Set([6, 10]),
						language: "typescript",
					}),
				allowHScroll: true,
			});
			handlerCtx.ui.notify("hscroll test dismissed", "info");
		},
	});
}
