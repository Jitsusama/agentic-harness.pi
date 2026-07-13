import { describe, expect, it } from "vitest";
import {
	buildDiscoverySections,
	type DiscoveryEntry,
	modeBadge,
	renderToolDiscovery,
} from "../../../../lib/mcp/render/tools-list.js";

function entry(
	name: string,
	backend: string,
	mode: DiscoveryEntry["mode"],
): DiscoveryEntry {
	return { name, backend, mode };
}

describe("modeBadge", () => {
	it("labels progressive and direct, and leaves disabled unbadged", () => {
		expect(modeBadge("progressive")).toBe("[progressive]");
		expect(modeBadge("direct")).toBe("[direct]");
		expect(modeBadge("disabled")).toBe("");
	});
});

describe("buildDiscoverySections", () => {
	it("groups entries into backend sections sorted by backend then tool name", () => {
		const sections = buildDiscoverySections([
			entry("slack_post", "slack", "direct"),
			entry("gws_docs_read", "gws", "progressive"),
			entry("slack_read", "slack", "direct"),
		]);
		expect(sections.map((s) => s.backend)).toEqual(["gws", "slack"]);
		expect(sections[1].tools.map((t) => t.name)).toEqual([
			"slack_post",
			"slack_read",
		]);
	});

	it("attaches a backend hint when one is supplied", () => {
		const sections = buildDiscoverySections(
			[entry("observe_query", "observe", "progressive")],
			{
				hints: { observe: "Logs, traces, metrics." },
			},
		);
		expect(sections[0].hint).toBe("Logs, traces, metrics.");
	});

	it("folds tools beyond the per-backend limit into an overflow count", () => {
		const entries = Array.from({ length: 5 }, (_, i) =>
			entry(`gws_t${i}`, "gws", "direct"),
		);
		const [section] = buildDiscoverySections(entries, { perBackendLimit: 2 });
		expect(section.tools).toHaveLength(2);
		expect(section.overflow).toBe(3);
	});

	it("reports no overflow when under the limit", () => {
		const [section] = buildDiscoverySections(
			[entry("slack_post", "slack", "direct")],
			{ perBackendLimit: 2 },
		);
		expect(section.overflow).toBe(0);
	});
});

describe("renderToolDiscovery", () => {
	it("formats sections as markdown with a header, badged tools and an overflow line", () => {
		const entries = [
			entry("observe_query", "observe", "progressive"),
			entry("observe_logs", "observe", "progressive"),
			entry("observe_traces", "observe", "progressive"),
		];
		const sections = buildDiscoverySections(entries, {
			perBackendLimit: 2,
			hints: { observe: "Logs and traces." },
		});
		const md = renderToolDiscovery(sections);
		expect(md).toContain("observe (3 tools)");
		expect(md).toContain("Logs and traces.");
		expect(md).toContain("observe_logs [progressive]");
		expect(md).toContain("1 more");
	});
});
