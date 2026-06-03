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

let questDir: string;

beforeEach(() => {
	questDir = mkdtempSync(join(tmpdir(), "append-journey-"));
});

afterEach(() => {
	rmSync(questDir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-06-03T12:00:00Z");

function readReadme(): string {
	return readFileSync(join(questDir, "README.md"), "utf8");
}

describe("appendJourneyByPath", () => {
	it("returns false when the README is missing", () => {
		const ok = appendJourneyByPath(questDir, "anything", { now: fixedNow });
		expect(ok).toBe(false);
	});

	it("scaffolds a Journey section when the README has none", () => {
		writeFileSync(
			join(questDir, "README.md"),
			"---\nid: QEST-test\n---\n\n# Title\n\nSummary.\n",
		);
		const ok = appendJourneyByPath(questDir, "started the work", {
			now: fixedNow,
		});
		expect(ok).toBe(true);
		const text = readReadme();
		expect(text).toMatch(/##\s+\u{1F304}\s+Journey/u);
		expect(text).toContain("- **2026-06-03**: started the work");
	});

	it("inserts at the top of an existing Journey section", () => {
		writeFileSync(
			join(questDir, "README.md"),
			[
				"---",
				"id: QEST-test",
				"---",
				"",
				"# Title",
				"",
				"## 🌄 Journey",
				"",
				"- **2026-06-02**: earlier entry",
				"",
			].join("\n"),
		);
		const ok = appendJourneyByPath(questDir, "newer entry", {
			now: fixedNow,
		});
		expect(ok).toBe(true);
		const lines = readReadme().split("\n");
		const journeyIdx = lines.findIndex((l) =>
			/##\s+\u{1F304}\s+Journey/u.test(l),
		);
		const firstBullet = lines
			.slice(journeyIdx + 1)
			.find((l) => l.startsWith("- **"));
		expect(firstBullet).toContain("newer entry");
	});

	it("handles a Journey heading without any existing entries", () => {
		writeFileSync(
			join(questDir, "README.md"),
			[
				"---",
				"id: QEST-test",
				"---",
				"",
				"# Title",
				"",
				"## 🌄 Journey",
				"",
			].join("\n"),
		);
		const ok = appendJourneyByPath(questDir, "first ever", {
			now: fixedNow,
		});
		expect(ok).toBe(true);
		const text = readReadme();
		expect(text).toContain("- **2026-06-03**: first ever");
	});

	it("writes atomically inside the quest lock (no .tmp- leftovers)", () => {
		writeFileSync(
			join(questDir, "README.md"),
			"---\nid: QEST-test\n---\n\n# Title\n",
		);
		mkdirSync(join(questDir, "plans"), { recursive: true });
		appendJourneyByPath(questDir, "first", { now: fixedNow });
		appendJourneyByPath(questDir, "second", { now: fixedNow });
		const remaining = require("node:fs")
			.readdirSync(questDir)
			.filter((n: string) => n.includes(".tmp-"));
		expect(remaining).toHaveLength(0);
	});
});
