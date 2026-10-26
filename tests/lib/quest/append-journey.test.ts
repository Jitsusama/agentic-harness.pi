import {
	existsSync,
	mkdtempSync,
	readdirSync,
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

let questDir: string;

beforeEach(() => {
	questDir = mkdtempSync(join(tmpdir(), "append-journey-"));
});

afterEach(() => {
	rmSync(questDir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-06-03T12:00:00Z");

function readme(): string {
	return readFileSync(join(questDir, "README.md"), "utf8");
}

function journeyFile(): string {
	return readFileSync(join(questDir, JOURNEY_FILE), "utf8");
}

function writeReadme(lines: string[]): void {
	writeFileSync(join(questDir, "README.md"), lines.join("\n"));
}

describe("appendJourneyByPath", () => {
	it("returns false when the README is missing", () => {
		const ok = appendJourneyByPath(questDir, "anything", { now: fixedNow });
		expect(ok).toBe(false);
		expect(existsSync(join(questDir, JOURNEY_FILE))).toBe(false);
	});

	it("writes the entry to the Journey file and points the README at it", () => {
		writeReadme([
			"---",
			"id: QEST-test",
			"---",
			"",
			"# Title",
			"",
			"Summary.",
			"",
		]);
		const ok = appendJourneyByPath(questDir, "started the work", {
			now: fixedNow,
		});
		expect(ok).toBe(true);
		expect(journeyFile()).toBe(
			"# 🌄 Journey\n\n- **2026-06-03**: started the work\n",
		);
		expect(readme()).toMatch(/## 🌄 Journey\n\nKept in \[JOURNEY\.md\]/);
		expect(readme()).not.toContain("started the work");
	});

	it("puts each new entry first", () => {
		writeReadme(["---", "id: QEST-test", "---", "", "# Title", ""]);
		appendJourneyByPath(questDir, "first", { now: fixedNow });
		appendJourneyByPath(questDir, "second", { now: fixedNow });
		expect(recentJourney(questDir, readme(), 5).map((e) => e.prose)).toEqual([
			"second",
			"first",
		]);
	});

	it("moves a README's old entries into the file below the new one", () => {
		writeReadme([
			"---",
			"id: QEST-test",
			"---",
			"",
			"# Title",
			"",
			"## 🌄 Journey",
			"",
			"- **2026-06-02**: earlier entry",
			"  carried on here",
			"- **2026-06-01**: earliest entry",
			"",
		]);
		appendJourneyByPath(questDir, "newer entry", { now: fixedNow });
		expect(journeyFile()).toBe(
			[
				"# 🌄 Journey",
				"",
				"- **2026-06-03**: newer entry",
				"- **2026-06-02**: earlier entry",
				"  carried on here",
				"- **2026-06-01**: earliest entry",
				"",
			].join("\n"),
		);
		expect(readme()).toBe(
			`---\nid: QEST-test\n---\n\n# Title\n\n## 🌄 Journey\n\n${JOURNEY_POINTER}\n`,
		);
	});

	it("writes atomically inside the quest lock (no .tmp- leftovers)", () => {
		writeReadme(["---", "id: QEST-test", "---", "", "# Title", ""]);
		appendJourneyByPath(questDir, "first", { now: fixedNow });
		appendJourneyByPath(questDir, "second", { now: fixedNow });
		const leftovers = readdirSync(questDir).filter(
			(n) => n.includes(".tmp-") || n === ".quest.lock",
		);
		expect(leftovers).toHaveLength(0);
	});
});
