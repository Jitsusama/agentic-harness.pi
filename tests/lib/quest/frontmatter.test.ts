import { describe, expect, it } from "vitest";
import {
	parseDocumentFrontMatter,
	parseQuestFrontMatter,
	serializeDocumentFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/internal/quest/frontmatter";
import type {
	DocumentFrontMatter,
	QuestFrontMatter,
} from "../../../lib/quest/types";

const SAMPLE_QUEST_FM: QuestFrontMatter = {
	id: "QEST-20260603-AAA111",
	kind: "sidequest",
	parent: "QEST-20260601-PPP000",
	status: "active",
	priority: "driving",
	rank: 1,
	started: "2026-06-03",
	updated: "2026-06-04",
	due: "2026-08-01",
	eta: "2026-07-15",
	aliases: [
		{ type: "github-issue", value: "shop/world#47281" },
		{ type: "slack-thread", value: "shopify/CXXXX/p1778683833000200" },
	],
	sessions: [
		{
			id: "abc-def-ghi",
			name: "investigation",
			cwd: "/Users/joel/world",
			started: "2026-06-03T18:14:00Z",
			status: "active",
		},
		{ id: "jkl-mno-pqr", status: "detached" },
	],
};

describe("quest front-matter", () => {
	it("round-trips through serialize and parse", () => {
		const text = `${serializeQuestFrontMatter(SAMPLE_QUEST_FM)}\n# Title\n`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(SAMPLE_QUEST_FM);
	});

	it("omits due and eta when not set", () => {
		const fm: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			aliases: [],
			sessions: [],
		};
		delete fm.due;
		delete fm.eta;
		const text = `${serializeQuestFrontMatter(fm)}\n`;
		expect(text).not.toMatch(/^due:/m);
		expect(text).not.toMatch(/^eta:/m);
		const parsed = parseQuestFrontMatter(`${text}# x`);
		expect(parsed?.frontMatter.due).toBeUndefined();
		expect(parsed?.frontMatter.eta).toBeUndefined();
	});

	it("encodes a null parent as the literal `null`", () => {
		const fm: QuestFrontMatter = { ...SAMPLE_QUEST_FM, parent: null };
		const text = serializeQuestFrontMatter(fm);
		expect(text).toMatch(/^parent: null$/m);
		const parsed = parseQuestFrontMatter(`${text}\n# x`);
		expect(parsed?.frontMatter.parent).toBeNull();
	});

	it("serializes empty lists as `[]`", () => {
		const fm: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			aliases: [],
			sessions: [],
		};
		const text = serializeQuestFrontMatter(fm);
		expect(text).toMatch(/aliases: \[\s*\]/);
		expect(text).toMatch(/sessions: \[\s*\]/);
	});

	it("round-trips trees and pendingPrune when present", () => {
		const fm: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			trees: [
				{
					path: "/Users/joel/src/world/.worktrees/feature-x",
					branch: "feature-x",
					repoRoot: "/Users/joel/src/world",
					providerId: "git-worktree",
				},
				{
					path: "/Users/joel/world/trees/49736-mirror-retry-api",
					branch: "49736-mirror-retry-api",
					repoRoot: "/Users/joel/world",
					providerId: "dev-tree",
					zones: ["system/gitstream", "system/mirror"],
				},
			],
			pendingPrune: [
				{
					path: "/Users/joel/src/world/.worktrees/old",
					reason: "dirty",
					detectedAt: "2026-06-03T19:00:00Z",
				},
				{
					path: "/Users/joel/src/world/.worktrees/older",
					reason: "unmerged",
					detectedAt: "2026-06-04T08:00:00Z",
				},
			],
		};
		const text = `${serializeQuestFrontMatter(fm)}\n# Title\n`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(fm);
	});

	it("reads a legacy scalar pendingPrune as a one-entry array", () => {
		const legacy = [
			"---",
			"id: QEST-20260603-AAA111",
			"kind: quest",
			"parent: null",
			"status: active",
			"priority: active",
			"rank: 1",
			"started: 2026-06-03",
			"updated: 2026-06-04",
			"aliases: []",
			"sessions: []",
			"pendingPrune:",
			"  path: /tmp/x",
			"  reason: dirty",
			"  detectedAt: 2026-06-03T19:00:00Z",
			"---",
			"# Title",
		].join("\n");
		const parsed = parseQuestFrontMatter(legacy);
		expect(parsed?.frontMatter.pendingPrune).toEqual([
			{
				path: "/tmp/x",
				reason: "dirty",
				detectedAt: "2026-06-03T19:00:00Z",
			},
		]);
	});

	it("omits trees and pendingPrune when absent", () => {
		const text = serializeQuestFrontMatter(SAMPLE_QUEST_FM);
		expect(text).not.toContain("trees:");
		expect(text).not.toContain("pendingPrune:");
	});

	it("accepts a session id given as a bare string", () => {
		const text = [
			"---",
			"id: QEST-20260603-AAA111",
			"kind: sidequest",
			"parent: null",
			"status: active",
			"priority: driving",
			"rank: 1",
			"started: 2026-06-03",
			"updated: 2026-06-04",
			"aliases: []",
			"sessions:",
			"  - abc-def-ghi",
			"---",
			"",
			"# x",
		].join("\n");
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter.sessions).toEqual([{ id: "abc-def-ghi" }]);
	});

	it("returns undefined for missing front-matter", () => {
		expect(parseQuestFrontMatter("just a body, no fence")).toBeUndefined();
	});

	it("returns undefined when required scalars are missing", () => {
		const text = ["---", "id: QEST-20260603-AAA111", "---"].join("\n");
		expect(parseQuestFrontMatter(text)).toBeUndefined();
	});

	it("returns undefined when an enum value is unrecognised", () => {
		const text = `${serializeQuestFrontMatter({
			...SAMPLE_QUEST_FM,
			// biome-ignore lint/suspicious/noExplicitAny: deliberate cast to invalid value
		} as any).replace("status: active", "status: napping")}\n# x`;
		expect(parseQuestFrontMatter(text)).toBeUndefined();
	});

	it("preserves body content after the closing fence", () => {
		const text = `${serializeQuestFrontMatter(SAMPLE_QUEST_FM)}\n# Title\n\nSummary text.`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.body).toBe("# Title\n\nSummary text.");
	});
});

