import { describe, expect, it } from "vitest";
import {
	afterJobWait,
	freshJobWait,
	isBareWait,
	MAX_BARE_WORDS,
} from "../../../extensions/away-workflow/job-wait.ts";
import type { RunSummary } from "../../../extensions/away-workflow/keep-going.ts";
import type { RunningJob } from "../../../lib/jobs/index.ts";

const evalTests: RunningJob = {
	id: "j27",
	kind: "bash",
	label: "the eval tests under tec run",
};
const push: RunningJob = { id: "j34", kind: "bash", label: "git push" };

function ran(lastText: string, toolCalls = 1): RunSummary {
	return { lastText, toolCalls, aborted: false };
}

describe("a bare wait", () => {
	// Each of these ended a turn of KAN5HP's on 18 and 19 November while
	// the job it named ran on.
	it.each([
		"Waiting on the eval tests (j27).",
		"The topology test builds with 60%. Waiting on the eval tests (j27).",
		"These are exactly the eight intended files, with nothing stray. Waiting on j30 (the zone's Go tests) before committing; it reports on its own.",
		"5h0q's results will come back on their own; I'll finish the draft once they do.",
		"waiting on j27",
	])("is a short reply that only says it waits: %s", (text) => {
		const goTests = { id: "j30", kind: "bash", label: "the zone's Go tests" };
		expect(isBareWait(ran(text), [evalTests, goTests]), "a bare wait").toBe(
			true,
		);
	});

	it("sees past a Done: or Blocked: lead and markdown", () => {
		expect(
			isBareWait(ran("**Blocked:** waiting on `j27`."), [evalTests]),
			"a Blocked: line naming only the job",
		).toBe(true);
		expect(
			isBareWait(ran("- Done: j27 reports on its own."), [evalTests]),
			"a Done: bullet naming only the job",
		).toBe(true);
	});

	it("is not a reply that says where things stand at length", () => {
		const said = [
			"The eval rerun is at the same 8 of 13, in the slow self-bootstrap test, with the machine still at load 45. Two jobs remain:",
			"",
			"- **j40:** pushing the alerts fix. When it lands, I open that PR ready for review.",
			"- **j33:** the eval rerun, with up to about 2.5 hours of its limit left.",
			"",
			"Both report on their own.",
		].join("\n");
		expect(
			isBareWait(ran(said), [evalTests, push]),
			"says where things stand",
		).toBe(false);
	});

	it(`counts the words, so ${MAX_BARE_WORDS + 1} of them is no bare wait`, () => {
		const filler = Array.from({ length: MAX_BARE_WORDS - 3 }, () => "word");
		const at = ["Waiting", "on", "j27", ...filler].join(" ");
		expect(isBareWait(ran(at), [evalTests]), "at the limit").toBe(true);
		expect(isBareWait(ran(`${at} more`), [evalTests]), "one past").toBe(false);
	});

	it("leaves markdown and an ending's lead out of the count", () => {
		const filler = Array.from({ length: MAX_BARE_WORDS - 3 }, () => "word");
		const at = ["waiting", "on", "`j27`", ...filler].join(" ");
		expect(
			isBareWait(ran(`**Blocked:** ${at}`), [evalTests]),
			"a Blocked: lead at the limit",
		).toBe(true);
		expect(
			isBareWait(ran(`- **Done:** ${at}`), [evalTests]),
			"a Done: bullet at the limit",
		).toBe(true);
	});

	it.each([
		"It returns the jobs still running, oldest first.",
		"Done: the bug report is filed as #42.",
		"Done: the fix lands in #1830.",
		"Done: the dev server is running on :3000.",
		"No, j27 is still running the eval tests.",
		"Blocked: waiting on your answer to the token ask in the launcher.",
	])("is not a short reply that only uses a job's words: %s", (text) => {
		expect(isBareWait(ran(text), [evalTests]), "no bare wait on a job").toBe(
			false,
		);
	});

	it("is not a wait on a job that has finished, while another runs", () => {
		expect(
			isBareWait(ran("Waiting on j12 before merging."), [push]),
			"j12 has finished",
		).toBe(false);
	});

	it.each([
		"Waiting on j27, 8 of 13 done; reports in about 20 minutes, then I commit.",
		"Waiting on j27: 60% through; then I push.",
		"j27 reports on its own in five minutes; then I commit.",
	])(
		"is not a short reply that says how far it has got or when: %s",
		(text) => {
			expect(isBareWait(ran(text), [evalTests]), "says how far or when").toBe(
				false,
			);
		},
	);

	it("leaves a Done: or Blocked: ending to away mode while the person is away", () => {
		expect(
			isBareWait(ran("Blocked: waiting on j27."), [evalTests], true),
			"a Blocked: ending while away",
		).toBe(false);
		expect(
			isBareWait(ran("Waiting on j27."), [evalTests], true),
			"a plain wait while away",
		).toBe(true);
	});

	it("needs a job running", () => {
		expect(isBareWait(ran("Waiting on j27."), []), "no job runs").toBe(false);
	});

	it("needs the reply to say it waits", () => {
		expect(isBareWait(ran("Merged #1824."), [evalTests]), "no wait said").toBe(
			false,
		);
	});

	it("leaves a reply that asks the person something to them", () => {
		expect(
			isBareWait(ran("Shall I wait on j27?"), [evalTests]),
			"a question",
		).toBe(false);
		expect(
			isBareWait(ran("**Shall I wait on `j27`?**"), [evalTests]),
			"a question in markdown",
		).toBe(false);
	});

	it("leaves a run the person stopped, and one that said nothing", () => {
		expect(
			isBareWait({ ...ran("Waiting on j27."), aborted: true }, [evalTests]),
			"a stopped run",
		).toBe(false);
		expect(isBareWait(ran(""), [evalTests]), "an empty reply").toBe(false);
	});
});

