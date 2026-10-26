import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendHarnessLog,
	HARNESS_LOG_LINES,
	harnessLogPath,
} from "../../../lib/internal/quest/harness-log";

let questDir: string;
const at = (iso: string) => () => new Date(iso);
const log = () => readFileSync(harnessLogPath(questDir), "utf8");

beforeEach(() => {
	questDir = mkdtempSync(join(tmpdir(), "harness-log-"));
	writeFileSync(join(questDir, "README.md"), "# T\n");
});

afterEach(() => {
	rmSync(questDir, { recursive: true, force: true });
});

describe("a quest's harness log", () => {
	it("appends one timestamped line per entry, oldest first", () => {
		appendHarnessLog(questDir, "Adopted tree at ~/src/a.", {
			now: at("2026-10-26T05:01:02.345Z"),
		});
		appendHarnessLog(questDir, "Linked github-pr:o/r#1.", {
			now: at("2026-10-26T05:02:00Z"),
		});

		expect(log()).toBe(
			"2026-10-26T05:01:02Z Adopted tree at ~/src/a.\n" +
				"2026-10-26T05:02:00Z Linked github-pr:o/r#1.\n",
		);
	});

	it("keeps an entry to one line", () => {
		appendHarnessLog(questDir, "Pruned tree\n  at ~/src/a.\n", {
			now: at("2026-10-26T05:01:02Z"),
		});

		expect(log()).toBe("2026-10-26T05:01:02Z Pruned tree at ~/src/a.\n");
	});

	it("keeps only the newest lines once it is full", () => {
		const full = Array.from(
			{ length: HARNESS_LOG_LINES },
			(_, i) => `2026-10-01T00:00:00Z old ${i}`,
		);
		writeFileSync(harnessLogPath(questDir), `${full.join("\n")}\n`);

		appendHarnessLog(questDir, "new", { now: at("2026-10-26T05:01:02Z") });

		const lines = log().trimEnd().split("\n");
		expect(lines).toHaveLength(HARNESS_LOG_LINES);
		expect(lines[0]).toBe("2026-10-01T00:00:00Z old 1");
		expect(lines.at(-1)).toBe("2026-10-26T05:01:02Z new");
	});

	it("writes nothing for a folder with no README", () => {
		rmSync(join(questDir, "README.md"));

		expect(appendHarnessLog(questDir, "Adopted tree.")).toBe(false);
		expect(existsSync(harnessLogPath(questDir))).toBe(false);
	});
});
