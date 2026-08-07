/**
 * A fan-out that says nothing looks exactly like one that has hung.
 *
 * These check the observer sees each participant move, sees what a
 * running one is doing, and above all sees them running *at the same
 * time*, since the whole reason the reporting exists is that a
 * concurrent round otherwise spends minutes in silence.
 */

import { describe, expect, it } from "vitest";
import {
	type AskAnswer,
	type Finding,
	noAskProgress,
	type Participant,
	runCouncil,
	trackAskProgress,
} from "../../../lib/review/index.js";

const alice: Participant = { id: "alice", model: "a/one" };
const bob: Participant = { id: "bob", model: "b/two" };

/** A roster of the given participants and no judge. */
function roster(...reviewers: Participant[]) {
	return { reviewers };
}

/**
 * Run a round, driven through the public surface.
 *
 * Progress rides on `CouncilDeps`, so `runCouncil` is where a caller
 * meets it; `askRoster` is an internal that only forwards.
 */
function round(
	reviewers: Participant[],
	ask: NonNullable<Parameters<typeof runCouncil>[1]>["ask"],
	progress?: Parameters<typeof runCouncil>[1]["progress"],
) {
	let next = 0;
	return runCouncil(
		{ roster: roster(...reviewers), prompt: "look at this", seq: 1 },
		{
			ask,
			async record(findings) {
				return findings.map((one) => ({ ...one, id: ++next }) as Finding);
			},
			now: () => new Date("2026-07-30T00:00:00Z"),
			progress,
		},
	);
}

describe("tracking an ask round", () => {
	it("names every participant as pending before anything runs", () => {
		const { progress, entries } = trackAskProgress();

		progress.start([alice, bob]);

		// The model rides along so a panel can name it without being handed
		// the roster a second time.
		expect(entries()).toEqual([
			{
				participantId: "alice",
				model: "a/one",
				state: "pending",
				activity: "",
			},
			{ participantId: "bob", model: "b/two", state: "pending", activity: "" },
		]);
	});

	it("keeps the roster order it was given", () => {
		// The order a reporter draws in should not depend on who is
		// quickest, or one round describes itself two ways.
		const { progress, entries } = trackAskProgress();

		progress.start([bob, alice]);
		progress.started("alice");

		expect(entries().map((one) => one.participantId)).toEqual(["bob", "alice"]);
	});

	it("attaches activity to the participant that reported it", () => {
		const { progress, entries } = trackAskProgress(() => 1_000);
		progress.start([alice, bob]);

		progress.started("alice");
		progress.activity("alice", "reading app.ts");

		expect(entries()).toEqual([
			{
				participantId: "alice",
				model: "a/one",
				state: "running",
				activity: "reading app.ts",
				// A round says nothing for minutes at a time, so how long
				// this one has been away is the question a watcher has.
				startedAtMs: 1_000,
			},
			{ participantId: "bob", model: "b/two", state: "pending", activity: "" },
		]);
	});

	it("clears the activity when a participant settles", () => {
		// A finished participant still showing "reading app.ts" reads as
		// though it is still reading.
		let clock = 1_000;
		const { progress, entries } = trackAskProgress(() => clock);
		progress.start([alice]);
		progress.started("alice");
		progress.activity("alice", "bash pnpm test");

		clock = 61_000;
		progress.answered("alice");

		expect(entries()[0]).toEqual({
			participantId: "alice",
			model: "a/one",
			state: "answered",
			activity: "",
			startedAtMs: 1_000,
			// Frozen where it settled. A finished reviewer's time is a
			// fact about the round, not a counter that keeps climbing.
			settledAtMs: 61_000,
		});
	});

	it("keeps the reason a participant failed", () => {
		const { progress, entries } = trackAskProgress();
		progress.start([alice]);
		progress.started("alice");

		progress.failed("alice", "model refused");

		expect(entries()[0]).toMatchObject({
			state: "failed",
			reason: "model refused",
		});
	});

	it("counts findings once they have been numbered", () => {
		const { progress, entries } = trackAskProgress();
		progress.start([alice]);
		progress.answered("alice");

		progress.recorded("alice", 3);

		expect(entries()[0]).toMatchObject({ state: "answered", findings: 3 });
	});

	it("ignores an id that is not on the roster", () => {
		// A late event from a cancelled run should not invent a row.
		const { progress, entries } = trackAskProgress();
		progress.start([alice]);

		progress.started("nobody");
		progress.activity("nobody", "reading");

		expect(entries()).toHaveLength(1);
		expect(entries()[0]?.state).toBe("pending");
	});
});

