import { describe, expect, it } from "vitest";
import {
	parseDocumentFrontMatter,
	parseQuestFrontMatter,
	serializeDocumentFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/internal/quest/documents/frontmatter.ts";
import type {
	DocumentFrontMatter,
	QuestFrontMatter,
} from "../../../lib/quest/types.ts";

/**
 * A shape with every field made required, nested ones included, so a
 * fixture typed with it must set each field at every depth.
 */
// An array must hold at least one entry, so an empty one can't stand in
// for the fields its entries carry.
type EveryField<T> = T extends readonly (infer U)[]
	? [EveryField<U>, ...EveryField<U>[]]
	: T extends object
		? { [K in keyof T]-?: EveryField<T[K]> }
		: T;

const SAMPLE_QUEST_FM = {
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
} satisfies QuestFrontMatter;

const SESSION_WITH_IDENTITY: QuestFrontMatter = {
	...SAMPLE_QUEST_FM,
	aliases: [],
	sessions: [
		{
			id: "live-session",
			status: "active",
			instanceId: "inst-42",
			process: {
				hostId: "host-a",
				pid: 4321,
				startToken: "Sat Jul 12",
				bootToken: "3152D2B4-B508-4118-BDE5-7804CA87C255",
				startTicks: 123_456,
			},
			terminal: {
				driverId: "wezterm",
				value: "7",
				scope: "/sock/gui-1",
				hostId: "host-a",
			},
		},
	],
};

describe("quest front-matter", () => {
	it("round-trips through serialize and parse", () => {
		const text = `${serializeQuestFrontMatter(SAMPLE_QUEST_FM)}\n# Title\n`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(SAMPLE_QUEST_FM);
	});

	it("round-trips a session's captured liveness identity", () => {
		const text = `${serializeQuestFrontMatter(SESSION_WITH_IDENTITY)}\n# Title\n`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter.sessions).toEqual(
			SESSION_WITH_IDENTITY.sessions,
		);
	});

	it("drops a session's start ticks that are not a count", () => {
		const text =
			`${serializeQuestFrontMatter(SESSION_WITH_IDENTITY)}\n# Title\n`.replace(
				"startTicks: 123456",
				'startTicks: "soon"',
			);
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter.sessions?.[0]?.process).toEqual({
			hostId: "host-a",
			pid: 4321,
			startToken: "Sat Jul 12",
			bootToken: "3152D2B4-B508-4118-BDE5-7804CA87C255",
		});
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

	it("round-trips a verify command and omits it when unset", () => {
		const withVerify: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			verify: "pnpm test lib/lsp",
		};
		const text = `${serializeQuestFrontMatter(withVerify)}\n# x`;
		expect(text).toMatch(/^verify: pnpm test lib\/lsp$/m);
		expect(parseQuestFrontMatter(text)?.frontMatter.verify).toBe(
			"pnpm test lib/lsp",
		);

		const without = `${serializeQuestFrontMatter(SAMPLE_QUEST_FM)}\n`;
		expect(without).not.toMatch(/^verify:/m);
		expect(
			parseQuestFrontMatter(`${without}# x`)?.frontMatter.verify,
		).toBeUndefined();
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

	it("round-trips a tree's origin marker", () => {
		const fm: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			trees: [
				{
					path: "/Users/joel/src/world/.worktrees/feature-x",
					providerId: "git-worktree",
					origin: "scaffolded",
				},
				{
					path: "/Users/joel/world/trees/root",
					providerId: "dev-tree",
					origin: "adopted",
				},
			],
		};
		const text = `${serializeQuestFrontMatter(fm)}\n# Title\n`;
		const parsed = parseQuestFrontMatter(text);
		expect(parsed?.frontMatter.trees?.[0]?.origin).toBe("scaffolded");
		expect(parsed?.frontMatter.trees?.[1]?.origin).toBe("adopted");
	});

	it("parses an absent or invalid tree origin as undefined", () => {
		const withOrigins: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			trees: [
				{ path: "/a", providerId: "git-worktree" },
				{ path: "/b", providerId: "git-worktree", origin: "adopted" },
			],
		};
		const text = serializeQuestFrontMatter(withOrigins).replace(
			"providerId: git-worktree",
			"providerId: git-worktree\n    origin: bogus",
		);
		const parsed = parseQuestFrontMatter(`${text}\n# Title\n`);
		// The injected bogus value on the first tree is dropped, and the
		// second tree's valid marker survives, so a malformed marker can
		// never silently read as scaffolded and arm auto-prune.
		expect(parsed?.frontMatter.trees?.[0]?.origin).toBeUndefined();
		expect(parsed?.frontMatter.trees?.[1]?.origin).toBe("adopted");
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

	it("round-trips a scratchDir when present and omits it when absent", () => {
		const fm: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			scratchDir: "/tmp/pi-quest-QEST-20260603-AAA111-Ab3xZ9",
		};
		const parsed = parseQuestFrontMatter(
			`${serializeQuestFrontMatter(fm)}\n# Title\n`,
		);
		expect(parsed?.frontMatter.scratchDir).toBe(
			"/tmp/pi-quest-QEST-20260603-AAA111-Ab3xZ9",
		);
		expect(serializeQuestFrontMatter(SAMPLE_QUEST_FM)).not.toContain(
			"scratchDir:",
		);
	});

	it("round-trips a short name just under the id, and omits it when absent", () => {
		const text = serializeQuestFrontMatter({
			...SAMPLE_QUEST_FM,
			short: "Agentic loop",
		});
		const parsed = parseQuestFrontMatter(`${text}\n# Title\n`);

		expect(parsed?.frontMatter.short).toBe("Agentic loop");
		expect(parsed?.frontMatter._extra).toBeUndefined();
		expect(text.split("\n").slice(1, 3)).toEqual([
			"id: QEST-20260603-AAA111",
			"short: Agentic loop",
		]);
		expect(serializeQuestFrontMatter(SAMPLE_QUEST_FM)).not.toContain("short:");
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
});

// Each shape's fixture is typed `EveryField`, so the typecheck fails until a
// field added to the type, at any depth, is set here; the round-trip then
// fails if one side drops it. Together they are the check the file's "Long
// because" leans on.
describe("every front-matter field", () => {
	it("round-trips every field a quest can hold", () => {
		const fm: EveryField<QuestFrontMatter> = {
			...SAMPLE_QUEST_FM,
			aliases: [{ type: "github-issue", value: "shop/world#47281" }],
			sessions: [
				{
					id: "live-session",
					name: "investigation",
					cwd: "/Users/joel/world",
					started: "2026-06-03T18:14:00Z",
					status: "active",
					instanceId: "inst-42",
					process: {
						hostId: "host-a",
						pid: 4321,
						startToken: "Sat Jul 12",
						bootToken: "3152D2B4-B508-4118-BDE5-7804CA87C255",
						startTicks: 123_456,
						hosted: {
							host: "host-a",
							session: "conversation-7",
							owner: {
								pid: 4000,
								startedAt: 1_780_000_000_000,
								bootId: "3152D2B4-B508-4118-BDE5-7804CA87C255",
								session: "conversation-7",
								host: "host-a",
								startTicks: 120_000,
							},
						},
					},
					terminal: {
						driverId: "wezterm",
						value: "7",
						scope: "/sock/gui-1",
						hostId: "host-a",
					},
				},
			],
			short: "a-short-name",
			orchestrator: true,
			orchestratedBy: "QEST-20260601-PPP000",
			steward: true,
			hears: "addressed",
			realm: "work",
			trees: [
				{
					path: "/Users/joel/src/world/.worktrees/feature-x",
					branch: "feature-x",
					repoRoot: "/Users/joel/src/world",
					providerId: "world-dev-tree",
					zones: ["areas/tools/pi"],
					origin: "scaffolded",
					host: "optimus",
				},
			],
			pendingPrune: [
				{
					path: "/Users/joel/src/world/.worktrees/old",
					reason: "dirty",
					detectedAt: "2026-06-03T19:00:00Z",
				},
			],
			scratchDir: "/Users/joel/.cache/quest/QEST-20260603-AAA111",
			primaryPlanId: "PLAN-20260603-BBB222",
			verify: "pnpm test lib/lsp",
			_extra: { customField: "hello" },
		};
		const text = `${serializeQuestFrontMatter(fm)}\n# Title\n`;
		expect(parseQuestFrontMatter(text)?.frontMatter).toEqual(fm);
	});

	it("round-trips every field a document can hold", () => {
		const fm: EveryField<DocumentFrontMatter> = {
			id: "PLAN-20260603-BBB222",
			kind: "plan",
			quest: "QEST-20260603-AAA111",
			stage: "build",
			updated: "2026-06-03",
			rounds: 3,
			subject: "pr-review",
			_extra: { customField: "hello" },
		};
		const text = `${serializeDocumentFrontMatter(fm)}\n# Plan title\n`;
		expect(parseDocumentFrontMatter(text)?.frontMatter).toEqual(fm);
	});

	// A key an object already answers to, by its prototype, is still the
	// person's own field and comes back as it was written.
	it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
		"keeps an extra field named %s on a quest and a document",
		(key) => {
			const extra = Object.defineProperty({}, key, {
				value: "kept",
				enumerable: true,
				writable: true,
				configurable: true,
			});
			const quest: QuestFrontMatter = { ...SAMPLE_QUEST_FM, _extra: extra };
			const questText = `${serializeQuestFrontMatter(quest)}\n# Title\n`;
			const doc: DocumentFrontMatter = {
				id: "PLAN-20260603-BBB222",
				kind: "plan",
				quest: "QEST-20260603-AAA111",
				stage: "build",
				updated: "2026-06-03",
				_extra: extra,
			};
			const docText = `${serializeDocumentFrontMatter(doc)}\n# Plan\n`;

			expect(
				parseQuestFrontMatter(questText)?.frontMatter._extra,
				"the quest's",
			).toStrictEqual(extra);
			expect(
				parseDocumentFrontMatter(docText)?.frontMatter._extra,
				"the document's",
			).toStrictEqual(extra);
		},
	);

	// A field of the person's own named like `__proto__` may hold a map,
	// which must come back as that map rather than become the prototype.
	// A quest's too, as the case above reads both (#2220's round 8, F9).
	it("keeps an extra __proto__ field that holds a map, on a quest and a document", () => {
		const extra = Object.defineProperty({}, "__proto__", {
			value: { nested: "kept" },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		const doc: DocumentFrontMatter = {
			id: "PLAN-20260603-BBB222",
			kind: "plan",
			quest: "QEST-20260603-AAA111",
			stage: "build",
			updated: "2026-06-03",
			_extra: extra,
		};
		const text = `${serializeDocumentFrontMatter(doc)}\n# Plan\n`;
		const quest: QuestFrontMatter = { ...SAMPLE_QUEST_FM, _extra: extra };
		const questText = `${serializeQuestFrontMatter(quest)}\n# Title\n`;

		for (const [whose, read] of [
			["the document's", parseDocumentFrontMatter(text)?.frontMatter._extra],
			["the quest's", parseQuestFrontMatter(questText)?.frontMatter._extra],
		] as const) {
			expect(read, `${whose} extra as written`).toStrictEqual(extra);
			expect(read && Object.getPrototypeOf(read), `${whose} prototype`).toBe(
				Object.prototype,
			);
		}
	});

	// An extra can't write over a field the shape knows, so a hand-added
	// `stage` among the extras never changes the document's stage.
	it("writes a known field over an extra of the same name", () => {
		const doc: DocumentFrontMatter = {
			id: "PLAN-20260603-BBB222",
			kind: "plan",
			quest: "QEST-20260603-AAA111",
			stage: "build",
			updated: "2026-06-03",
			_extra: { stage: "think" },
		};
		const text = serializeDocumentFrontMatter(doc);

		expect(
			parseDocumentFrontMatter(`${text}\n# Plan\n`)?.frontMatter.stage,
		).toBe("build");
		expect(text, "the extra's value").not.toContain("think");
	});

	// A quest's too, so a hand-added `status` never changes its status
	// (#2220's round 8, F9).
	it("writes a quest's known field over an extra of the same name", () => {
		const quest: QuestFrontMatter = {
			...SAMPLE_QUEST_FM,
			_extra: { status: "retired" },
		};
		const text = serializeQuestFrontMatter(quest);

		expect(
			parseQuestFrontMatter(`${text}\n# Title\n`)?.frontMatter.status,
		).toBe(SAMPLE_QUEST_FM.status);
		expect(text, "the extra's value").not.toContain("retired");
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
