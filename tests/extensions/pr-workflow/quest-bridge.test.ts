import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge";
import {
	logQuestJourneyForPr,
	recordReviewRound,
} from "../../../extensions/pr-workflow/quest-bridge";
import {
	parseDocumentFrontMatter,
	registerQuestPrBridge,
	unregisterQuestPrBridge,
} from "../../../lib/quest";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pr-workflow-quest-bridge-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	unregisterQuestPrBridge();
});

function writeSidequest(opts: {
	id: string;
	dir: string;
	alias?: { type: string; value: string };
}): void {
	mkdirSync(opts.dir, { recursive: true });
	const aliasBlock = opts.alias
		? `aliases:\n  - type: ${opts.alias.type}\n    value: ${opts.alias.value}`
		: "aliases: []";
	const fm = `---\nid: ${opts.id}\nkind: sidequest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-06-01\nupdated: 2026-06-01\n${aliasBlock}\nsessions: []\n---`;
	writeFileSync(
		join(opts.dir, "README.md"),
		`${fm}\n\n# Bridge Test\n\n## \ud83d\udcdc Summary\n\nFake.\n\n## \ud83c\udf04 Journey\n\n- **2026-06-01**: Created.\n`,
	);
}

describe("logQuestJourneyForPr", () => {
	it("is a no-op when no bridge is registered", () => {
		writeSidequest({
			id: "QEST-20260601-AAAAAA",
			dir: join(root, "QEST-20260601-AAAAAA"),
			alias: { type: "github-pr", value: "Shopify/world#1" },
		});
		// Bridge not registered — call must not throw.
		expect(() =>
			logQuestJourneyForPr(
				{ owner: "Shopify", repo: "world", number: 1 },
				"Ignored",
			),
		).not.toThrow();
		const readme = readFileSync(
			join(root, "QEST-20260601-AAAAAA", "README.md"),
			"utf8",
		);
		expect(readme).not.toContain("Ignored");
	});

	it("writes a Journey bullet when the PR has a sidequest", () => {
		const dir = join(root, "QEST-20260601-AAAAAA");
		writeSidequest({
			id: "QEST-20260601-AAAAAA",
			dir,
			alias: { type: "github-pr", value: "Shopify/world#1" },
		});
		registerQuestPrBridge({
			questsRoot: () => root,
			loadedQuestId: () => null,
			logJourney: (questDir, prose) => {
				const path = join(questDir, "README.md");
				const text = readFileSync(path, "utf8");
				writeFileSync(
					path,
					text.replace(
						"## \ud83c\udf04 Journey\n",
						`## \ud83c\udf04 Journey\n\n- ${prose}\n`,
					),
				);
			},
		});
		logQuestJourneyForPr(
			{ owner: "Shopify", repo: "world", number: 1 },
			"Council ran with 3 reviewers.",
		);
		const readme = readFileSync(join(dir, "README.md"), "utf8");
		expect(readme).toContain("Council ran with 3 reviewers.");
	});

	it("skips silently when the PR has no matching sidequest", () => {
		const dir = join(root, "QEST-20260601-AAAAAA");
		writeSidequest({
			id: "QEST-20260601-AAAAAA",
			dir,
			alias: { type: "github-pr", value: "Shopify/other#9" },
		});
		let called = false;
		registerQuestPrBridge({
			questsRoot: () => root,
			loadedQuestId: () => null,
			logJourney: () => {
				called = true;
			},
		});
		logQuestJourneyForPr(
			{ owner: "Shopify", repo: "world", number: 1 },
			"Should not appear.",
		);
		expect(called).toBe(false);
	});
});

function fakeJudgeRun(): JudgeRun {
	return {
		id: "JR-1",
		startedAt: "2026-06-03T12:00:00Z",
		judgeReviewerId: "raven",
		selfSignal: { confidence: "medium", rationale: "Two reviewers agreed." },
		consolidatedFindings: [
			{
				id: 1,
				label: "issue",
				severity: "medium",
				subject: "Nil deref",
				discussion: "Walks a nil pointer when foo is unset.",
				category: "file",
				location: {
					kind: "line",
					file: "a.go",
					start: 10,
					end: 12,
					side: "new",
				},
				decorations: ["blocking"],
				origin: {
					kind: "judge",
					runId: "JR-1",
					judgeReviewerId: "raven",
				},
				state: "draft",
				agreement: { raisedBy: ["kelpie", "parrot"], sourceFindingIds: [1, 2] },
			},
		],
		warnings: [],
	};
}

describe("recordReviewRound", () => {
	it("returns undefined when no bridge is registered", () => {
		const result = recordReviewRound(
			{ owner: "Shopify", repo: "world", number: 1 },
			{
				councilReviewerIds: ["kelpie"],
				rawFindingsCount: 1,
				judgeRun: fakeJudgeRun(),
			},
		);
		expect(result).toBeUndefined();
	});

	it("writes the research doc on first call", () => {
		const dir = join(root, "QEST-20260601-AAAAAA");
		writeSidequest({
			id: "QEST-20260601-AAAAAA",
			dir,
			alias: { type: "github-pr", value: "Shopify/world#1" },
		});
		registerQuestPrBridge({
			questsRoot: () => root,
			loadedQuestId: () => null,
			logJourney: () => {},
		});
		const result = recordReviewRound(
			{ owner: "Shopify", repo: "world", number: 1 },
			{
				councilReviewerIds: ["kelpie", "parrot"],
				rawFindingsCount: 3,
				judgeRun: fakeJudgeRun(),
			},
		);
		expect(result?.isNew).toBe(true);
		expect(result?.roundNumber).toBe(1);
		const text = readFileSync(result?.path ?? "", "utf8");
		const parsed = parseDocumentFrontMatter(text);
		expect(parsed?.frontMatter.quest).toBe("QEST-20260601-AAAAAA");
		expect(text).toContain("# PR Review: Shopify/world#1");
		expect(text).toContain("## Round 1 —");
		expect(text).toContain("Nil deref");
		expect(text).toContain("Judge self-signal: medium confidence.");
	});

	it("appends a new round on subsequent calls", () => {
		const dir = join(root, "QEST-20260601-AAAAAA");
		writeSidequest({
			id: "QEST-20260601-AAAAAA",
			dir,
			alias: { type: "github-pr", value: "Shopify/world#1" },
		});
		registerQuestPrBridge({
			questsRoot: () => root,
			loadedQuestId: () => null,
			logJourney: () => {},
		});
		const first = recordReviewRound(
			{ owner: "Shopify", repo: "world", number: 1 },
			{
				councilReviewerIds: ["kelpie"],
				rawFindingsCount: 1,
				judgeRun: fakeJudgeRun(),
			},
		);
		const second = recordReviewRound(
			{ owner: "Shopify", repo: "world", number: 1 },
			{
				councilReviewerIds: ["kelpie", "parrot"],
				rawFindingsCount: 2,
				judgeRun: fakeJudgeRun(),
			},
		);
		expect(second?.isNew).toBe(false);
		expect(second?.docId).toBe(first?.docId);
		expect(second?.roundNumber).toBe(2);
		const text = readFileSync(second?.path ?? "", "utf8");
		expect(text).toContain("## Round 1");
		expect(text).toContain("## Round 2");
	});
});
