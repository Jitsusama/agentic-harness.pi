/**
 * Tools a session seldom needs are loaded when it needs them: pi's
 * `tool_search` is turned on, an index says what can be loaded, and
 * reading a skill that names some of them loads them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import loadoutWorkflow, {
	INDEX_SECTION,
} from "../../../extensions/loadout-workflow/index.ts";
import {
	type LoadableTool,
	loadableIndex,
	namedIn,
} from "../../../extensions/loadout-workflow/loadable.ts";

const BROWSER = { name: "browser", description: "Drive a real browser." };

const TOOLS: LoadableTool[] = [
	{ name: "bash", description: "Run a command.", exposure: "direct" },
	{
		name: "browser_go",
		description: "Go somewhere.",
		exposure: "deferred",
		namespace: BROWSER,
	},
	{
		name: "browser_see",
		description: "Read a page.",
		exposure: "deferred",
		namespace: BROWSER,
	},
	{
		name: "render_mermaid",
		description:
			"Render Mermaid diagram source to a crisp SVG plus a PNG, and answer with both paths. More.",
		exposure: "deferred",
	},
	{ name: "tool_search", description: "Search tools.", exposure: "model-only" },
];

type Handler = (event: unknown, ctx: unknown) => unknown;

function activate(active: string[]) {
	const handlers = new Map<string, Handler>();
	let declared = [...active];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		getAllTools: () => TOOLS,
		getActiveTools: () => [...declared],
		setActiveTools: (names: string[]) => {
			declared = [...new Set(names)];
		},
	};
	loadoutWorkflow(pi as unknown as ExtensionAPI);
	const fire = (name: string, event: unknown) =>
		handlers.get(name)?.(event, {});
	return { fire, declared: () => declared };
}

describe("the index of tools that load on demand", () => {
	it("names a namespace once with its tools, and any other tool by its purpose", () => {
		const index = loadableIndex(TOOLS.filter((t) => t.exposure === "deferred"));

		expect(index).toContain(
			"- browser (Drive a real browser): browser_go, browser_see",
		);
		expect(index).toContain(
			"- render_mermaid: Render Mermaid diagram source to a crisp SVG plus a PNG, and answer wit…",
		);
		expect(index).toContain("tool_search");
	});

	it("says a large namespace as a count and its areas, not every name", () => {
		const gateway = { name: "mcp__gw" };
		const many: LoadableTool[] = Array.from({ length: 30 }, (_, i) => ({
			name: `mcp__gw__${i % 2 ? "github" : "vault"}_tool_${i}`,
			description: "A tool.",
			exposure: "deferred",
			namespace: gateway,
		}));

		const index = loadableIndex(many);

		expect(index).toContain(
			"- mcp__gw: 30 tools, covering vault, github. Find one with `tool_search`.",
		);
		expect(index).not.toContain("mcp__gw__vault_tool_0");
	});

	it("says nothing when nothing is deferred", () => {
		expect(loadableIndex([])).toBeUndefined();
	});

	it("is a prompt section of its own, the same on every run", async () => {
		const { fire } = activate(["bash"]);
		const run = async () => {
			const sections: Record<string, string> = {};
			const returned = await fire("before_agent_start", {
				systemPromptOptions: { sections },
			});
			return { section: sections[INDEX_SECTION], returned };
		};

		const first = await run();
		const second = await run();

		expect(first.section).toContain("browser_go");
		expect(second.section).toBe(first.section);
		expect(first.returned).toBeUndefined();
	});
});

describe("loading what a skill names", () => {
	it("loads a named tool with the rest of its namespace", () => {
		expect(namedIn("Call `browser_go` first.", TOOLS)).toEqual([
			"browser_go",
			"browser_see",
		]);
	});

	it("matches whole names only", () => {
		expect(namedIn("my_browser_gone and render_mermaids", TOOLS)).toEqual([]);
	});

	it("declares them when the skill is read, and says so", async () => {
		const { fire, declared } = activate(["bash", "read"]);

		const result = (await fire("tool_result", {
			toolName: "read",
			input: { path: "/skills/browser-guide/SKILL.md" },
			content: [{ type: "text", text: "Use browser_see to read a page." }],
			isError: false,
		})) as { content: { text: string }[] };

		expect(declared()).toEqual(["bash", "read", "browser_go", "browser_see"]);
		expect(result.content.at(-1)?.text).toContain(
			"Loaded for this session, since this skill uses them: browser_go, browser_see.",
		);
	});

	it("leaves any other read alone", async () => {
		const { fire, declared } = activate(["bash", "read"]);

		const result = await fire("tool_result", {
			toolName: "read",
			input: { path: "/src/browser.ts" },
			content: [{ type: "text", text: "browser_go" }],
			isError: false,
		});

		expect(result).toBeUndefined();
		expect(declared()).toEqual(["bash", "read"]);
	});
});

describe("turning tool_search on", () => {
	it("declares tool_search at the start of a session", async () => {
		const { fire, declared } = activate(["bash"]);

		await fire("session_start", {});

		expect(declared()).toEqual(["bash", "tool_search"]);
	});
});