describe("after a run", () => {
	it("sends a bare wait back, naming each running job and what to say", () => {
		const verdict = afterJobWait(
			ran("Waiting on j27."),
			[evalTests, push],
			freshJobWait(),
		);
		expect(verdict.kind).toBe("send-back");
		if (verdict.kind !== "send-back") return;
		expect(verdict.text).toContain("j27 (the eval tests under tec run)");
		expect(verdict.text).toContain("j34 (git push)");
		for (const asked of [
			"where things stand",
			"what each is doing",
			"when it reports",
			"what you will do once it has",
		])
			expect(verdict.text, asked).toContain(asked);
		expect(verdict.text).toContain("Done:");
	});

	it("never sends back the run that answers a send-back", () => {
		const memory = freshJobWait();
		afterJobWait(ran("Waiting on j27."), [evalTests], memory);

		const verdict = afterJobWait(ran("Still j27.", 0), [evalTests], memory);

		expect(verdict.kind).toBe("go-on");
	});

	it("goes on with the bare run's tool calls counted in the answer's", () => {
		const memory = freshJobWait();
		afterJobWait(ran("Waiting on j27.", 4), [evalTests], memory);

		const verdict = afterJobWait(
			ran("j27 runs the eval tests; about five minutes more.", 0),
			[evalTests],
			memory,
		);

		expect(verdict).toEqual({
			kind: "go-on",
			run: {
				lastText: "j27 runs the eval tests; about five minutes more.",
				toolCalls: 4,
				aborted: false,
			},
		});
	});

	it("sends back a bare wait again once a run in between went on", () => {
		const memory = freshJobWait();
		afterJobWait(ran("Waiting on j27."), [evalTests], memory);
		afterJobWait(
			ran("j27 runs the eval tests, five minutes more."),
			[evalTests],
			memory,
		);

		expect(afterJobWait(ran("Waiting on j27."), [evalTests], memory).kind).toBe(
			"send-back",
		);
	});

	it("goes on with any other run as it was", () => {
		const run = ran("Merged #1824.");
		expect(afterJobWait(run, [evalTests], freshJobWait())).toEqual({
			kind: "go-on",
			run,
		});
	});
});
