import {
	existsSync,
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
	FORMER_JOURNEY_FILE,
	JOURNEY_FILE,
	JOURNEY_POINTER,
	JOURNEY_TITLE,
	recentJourney,
} from "../../../lib/internal/quest/journey";
import {
	CITATIONS_OPENING,
	citationsLine,
	planJourneySweep,
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
/** Where a sweep says what went wrong, when a test does not ask. */

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
});

describe("moving the Journey up beside the README", () => {
	const formerPointer = `Kept in [${FORMER_JOURNEY_FILE}](${FORMER_JOURNEY_FILE}), newest first.`;
	const former = () => join(questDir, FORMER_JOURNEY_FILE);

	beforeEach(() => {
		writeFileSync(
			join(questDir, "README.md"),
			`# Title\n\n## 🌄 Journey\n\n${formerPointer}\n`,
		);
		mkdirSync(join(questDir, "attachments"));
		writeFileSync(
			former(),
			"# 🌄 Journey\n\n- **2026-06-02**: Old place.\n- **2026-06-01**: Created.\n",
		);
	});

	it("reads a Journey still at the old place", () => {
		expect(recentJourney(questDir, readme(), 5).map((e) => e.prose)).toEqual([
			"Old place.",
			"Created.",
		]);
	});

	it("moves it up, points the README there and removes the emptied folder", () => {
		expect(sweepJourney(questDir)).toBe(0);

		expect(journeyFile()).toBe(
			"# 🌄 Journey\n\n- **2026-06-02**: Old place.\n- **2026-06-01**: Created.\n",
		);
		expect(readme()).toBe(`# Title\n\n## 🌄 Journey\n\n${JOURNEY_POINTER}\n`);
		expect(existsSync(join(questDir, "attachments"))).toBe(false);
	});

	it("keeps attachments/ when it holds anything else", () => {
		writeFileSync(join(questDir, "attachments", "chart.png"), "png");
		sweepJourney(questDir);
		expect(existsSync(former())).toBe(false);
		expect(existsSync(join(questDir, "attachments", "chart.png"))).toBe(true);
	});

	it("folds in what an older session wrote at the old place by date", () => {
		sweepJourney(questDir);
		mkdirSync(join(questDir, "attachments"));
		writeFileSync(former(), "# 🌄 Journey\n\n- **2026-06-03**: Stale write.\n");
		appendJourneyByPath(questDir, "harness entry", { now: fixedNow });

		expect(journeyFile()).toBe(
			[
				"# 🌄 Journey",
				"",
				"- **2026-06-03**: harness entry",
				"- **2026-06-03**: Stale write.",
				"- **2026-06-02**: Old place.",
				"- **2026-06-01**: Created.",
				"",
			].join("\n"),
		);
		expect(existsSync(former())).toBe(false);
	});

	it("reads and sweeps both files merged by date, either holding the newest", () => {
		writeFileSync(
			join(questDir, JOURNEY_FILE),
			`${JOURNEY_TITLE}\n\n- **2026-06-05**: New code.\n  More of it.\n- **2026-06-03**: New, same day.\n- **2026-06-01**: Created.\n\n[a]: https://a\n`,
		);
		writeFileSync(
			former(),
			`${JOURNEY_TITLE}\n\n- **2026-06-04**: Old code.\n- **2026-06-03**: Old, same day.\n\n[a]: https://a\n[b]: https://b\n`,
		);
		const merged = [
			"- **2026-06-05**: New code.",
			"  More of it.",
			"- **2026-06-04**: Old code.",
			"- **2026-06-03**: New, same day.",
			"- **2026-06-03**: Old, same day.",
			"- **2026-06-01**: Created.",
		];
		expect(recentJourney(questDir, readme(), 9).map((e) => e.date)).toEqual([
			"2026-06-05",
			"2026-06-04",
			"2026-06-03",
			"2026-06-03",
			"2026-06-01",
		]);

		sweepJourney(questDir);

		expect(journeyFile()).toBe(
			`${[JOURNEY_TITLE, "", ...merged, "", "[a]: https://a", "[b]: https://b"].join("\n")}\n`,
		);
		expect(existsSync(former())).toBe(false);
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
