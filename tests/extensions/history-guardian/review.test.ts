import { beforeEach, describe, expect, it } from "vitest";
import {
	destructiveHistoryGuardian,
	findHistoryMatches,
	type HistoryFindings,
	riskyHistoryGuardian,
} from "../../../extensions/history-guardian/review.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";

type Ctx = Parameters<typeof riskyHistoryGuardian.review>[1];
const ctx = { hasUI: false } as unknown as Ctx;

let reports: GuardReport[] = [];
beforeEach(() => {
	reports = [];
	setGuardReportSink((r) => reports.push(r));
});

function parsedBy(
	guardian: typeof riskyHistoryGuardian,
	command: string,
): HistoryFindings {
	const parsed = guardian.parse(command);
	if (!parsed) throw new Error(`nothing found in ${command}`);
	return parsed;
}

describe("finding history commands", () => {
	it("finds a reset chained after a rebase", () => {
		const severities = findHistoryMatches(
			"git rebase main && git reset --hard origin/main",
		).map((m) => m.severity);

		expect(severities).toEqual(["risky", "irrecoverable"]);
	});

	it("ignores a command named inside a commit message", () => {
		expect(
			findHistoryMatches('git commit -m "never git reset --hard here"'),
		).toEqual([]);
	});

	it("sends each severity to its own guardian", () => {
		const command = "git rebase main && git reset --hard origin/main";

		expect(riskyHistoryGuardian.detect(command)).toBe(true);
		expect(destructiveHistoryGuardian.detect(command)).toBe(true);
		expect(destructiveHistoryGuardian.detect("git rebase main")).toBe(false);
	});
});

describe("a risky command", () => {
	it("is reported and runs in report mode", async () => {
		const result = await riskyHistoryGuardian.review(
			parsedBy(riskyHistoryGuardian, "git rebase main"),
			ctx,
			"report",
		);

		expect(result).toBeUndefined();
		expect(reports.map((r) => [r.guard, r.kind])).toEqual([
			["history", "shown"],
		]);
	});
});

describe("an irrecoverable command", () => {
	it("is refused with the safe form in block mode", async () => {
		const result = await destructiveHistoryGuardian.review(
			parsedBy(destructiveHistoryGuardian, "git reset --hard"),
			ctx,
			"block",
		);

		expect(result && "reason" in result && result.reason).toMatch(
			/git stash push --include-untracked/,
		);
		expect(result && "reason" in result && result.reason).toMatch(
			/\/guards history-destructive report/,
		);
	});

	it("is reported and runs in report mode", async () => {
		const result = await destructiveHistoryGuardian.review(
			parsedBy(destructiveHistoryGuardian, "git branch -D old"),
			ctx,
			"report",
		);

		expect(result).toBeUndefined();
		expect(reports.map((r) => r.kind)).toEqual(["waved"]);
	});

	it("leases a bare force push instead of refusing it", async () => {
		const result = await destructiveHistoryGuardian.review(
			parsedBy(
				destructiveHistoryGuardian,
				"git fetch && git push --force origin topic",
			),
			ctx,
			"block",
		);

		expect(result).toEqual({
			rewrite: "git fetch && git push --force-with-lease origin topic",
		});
		expect(reports.map((r) => r.kind)).toEqual(["fixed"]);
	});

	it("refuses a chain when any part of it has no safe rewrite", async () => {
		const result = await destructiveHistoryGuardian.review(
			parsedBy(
				destructiveHistoryGuardian,
				"git push -f origin topic && git clean -fd",
			),
			ctx,
			"block",
		);

		expect(result && "block" in result && result.block).toBe(true);
	});
});