describe("document front-matter", () => {
	const SAMPLE: DocumentFrontMatter = {
		id: "PLAN-20260603-BBB222",
		kind: "plan",
		quest: "QEST-20260603-AAA111",
		stage: "draft",
		updated: "2026-06-03",
	};

	it("round-trips", () => {
		const text = `${serializeDocumentFrontMatter(SAMPLE)}\n# Plan title\n`;
		const parsed = parseDocumentFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(SAMPLE);
	});

	it("returns undefined for missing fields", () => {
		const text = ["---", "id: PLAN-x", "kind: plan", "---"].join("\n");
		expect(parseDocumentFrontMatter(text)).toBeUndefined();
	});

	it("round-trips the rounds and subject markers", () => {
		const fm: DocumentFrontMatter = {
			...SAMPLE,
			rounds: 3,
			subject: "pr-review",
		};
		const text = `${serializeDocumentFrontMatter(fm)}\n# Plan title\n`;
		const parsed = parseDocumentFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(fm);
	});
});

describe("frontmatter parser failure branches", () => {
	it("returns undefined when the YAML block is malformed", () => {
		const text = [
			"---",
			"id: QEST-20260603-AAA111",
			"  bad: [unterminated",
			"---",
			"# Title",
		].join("\n");
		expect(parseQuestFrontMatter(text)).toBeUndefined();
	});

	it("returns undefined when the YAML root is an array", () => {
		const text = ["---", "- one", "- two", "---", "# Title"].join("\n");
		expect(parseQuestFrontMatter(text)).toBeUndefined();
	});

	it("returns undefined when the YAML root is a scalar", () => {
		const text = ["---", "42", "---", "# Title"].join("\n");
		expect(parseQuestFrontMatter(text)).toBeUndefined();
	});

	it("coerces a numeric rank from a string", () => {
		const base = serializeQuestFrontMatter(SAMPLE_QUEST_FM);
		const text = `${base.replace("rank: 1", 'rank: "7"')}\n# Title`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter.rank).toBe(7);
	});

	it("rejects NaN ranks", () => {
		const base = serializeQuestFrontMatter(SAMPLE_QUEST_FM);
		const text = `${base.replace("rank: 1", "rank: not-a-number")}\n# Title`;
		expect(parseQuestFrontMatter(text)).toBeUndefined();
	});

	it("accepts the bare `type:value` form for an alias", () => {
		const text = [
			"---",
			"id: QEST-20260603-AAA111",
			"kind: quest",
			"parent: null",
			"status: active",
			"priority: active",
			"rank: 1",
			"started: 2026-06-03",
			"updated: 2026-06-03",
			"aliases:",
			"  - github-pr:shop/world#1",
			"sessions: []",
			"---",
			"# Title",
		].join("\n");
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter.aliases).toEqual([
			{ type: "github-pr", value: "shop/world#1" },
		]);
	});

	it("preserves unknown top-level keys across a round-trip", () => {
		const base = serializeQuestFrontMatter(SAMPLE_QUEST_FM);
		const text = `${base.replace(/^---\n/, "---\ncustomField: hello\nlabels:\n  - x\n  - y\n")}\n# Title`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter._extra).toEqual({
			customField: "hello",
			labels: ["x", "y"],
		});
		const rendered = serializeQuestFrontMatter(parsed?.frontMatter as never);
		expect(rendered).toContain("customField: hello");
		expect(rendered).toContain("- x");
	});
});
