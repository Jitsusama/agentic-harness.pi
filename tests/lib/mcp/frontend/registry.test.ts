import { describe, expect, it } from "vitest";
import { createFrontEndRegistry } from "../../../../lib/mcp/frontend/registry.js";
import type {
	FrontEndProvider,
	ResolvedFrontEnd,
} from "../../../../lib/mcp/frontend/types.js";
import { defaultBackendOf } from "../../../../lib/mcp/surface/policy.js";
import type { McpTool } from "../../../../lib/mcp/types.js";

// Sentinels: the resolver returns whichever hook won, so we detect the winner
// by identity rather than by invoking it.
const DEFAULTS: ResolvedFrontEnd = {
	shape: () => [],
	renderCall: (() => ({})) as unknown as ResolvedFrontEnd["renderCall"],
	renderResult: (() => ({})) as unknown as ResolvedFrontEnd["renderResult"],
	wrap: (() =>
		(async () => ({
			content: [],
			details: undefined,
		})) as never) as ResolvedFrontEnd["wrap"],
};

function registry() {
	return createFrontEndRegistry({
		backendOf: defaultBackendOf,
		defaults: DEFAULTS,
	});
}

function tool(name: string, serverId = "s"): McpTool {
	return {
		serverId,
		name,
		description: "",
		inputSchema: { type: "object" },
		raw: {},
	};
}

function provider(
	id: string,
	match: FrontEndProvider["match"],
	extra: Partial<FrontEndProvider> = {},
): FrontEndProvider {
	return {
		serverId: "s",
		providerId: id,
		match,
		shape: () => [{ type: "text", text: id }],
		...extra,
	};
}

describe("createFrontEndRegistry", () => {
	it("falls back to the defaults when nothing matches", () => {
		const r = registry();
		expect(r.resolve(tool("slack_post")).shape).toBe(DEFAULTS.shape);
	});

	it("prefers an exact tool match over a glob, backend, or predicate", () => {
		const r = registry();
		r.register(provider("pred", { kind: "predicate", test: () => true }));
		r.register(provider("backend", { kind: "backend", backend: "slack" }));
		r.register(provider("glob", { kind: "glob", pattern: "slack_*" }));
		r.register(provider("exact", { kind: "tool", name: "slack_post" }));
		expect(
			r
				.resolve(tool("slack_post"))
				.shape({ content: [] } as never, tool("slack_post")),
		).toEqual([{ type: "text", text: "exact" }]);
	});

	it("ranks backend above predicate", () => {
		const r = registry();
		r.register(provider("pred", { kind: "predicate", test: () => true }));
		r.register(provider("backend", { kind: "backend", backend: "slack" }));
		expect(
			r
				.resolve(tool("slack_post"))
				.shape({ content: [] } as never, tool("slack_post")),
		).toEqual([{ type: "text", text: "backend" }]);
	});

	it("prefers the glob with more literal characters", () => {
		const r = registry();
		r.register(provider("short", { kind: "glob", pattern: "s*" }));
		r.register(provider("long", { kind: "glob", pattern: "slack_*" }));
		expect(
			r
				.resolve(tool("slack_post"))
				.shape({ content: [] } as never, tool("slack_post")),
		).toEqual([{ type: "text", text: "long" }]);
	});

	it("breaks a specificity tie by priority then providerId", () => {
		const r = registry();
		r.register(
			provider("a", { kind: "backend", backend: "slack" }, { priority: 1 }),
		);
		r.register(
			provider("b", { kind: "backend", backend: "slack" }, { priority: 5 }),
		);
		expect(
			r
				.resolve(tool("slack_post"))
				.shape({ content: [] } as never, tool("slack_post")),
		).toEqual([{ type: "text", text: "b" }]);
	});

	it("resolves each hook independently to its own winner", () => {
		const r = registry();
		const callFn = (() => ({})) as unknown as NonNullable<
			FrontEndProvider["renderCall"]
		>;
		r.register(
			provider(
				"exact",
				{ kind: "tool", name: "slack_post" },
				{ shape: undefined, renderCall: callFn },
			),
		);
		r.register(provider("glob", { kind: "glob", pattern: "slack_*" }));
		const resolved = r.resolve(tool("slack_post"));
		// renderCall comes from the exact provider; shape from the glob provider; wrap from defaults.
		expect(resolved.renderCall).toBe(callFn);
		expect(
			resolved.shape({ content: [] } as never, tool("slack_post")),
		).toEqual([{ type: "text", text: "glob" }]);
		expect(resolved.wrap).toBe(DEFAULTS.wrap);
	});

	it("replaces a provider registered under the same key", () => {
		const r = registry();
		r.register(provider("dup", { kind: "backend", backend: "slack" }));
		r.register(
			provider(
				"dup",
				{ kind: "backend", backend: "slack" },
				{ shape: () => [{ type: "text", text: "v2" }] },
			),
		);
		expect(r.list()).toHaveLength(1);
		expect(
			r
				.resolve(tool("slack_post"))
				.shape({ content: [] } as never, tool("slack_post")),
		).toEqual([{ type: "text", text: "v2" }]);
	});

	it("drops a provider on unregister", () => {
		const r = registry();
		r.register(provider("g", { kind: "glob", pattern: "slack_*" }));
		r.unregister("s", "g");
		expect(r.resolve(tool("slack_post")).shape).toBe(DEFAULTS.shape);
	});

	it("does not match a provider bound to another server", () => {
		const r = registry();
		r.register({
			...provider("g", { kind: "glob", pattern: "slack_*" }),
			serverId: "other",
		});
		expect(r.resolve(tool("slack_post", "s")).shape).toBe(DEFAULTS.shape);
	});
});
