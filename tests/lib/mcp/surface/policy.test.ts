import { describe, expect, it } from "vitest";
import {
	defaultBackendOf,
	resolveToolMode,
	type SurfaceConfig,
} from "../../../../lib/mcp/surface/policy.js";
import type { McpTool } from "../../../../lib/mcp/types.js";

function tool(name: string): McpTool {
	return {
		serverId: "s",
		name,
		description: "",
		inputSchema: { type: "object" },
		raw: {},
	};
}

function config(overrides: Partial<SurfaceConfig> = {}): SurfaceConfig {
	return {
		include: [],
		exclude: [],
		progressive: [],
		direct: [],
		progressiveHints: {},
		autoProgressiveThreshold: 10,
		autoProgressive: true,
		...overrides,
	};
}

describe("defaultBackendOf", () => {
	it("groups by the first underscore-delimited token", () => {
		expect(defaultBackendOf("slack_search_public")).toBe("slack");
	});

	it("falls back to a misc bucket for a single-token name", () => {
		expect(defaultBackendOf("ping")).toBe("ping");
		expect(defaultBackendOf("")).toBe("(misc)");
	});
});

describe("resolveToolMode", () => {
	const backendOf = defaultBackendOf;

	it("disables a tool matched by an exclude glob, even against include", () => {
		const cfg = config({ include: ["gws_*"], exclude: ["gws_calendar_*"] });
		expect(
			resolveToolMode(tool("gws_calendar_create"), cfg, [], backendOf),
		).toBe("disabled");
	});

	it("treats a non-empty include as an allow-list", () => {
		const cfg = config({ include: ["gws_*"] });
		expect(resolveToolMode(tool("slack_post"), cfg, [], backendOf)).toBe(
			"disabled",
		);
		expect(resolveToolMode(tool("gws_docs_read"), cfg, [], backendOf)).toBe(
			"direct",
		);
	});

	it("defaults an enabled tool to direct when nothing forces progressive", () => {
		expect(resolveToolMode(tool("slack_post"), config(), [], backendOf)).toBe(
			"direct",
		);
	});

	it("hides a tool behind helpers when its backend is listed progressive", () => {
		const cfg = config({ progressive: ["observe"] });
		expect(resolveToolMode(tool("observe_query"), cfg, [], backendOf)).toBe(
			"progressive",
		);
	});

	it("lets an explicit direct pattern beat a progressive match", () => {
		const cfg = config({ progressive: ["slack"], direct: ["slack_post"] });
		expect(resolveToolMode(tool("slack_post"), cfg, [], backendOf)).toBe(
			"direct",
		);
	});

	it("auto-hides a backend that exceeds the threshold", () => {
		const many = Array.from({ length: 11 }, (_, i) => tool(`gws_t${i}`));
		expect(resolveToolMode(many[0], config(), many, backendOf)).toBe(
			"progressive",
		);
	});

	it("does not auto-hide a backend at or below the threshold", () => {
		const some = Array.from({ length: 10 }, (_, i) => tool(`gws_t${i}`));
		expect(resolveToolMode(some[0], config(), some, backendOf)).toBe("direct");
	});

	it("does not auto-hide when autoProgressive is off", () => {
		const many = Array.from({ length: 11 }, (_, i) => tool(`gws_t${i}`));
		expect(
			resolveToolMode(
				many[0],
				config({ autoProgressive: false }),
				many,
				backendOf,
			),
		).toBe("direct");
	});

	it("counts only enabled tools toward the auto threshold", () => {
		const many = Array.from({ length: 11 }, (_, i) => tool(`gws_t${i}`));
		const cfg = config({ exclude: ["gws_t1*"] });
		// Excluding gws_t1 and gws_t10 leaves 9 enabled, below the threshold.
		expect(resolveToolMode(many[0], cfg, many, backendOf)).toBe("direct");
	});

	it("groups the auto count by the injected backendOf", () => {
		// A backendOf that lumps two prefixes together crosses the threshold
		// where the default first-token split would not.
		const tools = [
			...Array.from({ length: 6 }, (_, i) => tool(`alpha_a${i}`)),
			...Array.from({ length: 6 }, (_, i) => tool(`beta_b${i}`)),
		];
		const lump = (name: string) =>
			name.startsWith("alpha_") || name.startsWith("beta_")
				? "grp"
				: defaultBackendOf(name);
		expect(resolveToolMode(tools[0], config(), tools, lump)).toBe(
			"progressive",
		);
		expect(resolveToolMode(tools[0], config(), tools, defaultBackendOf)).toBe(
			"direct",
		);
	});
});
