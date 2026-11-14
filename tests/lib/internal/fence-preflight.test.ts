/**
 * The pre-flight's verdicts: a throw is a failure, the report says each
 * check, and the exit status lets the install go only when every check
 * passed.
 */

import { describe, expect, it } from "vitest";
import {
	type Check,
	exitStatus,
	failed,
	inSession,
	type PreflightContext,
	passed,
	refusedAs,
	reportLine,
	runChecks,
	succeeded,
	summary,
	type Verdict,
} from "../../../lib/internal/fence-preflight.ts";

const CONTEXT: PreflightContext = {
	session: "s",
	repo: "/r",
	scratch: "/tmp",
	heavy: false,
};

function check(id: string, run: () => Promise<Verdict>): Check {
	return { id, group: "agents", what: `check ${id}`, run };
}

describe("running the pre-flight's checks", () => {
	it("counts a check that throws as failed, and runs the rest", async () => {
		const verdicts = await runChecks(
			[
				check("1", async () => {
					throw new Error("no socket");
				}),
				check("2", async () => passed("fine")),
			],
			CONTEXT,
		);
		expect(
			verdicts.map(([, verdict]) => verdict),
			"each check's verdict",
		).toEqual([failed("threw: no socket"), passed("fine")]);
	});

	it("installs only when every check passed", async () => {
		const all = (verdict: Verdict) =>
			runChecks(
				[check("1", async () => passed("a")), check("2", async () => verdict)],
				CONTEXT,
			);
		expect(exitStatus(await all(passed("b"))), "every check passed").toBe(0);
		expect(exitStatus(await all(failed("b"))), "one failed").toBe(1);
		expect(exitStatus(await all(inSession("b"))), "one left to a session").toBe(
			2,
		);
	});

	it("says each check and what came of it", async () => {
		const verdicts = await runChecks(
			[
				check("7a", async () => failed("gh refused")),
				check("8", async () => inSession("do it")),
			],
			CONTEXT,
		);
		expect(
			verdicts.map(([c, v]) => reportLine(c, v)),
			"a line a check",
		).toEqual(["FAIL 7a   check 7a: gh refused", "TODO 8    check 8: do it"]);
		expect(summary(verdicts), "the summary's verdict").toBe(
			"0 passed, 1 failed, 1 for a session to do: the fence doesn't install.",
		);
	});
});

describe("judging a command's run", () => {
	const ran = (code: number | null) => ({
		code,
		out: "out",
		err: "err",
		ms: 5,
	});

	it("passes a command that should succeed only on exit 0", () => {
		expect(succeeded(ran(0), "git fetch").outcome, "exit 0").toBe("passed");
		expect(succeeded(ran(128), "git fetch"), "exit 128").toEqual(
			failed("git fetch exited 128 after 5 ms: out / err"),
		);
		expect(succeeded(ran(null), "git fetch").said, "stopped").toContain(
			"stopped",
		);
	});

	it("passes a command that must be refused only when it didn't succeed", () => {
		expect(refusedAs(ran(1), "touch").outcome, "refused").toBe("passed");
		expect(refusedAs(ran(0), "touch").outcome, "let through").toBe("failed");
	});
});
