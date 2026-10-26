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
import { JOURNEY_POINTER } from "../../lib/internal/quest/journey";
import { questDirs } from "../../scripts/migrate-journey-file";
import { moveQuest, planQuest } from "../../scripts/move-journey-file";

const A = "QEST-20260101-AAAAAA";
const B = "QEST-20260102-BBBBBB";
const OLD = "attachments/journey.md";
const OLD_POINTER = `Kept in [${OLD}](${OLD}), newest first.`;
const JOURNEY =
	"# 🌄 Journey\n\n- **2026-01-02**: See plans/PLAN-20260101-CCCCCC.md.\n";
let root: string;

const readme = (pointer: string) =>
	`# A Quest\n\n## 🌄 Journey\n\n${pointer}\n\n## 🏰 Context\n\nKept.\n`;
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "move-journey-file-"));
	mkdirSync(join(root, A, "attachments"), { recursive: true });
	mkdirSync(join(root, A, B), { recursive: true });
	writeFileSync(join(root, A, "README.md"), readme(OLD_POINTER));
	writeFileSync(join(root, A, OLD), JOURNEY);
	writeFileSync(join(root, A, "attachments", "chart.png"), "png");
	writeFileSync(join(root, A, B, "README.md"), readme(JOURNEY_POINTER));
	writeFileSync(join(root, A, B, "JOURNEY.md"), "# 🌄 Journey\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("moving each Journey up beside its README", () => {
	it("plans only the quests still holding the old file, writing nothing", () => {
		const plans = questDirs(root).map(planQuest);
		expect(plans.map((p) => [p.quest, p.bytes])).toEqual([
			[A, Buffer.byteLength(JOURNEY)],
			[B, 0],
		]);
		expect(existsSync(join(root, A, OLD))).toBe(true);
	});

	it("moves the file verbatim, repoints the README and keeps the rest", () => {
		const outcomes = questDirs(root).map(moveQuest);
		expect(outcomes.filter((o) => o.problem)).toEqual([]);
		expect(read(`${A}/JOURNEY.md`)).toBe(JOURNEY);
		expect(existsSync(join(root, A, OLD))).toBe(false);
		expect(existsSync(join(root, A, "attachments", "chart.png"))).toBe(true);
		expect(read(`${A}/README.md`)).toBe(readme(JOURNEY_POINTER));
		expect(read(`${A}/${B}/README.md`)).toBe(readme(JOURNEY_POINTER));
	});

	it("finds nothing to move a second time", () => {
		questDirs(root).forEach(moveQuest);
		const before = read(`${A}/README.md`);
		expect(
			questDirs(root)
				.map(planQuest)
				.every((p) => p.bytes === 0),
		).toBe(true);
		questDirs(root).forEach(moveQuest);
		expect(read(`${A}/README.md`)).toBe(before);
	});
});
