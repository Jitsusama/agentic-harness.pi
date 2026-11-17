/**
 * The judge of whether an act of the person's hands is done already,
 * and the refusal of a question that asks him for one he has done.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DoneProbes,
	DRAFT_WINDOW_MS,
	doneAlreadyRefusal,
	judgeDone,
	liveProbes,
	PROBE_WITHIN_MS,
	type PullRecord,
	pullRecordFrom,
} from "../../../lib/orchestration/done-acts.ts";

/** A local time on 16 November 2026, in ms. */
const at = (hours: number, minutes: number, seconds = 0): number =>
	new Date(2026, 10, 16, hours, minutes, seconds).getTime();

/** Probes answering from fixed records; `undefined` reads can't be read. */
function probes(
	records: { pull?: PullRecord; posts?: number[] } = {},
): DoneProbes {
	return {
		pull: async () => records.pull,
		posts: async () => records.posts,
	};
}

const CHANNEL = "https://shopify.slack.com/archives/C07DELTADEV";
const PULL = "https://github.com/Jitsusama/agentic-harness.pi/pull/1781";

afterEach(() => {
	vi.useRealTimers();
});

describe("a question asking the person for an act he has done", () => {
	it("is refused, saying when he did it", async () => {
		// 16 November: a session said the one thing left was Joel's,
		// posting the top-level Slack draft in #delta-dev, and at 19:24 he
		// was asked; he had posted at 19:18:29 (misses row 34).
		const read: [string, number][] = [];
		const refused = await doneAlreadyRefusal(
			"The one thing left is Joel's: posting the top-level Slack draft in #delta-dev. Can you ask him?",
			{
				pull: async () => undefined,
				posts: async (channel, _thread, since) => {
					read.push([channel, since]);
					return [at(19, 18, 29)];
				},
			},
			at(19, 24),
		);
		expect(refused).toContain("already done at 19:18");
		expect(refused).toContain("#delta-dev");
		expect(read).toEqual([["#delta-dev", at(19, 24) - DRAFT_WINDOW_MS]]);
	});

	it("reads his posts from when the draft was made, by its link or its time", async () => {
		const refused = await doneAlreadyRefusal(
			`Joel needs to post the draft in ${CHANNEL}, drafted at 19:05. Can you ask him?`,
			probes({ posts: [at(19, 18, 29)] }),
			at(19, 24),
		);
		expect(refused).toContain("after the draft (19:05)");
		expect(refused).toContain(CHANNEL);
	});

	it("goes when he posted only before the draft was made", async () => {
		const refused = await doneAlreadyRefusal(
			`Joel needs to post the draft in ${CHANNEL}, drafted at 19:20. Can you ask him?`,
			probes({ posts: [] }),
			at(19, 24),
		);
		expect(refused).toBeUndefined();
	});

	it("is refused for a pull request merged already, and goes for one open", async () => {
		const text = `Can Joel merge ${PULL}?`;
		const merged = await doneAlreadyRefusal(
			text,
			probes({ pull: { mergedAt: at(16, 40), reviews: [] } }),
			at(17, 0),
		);
		expect(merged).toContain("already done at 16:40: it merged at 16:40");
		const open = await doneAlreadyRefusal(
			text,
			probes({ pull: { reviews: [] } }),
			at(17, 0),
		);
		expect(open).toBeUndefined();
	});

	it("tells his review from his approval", async () => {
		const commented = probes({
			pull: { reviews: [{ approved: false, at: at(15, 0) }] },
		});
		expect(
			await doneAlreadyRefusal(
				`Can Joel review ${PULL}?`,
				commented,
				at(17, 0),
			),
		).toContain("he reviewed it at 15:00");
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL}?`,
				commented,
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("goes when no record can be read, since that proves nothing done", async () => {
		const failing: DoneProbes = {
			pull: () => Promise.reject(new Error("gh is signed out")),
			posts: async () => undefined,
		};
		expect(
			await doneAlreadyRefusal(`Can Joel merge ${PULL}?`, failing, at(17, 0)),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				`Can Joel post the draft in ${CHANNEL}?`,
				failing,
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("goes when it names no place to read, as most such asks are sound", async () => {
		expect(
			await doneAlreadyRefusal(
				"Can Joel approve the secret release in the launcher?",
				probes({
					pull: { mergedAt: at(16, 0), reviews: [] },
					posts: [at(16, 0)],
				}),
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("takes no mesh group for a channel", async () => {
		expect(
			await doneAlreadyRefusal(
				"Joel should post the note to #quest/wcjqsg. Ask him?",
				probes({ posts: [at(16, 0)] }),
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("goes when it asks nothing of his hands", async () => {
		expect(
			await doneAlreadyRefusal(
				"Joel posted the draft at 19:18; should I close the row?",
				probes(),
				at(19, 24),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				"May I run a review council on #1781?",
				probes(),
				at(17, 0),
			),
		).toBeUndefined();
	});
});

describe("the judge of a named act", () => {
	it("takes a probe too slow as unknown", async () => {
		vi.useFakeTimers();
		const slow: DoneProbes = {
			pull: () => new Promise(() => {}),
			posts: async () => undefined,
		};
		const judged = judgeDone(
			{ probe: "pr-merged", repo: "a/b", number: 1 },
			slow,
			at(17, 0),
		);
		await vi.advanceTimersByTimeAsync(PROBE_WITHIN_MS);
		expect(await judged).toEqual({ verdict: "unknown" });
	});

	it("knows only the probes it can ask, and only GitHub's repositories", async () => {
		const merged = probes({ pull: { mergedAt: at(16, 0), reviews: [] } });
		for (const when of [
			{ probe: "rebooted", boot_id: "0".repeat(32) },
			{ probe: "pr-merged", repo: "--x/y", number: 1 },
			{ probe: "pr-merged", repo: "a/b", number: 0 },
			{ probe: "pr-merged", repo: "a/b", number: 1, host: "gitlab" },
		]) {
			expect(
				(await judgeDone(when, merged, at(17, 0))).verdict,
				JSON.stringify(when),
			).toBe("unknown");
		}
	});

	it("believes a written verdict for fifteen minutes, then asks", async () => {
		const when = {
			probe: "message-posted",
			channel: "C1",
			since: at(18, 0),
			verdict: { done: true, at: new Date(at(18, 50)).toISOString() },
		};
		expect((await judgeDone(when, probes(), at(19, 0))).verdict).toBe("done");
		expect((await judgeDone(when, probes(), at(19, 6))).verdict).toBe(
			"unknown",
		);
		expect(
			(await judgeDone(when, probes({ posts: [] }), at(19, 6))).verdict,
		).toBe("not-done");
	});
});

describe("the live probes", () => {
	it("read his merge and sent reviews alone from GitHub's answer", () => {
		const record = pullRecordFrom({
			data: {
				viewer: { login: "Jitsusama" },
				repository: {
					pullRequest: {
						mergedAt: "2026-11-17T21:40:00Z",
						reviews: {
							nodes: [
								{
									author: { login: "someone" },
									state: "APPROVED",
									submittedAt: "2026-11-17T20:00:00Z",
								},
								{
									author: { login: "Jitsusama" },
									state: "PENDING",
									submittedAt: "2026-11-17T20:10:00Z",
								},
								{
									author: { login: "Jitsusama" },
									state: "APPROVED",
									submittedAt: "2026-11-17T20:20:00Z",
								},
							],
						},
					},
				},
			},
		});
		expect(record).toEqual({
			mergedAt: Date.parse("2026-11-17T21:40:00Z"),
			reviews: [{ approved: true, at: Date.parse("2026-11-17T20:20:00Z") }],
		});
	});

	it("count only his own posts since the draft, oldest first", async () => {
		const live = liveProbes(
			async () => ({ code: 1, stdout: "", stderr: "" }),
			async () => ({
				me: "U1",
				read: async () => [
					{ ts: `${at(19, 30) / 1000}.000000`, user: "U1" },
					{ ts: `${at(19, 20) / 1000}.000000`, user: "U2" },
					{ ts: `${at(19, 18, 29) / 1000}.000000`, user: "U1" },
				],
			}),
		);
		expect(await live.posts("C1", undefined, at(19, 0))).toEqual([
			at(19, 18, 29),
			at(19, 30),
		]);
		expect(await live.pull("a/b", 1)).toBeUndefined();
	});
});
