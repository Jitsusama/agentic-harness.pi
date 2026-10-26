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
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey";
import {
	JOURNEY_FILE,
	JOURNEY_POINTER,
	recentJourney,
} from "../../../lib/internal/quest/journey";
import {
	CITATIONS_OPENING,
	citationsLine,
	planJourneySweep,
	sweepAfterQuestAction,
	sweepJourney,
} from "../../../lib/internal/quest/journey-sweep";

let questDir: string;

beforeEach(() => {
	questDir = mkdtempSync(join(tmpdir(), "journey-sweep-"));
});

afterEach(() => {
	rmSync(questDir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-06-03T12:00:00Z");
const readme = () => readFileSync(join(questDir, "README.md"), "utf8");
const journeyFile = () => readFileSync(join(questDir, JOURNEY_FILE), "utf8");

/**
 * What core 0.16.2's appendJourneyByPath does, kept here so the test
 * shows the sweep undoing exactly that: a bullet inserted right after
 * the Journey heading, skipping blank lines.
 */
function coreAppends(prose: string, date: string): void {
	const lines = readme().split("\n");
	const heading = lines.findIndex((l) => /^## .*Journey$/.test(l));
	let at = heading + 1;
	while (at < lines.length && lines[at].trim() === "") at++;
	lines.splice(at, 0, `- **${date}**: ${prose}`);
	writeFileSync(join(questDir, "README.md"), lines.join("\n"));
}

describe("sweeping what core appended", () => {
	beforeEach(() => {
		writeFileSync(
			join(questDir, "README.md"),
			"---\nid: QEST-test\n---\n\n# Title\n\n## 🌄 Journey\n\n- **2026-06-01**: Created.\n",
		);
		appendJourneyByPath(questDir, "harness entry", { now: fixedNow });
	});

	it("moves core's entries to the head of the file, in order, losing none", () => {
		coreAppends("Linked github-pr:a/b#1.", "2026-06-04");
		coreAppends("Moved from 2 to 1.", "2026-06-05");

		expect(sweepJourney(questDir)).toBe(2);

		expect(journeyFile()).toBe(
			[
				"# 🌄 Journey",
				"",
				"- **2026-06-05**: Moved from 2 to 1.",
				"- **2026-06-04**: Linked github-pr:a/b#1.",
				"- **2026-06-03**: harness entry",
				"- **2026-06-01**: Created.",
				"",
			].join("\n"),
		);
		expect(readme()).toBe(
			`---\nid: QEST-test\n---\n\n# Title\n\n## 🌄 Journey\n\n${JOURNEY_POINTER}\n`,
		);
	});

	it("reads core's unswept entries first, before a sweep runs", () => {
		coreAppends("Moved from 2 to 1.", "2026-06-05");
		expect(recentJourney(questDir, readme(), 2).map((e) => e.prose)).toEqual([
			"Moved from 2 to 1.",
			"harness entry",
		]);
	});

	it("does nothing a second time", () => {
		const before = { readme: readme(), file: journeyFile() };
		expect(sweepJourney(questDir)).toBe(0);
		expect({ readme: readme(), file: journeyFile() }).toEqual(before);
	});

	it("sweeps after a core verb's action, and not after any other", () => {
		coreAppends("Moved from 2 to 1.", "2026-06-05");
		sweepAfterQuestAction("show", questDir, [], () => undefined);
		expect(readme()).toContain("Moved from 2 to 1.");
		sweepAfterQuestAction("bump", questDir, [], () => undefined);
		expect(readme()).not.toContain("Moved from 2 to 1.");
		expect(journeyFile()).toContain("Moved from 2 to 1.");
	});

	it("sweeps a quest an action named by id", () => {
		const other = mkdtempSync(join(tmpdir(), "journey-sweep-other-"));
		try {
			writeFileSync(
				join(other, "README.md"),
				"# Other\n\n## 🌄 Journey\n\n- **2026-06-05**: Reparented to top level.\n",
			);
			sweepAfterQuestAction("reparent", undefined, ["QEST-X"], (id) =>
				id === "QEST-X" ? other : undefined,
			);
			expect(readFileSync(join(other, JOURNEY_FILE), "utf8")).toContain(
				"Reparented to top level.",
			);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("planning a sweep", () => {
	it("moves a whole section verbatim, odd lines included", () => {
		const section = [
			"- **2026-09-18 (night)**: a bullet the date parser skips",
			"",
			"Free prose someone left in the Journey.",
			"- **2026-09-17**: a plain one",
			"  continued",
		];
		const plan = planJourneySweep(
			[
				"# T",
				"",
				"## 🌄 Journey",
				"",
				...section,
				"",
				"## 🎯 Milestones",
				"",
				"- [ ] x",
				"",
			].join("\n"),
		);
		expect(plan?.journey).toBe(`# 🌄 Journey\n\n${section.join("\n")}\n`);
		expect(plan?.readme).toBe(
			`# T\n\n## 🌄 Journey\n\n${JOURNEY_POINTER}\n\n## 🎯 Milestones\n\n- [ ] x\n`,
		);
		expect(plan?.moved).toBe(4);
	});

	it("keeps a link definition the README still uses, and copies one the Journey borrows", () => {
		const plan = planJourneySweep(
			[
				"# T",
				"",
				"See [the PR][pr] and [the ask][ask].",
				"",
				"## 🌄 Journey",
				"",
				"- **2026-06-01**: Opened [it][pr], read [the thread][thread].",
				"",
				"[pr]: https://example.com/pr",
				"",
				"## 🏰 Context",
				"",
				"[ask]: https://example.com/ask",
				"[thread]: https://example.com/thread",
				"",
			].join("\n"),
		);
		expect(plan?.readme).toContain(
			`${JOURNEY_POINTER}\n\n[pr]: https://example.com/pr\n\n## 🏰 Context`,
		);
		expect(plan?.readme).toContain("[thread]: https://example.com/thread");
		expect(plan?.journey).toBe(
			[
				"# 🌄 Journey",
				"",
				"- **2026-06-01**: Opened [it][pr], read [the thread][thread].",
				"",
				"[pr]: https://example.com/pr",
				"[thread]: https://example.com/thread",
				"",
			].join("\n"),
		);
	});

	it("adds a pointer section to a README that has none", () => {
		const plan = planJourneySweep("# T\n\nText.\n");
		expect(plan?.readme).toBe(
			`# T\n\nText.\n\n## 🌄 Journey\n\n${JOURNEY_POINTER}\n`,
		);
		expect(plan?.journey).toBe("# 🌄 Journey\n");
	});

	it("leaves a swept quest alone", () => {
		mkdirSync(join(questDir, "attachments"));
		const swept = `# T\n\n## 🌄 Journey\n\n${JOURNEY_POINTER}\n`;
		expect(
			planJourneySweep(swept, {
				journey: "# 🌄 Journey\n\n- **2026-06-01**: x\n",
			}),
		).toBeUndefined();
	});
});

describe("carrying the Journey's citations", () => {
	const attachments = [
		"attachments/journey.md",
		"attachments/chart.png",
		"attachments/runs/a.md",
		"attachments/runs/b.md",
		"attachments/notes/cited.md",
		"attachments/notes/uncited.md",
	];

	it("names what only the Journey cites, folded to whole folders", () => {
		const line = citationsLine(
			"QEST-20260101-AAAAAA",
			"- **2026-06-01**: See attachments/runs/a.md, attachments/runs/b.md and attachments/notes/cited.md.",
			"![chart](attachments/chart.png)",
			attachments,
		);
		expect(line).toBe(
			`${CITATIONS_OPENING} attachments/notes/cited.md attachments/runs -->`,
		);
	});

	it("says nothing when the README already cites all of it", () => {
		expect(
			citationsLine(
				"QEST-20260101-AAAAAA",
				"- **2026-06-01**: Drew attachments/chart.png.",
				"![chart](attachments/chart.png)",
				attachments,
			),
		).toBeUndefined();
	});

	it("keeps them cited in the README across a sweep and a new entry", () => {
		mkdirSync(join(questDir, "attachments/runs"), { recursive: true });
		writeFileSync(join(questDir, "attachments/runs/a.md"), "a\n");
		writeFileSync(join(questDir, "attachments/notes.md"), "n\n");
		writeFileSync(
			join(questDir, "README.md"),
			"# T\n\n## Journey\n\n- **2026-06-01**: Wrote attachments/runs/a.md.\n",
		);
		sweepJourney(questDir);
		expect(readme()).toContain(`${CITATIONS_OPENING} attachments/runs -->`);
		appendJourneyByPath(questDir, "Noted attachments/notes.md.", {
			now: fixedNow,
		});
		expect(readme()).toContain(
			`${CITATIONS_OPENING} attachments/notes.md attachments/runs -->`,
		);
		expect(recentJourney(questDir, readme(), 5)).toHaveLength(2);
	});
});