describe("a round reporting as it goes", () => {
	it("reports every participant running before any has settled", async () => {
		// The claim that matters. Both are asked concurrently, so a
		// reporter must be able to see two in flight at once; a
		// sequential implementation would show one running at a time.
		const { progress, entries } = trackAskProgress();
		let seen: string[] = [];
		const release: Array<() => void> = [];

		const running = round(
			[alice, bob],
			async (participant): Promise<AskAnswer> => {
				// Record the whole board the moment this one is away.
				seen = entries().map((one) => one.state);
				await new Promise<void>((resolve) => release.push(resolve));
				return { text: `${participant.id} says fine` };
			},
			progress,
		);

		// Let both asks begin before either is allowed to finish.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(entries().map((one) => one.state)).toEqual(["running", "running"]);

		for (const go of release) go();
		await running;

		expect(seen).toContain("running");
		expect(entries().map((one) => one.state)).toEqual(["answered", "answered"]);
	});

	it("passes a reporter the ask can call while it works", async () => {
		const { progress, entries } = trackAskProgress();

		await round(
			[alice],
			async (_participant, _prompt, context): Promise<AskAnswer> => {
				context.report?.("grep TODO");
				expect(entries()[0]?.activity).toBe("grep TODO");
				return { text: "fine" };
			},
			progress,
		);

		expect(entries()[0]?.state).toBe("answered");
	});

	it("reports a thrown error as a failure with its message", async () => {
		const { progress, entries } = trackAskProgress();

		await round(
			[alice],
			() => {
				throw new Error("spawn refused");
			},
			progress,
		);

		// The message, whatever else it is decorated with. A thrown
		// failure also carries the frame it came from, since the message
		// alone has more than once been true of a dozen places at once.
		expect(entries()[0]).toMatchObject({ state: "failed" });
		expect(entries()[0]?.reason).toContain("spawn refused");
	});

	it("reports a reported failure the same way a thrown one is", async () => {
		// A failure the runner hands back and one it throws are the same
		// event to somebody watching.
		const { progress, entries } = trackAskProgress();

		await round(
			[alice],
			async (): Promise<AskAnswer> => ({ failure: "budget exhausted" }),
			progress,
		);

		expect(entries()[0]).toMatchObject({
			state: "failed",
			reason: "budget exhausted",
		});
	});

	it("counts the findings each participant actually landed", async () => {
		// The count comes from recording, not from the answer, because a
		// finding that failed to parse is not a finding.
		const { progress, entries } = trackAskProgress();

		await round(
			[alice],
			async (): Promise<AskAnswer> => ({
				text: JSON.stringify({
					findings: [
						{
							location: { kind: "file", file: "lib/a.ts" },
							label: "issue",
							subject: "This leaks",
							discussion: "The handle is never closed.",
						},
					],
				}),
			}),
			progress,
		);

		expect(entries()[0]?.findings).toBe(1);
	});

	it("runs without a progress observer at all", async () => {
		// Every existing caller passes no observer, and must not have to.
		const result = await round(
			[alice],
			async (): Promise<AskAnswer> => ({ text: "fine" }),
		);

		expect(result.run.outcomes).toHaveLength(1);
	});

	it("accepts the no-op observer as a stand-in", async () => {
		const result = await round(
			[alice],
			async (): Promise<AskAnswer> => ({ text: "fine" }),
			noAskProgress,
		);

		expect(result.run.outcomes[0]?.participantId).toBe("alice");
	});
});
