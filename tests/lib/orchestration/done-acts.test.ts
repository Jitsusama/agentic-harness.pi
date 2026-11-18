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
import { slackReadWith } from "../../../lib/orchestration/done-acts-slack.ts";

/** A local time on 16 November 2026, in ms. */
const at = (hours: number, minutes: number, seconds = 0): number =>
	new Date(2026, 10, 16, hours, minutes, seconds).getTime();

/** The same, as the probes' shapes write a time. */
const stamp = (hours: number, minutes: number): string =>
	new Date(at(hours, minutes)).toISOString();

/** Probes answering from fixed records; `undefined` reads can't be read. */
function probes(
	records: { pull?: PullRecord; posts?: number[] } = {},
): DoneProbes {
	return {
		pull: async () => records.pull,
		posts: async () => records.posts,
	};
}

/** Probes whose pull requests answer by number, counting each read. */
function pulls(byNumber: Record<number, PullRecord>): {
	probes: DoneProbes;
	read: number[];
} {
	const read: number[] = [];
	return {
		read,
		probes: {
			pull: async (_repo, number) => {
				read.push(number);
				return byNumber[number];
			},
			posts: async () => undefined,
		},
	};
}

const CHANNEL = "https://shopify.slack.com/archives/C07DELTADEV";
const PULL = "https://github.com/Jitsusama/agentic-harness.pi/pull/1781";
const OTHER = "https://github.com/Jitsusama/agentic-harness.pi/pull/1782";

afterEach(() => {
	vi.useRealTimers();
});

describe("a question asking the person for an act he has done", () => {
	it("is refused, saying when he did it", async () => {
		// 16 November: a session said the one thing left was Joel's,
		// posting the top-level Slack draft in #delta-dev, and at 19:24 he
		// was asked; he had posted at 19:18:29 (misses row 34).
		const read: [string, string | undefined, number][] = [];
		const refused = await doneAlreadyRefusal(
			"The one thing left is Joel's: posting the top-level Slack draft in #delta-dev. Can you ask him?",
			{
				pull: async () => undefined,
				posts: async (channel, thread, since) => {
					read.push([channel, thread, since]);
					return [at(19, 18, 29)];
				},
			},
			at(19, 24),
		);
		expect(refused).toContain("already done at 19:18");
		expect(refused).toContain("#delta-dev");
		// Three hours back, as nothing says when the draft was made.
		expect(read).toEqual([["#delta-dev", undefined, at(16, 24)]]);
		expect(DRAFT_WINDOW_MS).toBe(3 * 60 * 60_000);
	});

	it("reads his posts from when the draft was made, by its time", async () => {
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
			probes({ posts: [at(19, 18, 29)] }),
			at(19, 24),
		);
		expect(refused).toBeUndefined();
	});

	it("reads a linked message's thread from the message on, not the channel", async () => {
		const read: [string, string | undefined, number][] = [];
		const ts = `${at(19, 5) / 1000}`;
		const link = `${CHANNEL}/p${ts.replace(".", "")}000000`;
		await doneAlreadyRefusal(
			`Joel should post the reply in ${link}. Ask him?`,
			{
				pull: async () => undefined,
				posts: async (channel, thread, since) => {
					read.push([channel, thread, since]);
					return [];
				},
			},
			at(19, 24),
		);
		// The linked message itself is what he was asked to answer.
		expect(read).toEqual([["C07DELTADEV", `${ts}.000000`, at(19, 5) + 1]]);
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
		const changesAsked = probes({
			pull: {
				headOid: "head",
				reviews: [{ approved: false, at: at(15, 0), oid: "head" }],
			},
		});
		expect(
			await doneAlreadyRefusal(
				`Can Joel review ${PULL}?`,
				changesAsked,
				at(17, 0),
			),
		).toContain("he reviewed its newest commit at 15:00");
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL}?`,
				changesAsked,
				at(17, 0),
			),
		).toBeUndefined();
		// An approval he overruled since, asking for changes, isn't one.
		const overruled = probes({
			pull: {
				headOid: "head",
				reviews: [
					{ approved: true, at: at(15, 0), oid: "head" },
					{ approved: false, at: at(15, 30), oid: "head" },
				],
			},
		});
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL}?`,
				overruled,
				at(17, 0),
			),
		).toBeUndefined();
		// Newest by its time, whatever order the record lists them in.
		const listed = (reviews: PullRecord["reviews"]) =>
			probes({ pull: { headOid: "head", reviews } });
		const approval = { approved: true, at: at(15, 0), oid: "head" };
		const changes = { approved: false, at: at(15, 30), oid: "head" };
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL}?`,
				listed([changes, approval]),
				at(17, 0),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL}?`,
				listed([{ ...changes, at: at(14, 0) }, approval]),
				at(17, 0),
			),
		).toContain("he approved its newest commit at 15:00");
	});

	it("goes for a review he gave of an older commit, or one asked for again", async () => {
		const reviewed = { approved: true, at: at(15, 0), oid: "old" };
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL}?`,
				probes({ pull: { headOid: "head", reviews: [reviewed] } }),
				at(17, 0),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				`Can Joel approve ${PULL} again?`,
				probes({ pull: { headOid: "old", reviews: [reviewed] } }),
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("goes while any act it asks is still to do", async () => {
		const approved = probes({
			pull: {
				headOid: "head",
				reviews: [{ approved: true, at: at(15, 0), oid: "head" }],
			},
		});
		expect(
			await doneAlreadyRefusal(
				`Can you ask Joel to approve and merge ${PULL}?`,
				approved,
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("pairs an act only with the places in its own sentence", async () => {
		const { probes: byNumber } = pulls({
			1781: { mergedAt: at(16, 0), reviews: [] },
			1782: { reviews: [] },
		});
		expect(
			await doneAlreadyRefusal(
				`Once ${PULL} has merged, can Joel merge ${OTHER}?`,
				byNumber,
				at(17, 0),
			),
		).toBeUndefined();
		// Across sentences, merging the open one would be asked too, and
		// let it through.
		expect(
			await doneAlreadyRefusal(
				`Can Joel merge ${PULL}? ${OTHER} is still open.`,
				byNumber,
				at(17, 0),
			),
		).toContain("it merged at 16:00");
	});

	it("reads each pull request once, and none when it links too many", async () => {
		const once = pulls({ 1781: { reviews: [] } });
		await doneAlreadyRefusal(
			`Can Joel review, approve and merge ${PULL}?`,
			once.probes,
			at(17, 0),
		);
		expect(once.read).toEqual([1781]);
		const many = pulls({});
		const links = [1, 2, 3, 4, 5, 6, 7]
			.map((n) => `https://github.com/a/b/pull/${n}`)
			.join(" ");
		await doneAlreadyRefusal(
			`Can Joel merge ${links}?`,
			many.probes,
			at(17, 0),
		);
		expect(many.read).toEqual([]);
	});

	it("goes when no record can be read, since that proves nothing done", async () => {
		const failing: DoneProbes = {
			pull: () => Promise.reject(new Error("gh is signed out")),
			posts: async () => undefined,
		};
		// Each ask is refused over records that read done, so only the
		// unread record lets it through.
		const done = probes({
			pull: { mergedAt: at(16, 30), reviews: [] },
			posts: [at(16, 30)],
		});
		for (const ask of [
			`Can Joel merge ${PULL}?`,
			`Can Joel post the draft in ${CHANNEL}?`,
		]) {
			expect(
				await doneAlreadyRefusal(ask, failing, at(17, 0)),
				ask,
			).toBeUndefined();
			expect(await doneAlreadyRefusal(ask, done, at(17, 0)), ask).toContain(
				"already done at 16:30",
			);
		}
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

	it("takes no mesh group for a channel, nor a name said without Slack", async () => {
		const posted = probes({ posts: [at(16, 0)] });
		expect(
			await doneAlreadyRefusal(
				"Joel should post the note to #quest/wcjqsg. Ask him?",
				posted,
				at(17, 0),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				"Joel should post the Slack note to #quest/wcjqsg. Ask him?",
				posted,
				at(17, 0),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				"Joel should post the note in #machine. Ask him?",
				posted,
				at(17, 0),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				"Joel should post the Slack note in #delta-dev again. Ask him?",
				posted,
				at(17, 0),
			),
		).toBeUndefined();
	});

	it("goes when it asks nothing of his hands", async () => {
		// Every act reads done here, so only the reading of the words lets
		// each question through.
		const done = probes({
			pull: {
				mergedAt: at(16, 40),
				headOid: "head",
				reviews: [
					{ approved: true, at: at(15, 0), oid: "head" },
					{ approved: false, at: at(15, 30), oid: "head" },
				],
			},
			posts: [at(19, 18)],
		});
		expect(
			await doneAlreadyRefusal(`Can Joel merge ${PULL}?`, done, at(19, 24)),
		).toContain("already done");
		expect(
			await doneAlreadyRefusal(
				`Joel merged ${PULL} at 16:40; should I close the row?`,
				done,
				at(19, 24),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				"Can Joel send it to the orchestrator in Slack's #delta-dev?",
				done,
				at(19, 24),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				`May I run a review council on ${PULL} before Joel looks?`,
				done,
				at(17, 0),
			),
		).toBeUndefined();
		expect(
			await doneAlreadyRefusal(
				`Joel's approval of ${PULL} is in; should I close the row?`,
				done,
				at(17, 0),
			),
		).toBeUndefined();
		// An act said as a noun after his name, or a determiner, is told of.
		for (const told of [
			`Joel's merge of ${PULL} went in at 16:40; should I close the row?`,
			`Joel's review of ${PULL} asked for a rename. Should I make it?`,
			`His review of ${PULL} asked for a rename. Should I make it?`,
			"Joel's post about the draft in Slack's #delta-dev got no replies. Should I nudge?",
		]) {
			expect(await doneAlreadyRefusal(told, done, at(19, 24)), told).toBe(
				undefined,
			);
		}
	});

	it("reads a pull request named as a condition or as context as no place for the act", async () => {
		const done = probes({
			pull: {
				mergedAt: at(16, 0),
				headOid: "head",
				reviews: [{ approved: true, at: at(15, 0), oid: "head" }],
			},
		});
		for (const sound of [
			`Now that ${PULL} has merged, can Joel merge the release branch?`,
			`Once ${PULL} merged, can he approve the docs change?`,
			`Joel approved ${PULL} this morning; can he review the docs change?`,
			`Can Joel merge the revert of ${PULL}?`,
			`${PULL} broke main. Can he merge the fix for ${PULL}?`,
			`Can Joel review the backport of ${PULL}?`,
		]) {
			expect(await doneAlreadyRefusal(sound, done, at(17, 0)), sound).toBe(
				undefined,
			);
		}
	});

	it("never counts the linked message, nor an old reply in its thread, as his answer", async () => {
		const now = at(19, 24);
		const linkTo = (ms: number, parent?: number) =>
			`${CHANNEL}/p${ms / 1000}000000${parent ? `?thread_ts=${parent / 1000}.000000` : ""}`;
		const his = (posted: number[]): DoneProbes => ({
			pull: async () => undefined,
			posts: async (_channel, _thread, since) =>
				posted.filter((one) => one >= since),
		});
		// A link to his own reply, asking him to follow it up.
		expect(
			await doneAlreadyRefusal(
				`Joel should post a reply to Sam under ${linkTo(at(19, 0), at(18, 0))}. Ask him?`,
				his([at(19, 0)]),
				now,
			),
		).toBeUndefined();
		// A thread he answered in hours before the new question in it.
		const parent = now - 2 * 86_400_000;
		expect(
			await doneAlreadyRefusal(
				`Joel should post a reply in ${linkTo(parent)}. Ask him?`,
				his([parent + 3_600_000]),
				now,
			),
		).toBeUndefined();
		// A reply of his since the ask was made still answers it.
		expect(
			await doneAlreadyRefusal(
				`Joel should post a reply in ${linkTo(parent)}. Ask him?`,
				his([now - 60_000]),
				now,
			),
		).toContain("already done at 19:23");
		// A linked message asked to be posted elsewhere says nothing of its
		// thread, so his comment under the draft proves nothing, while the
		// channel named beside it is still read.
		const read: [string, string | undefined][] = [];
		const asked = `Joel needs to post the draft at ${linkTo(at(19, 0))} in #delta-dev on Slack.`;
		expect(
			await doneAlreadyRefusal(
				asked,
				{
					pull: async () => undefined,
					posts: async (channel, thread) => {
						read.push([channel, thread]);
						return [at(19, 10)];
					},
				},
				now,
			),
		).toContain("#delta-dev");
		expect(read).toEqual([["#delta-dev", undefined]]);
		expect(
			await doneAlreadyRefusal(
				`Joel needs to post the draft at ${linkTo(at(19, 0))}.`,
				his([at(19, 10)]),
				now,
			),
		).toBeUndefined();
		// A draft time said beside his own linked reply still never counts it.
		expect(
			await doneAlreadyRefusal(
				`Joel should post a reply to Sam under ${linkTo(at(19, 0), at(18, 0))}, drafted at 18:30. Ask him?`,
				his([at(19, 0)]),
				now,
			),
		).toBeUndefined();
	});

	it("still reads the 19:24 ask however it is worded", async () => {
		const posted = probes({ posts: [at(19, 18, 29)] });
		for (const ask of [
			"The one thing left is Joel's posting the top-level Slack draft in #delta-dev. Can you ask him?",
			"The one thing left is Joel\u2019s: posting the top-level Slack draft in #delta-dev.",
			"Joel, the one thing left: it's posting the top-level draft in Slack's #delta-dev.",
			"The one thing left is Joel's: posting the follow-up Slack draft in #delta-dev. Can you ask him?",
			"Joel needs to post the draft about the fix in #delta-dev on Slack.",
			`Joel's: posting the Slack draft in #delta-dev. Then he can review the fix for ${PULL}.`,
		]) {
			expect(await doneAlreadyRefusal(ask, posted, at(19, 24)), ask).toContain(
				"already done at 19:18",
			);
		}
		// A curly apostrophe makes a noun as a straight one does.
		expect(
			await doneAlreadyRefusal(
				`Joel\u2019s merge of ${PULL} went in at 16:40; should I close the row?`,
				probes({ pull: { mergedAt: at(16, 40), reviews: [] } }),
				at(19, 24),
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

	it("knows only the probes it can ask, GitHub's repositories and times it can read", async () => {
		const merged = probes({ pull: { mergedAt: at(16, 0), reviews: [] } });
		for (const when of [
			{ probe: "rebooted", boot_id: "0".repeat(32) },
			{ probe: "pr-merged", repo: "--x/y", number: 1 },
			{ probe: "pr-merged", repo: "a/b", number: 0 },
			{ probe: "pr-merged", repo: "a/b", number: 1, host: "gitlab" },
			{ probe: "message-posted", channel: "C1", since: "yesterday" },
			{ probe: "pr-reviewed", repo: "a/b", number: 1, since: "soon" },
		]) {
			expect(
				(await judgeDone(when, merged, at(17, 0))).verdict,
				JSON.stringify(when),
			).toBe("unknown");
		}
	});

	it("counts a review from its since, else of the newest commit, else knows nothing", async () => {
		const review = { approved: false, at: at(15, 0), oid: "head" };
		const reviewed = { probe: "pr-reviewed", repo: "a/b", number: 1 };
		expect(
			(
				await judgeDone(
					{ ...reviewed, since: stamp(15, 30) },
					probes({ pull: { headOid: "head", reviews: [review] } }),
					at(17, 0),
				)
			).verdict,
		).toBe("not-done");
		expect(
			(
				await judgeDone(
					{ ...reviewed, since: stamp(14, 30) },
					probes({ pull: { reviews: [review] } }),
					at(17, 0),
				)
			).verdict,
		).toBe("done");
		expect(
			(
				await judgeDone(
					reviewed,
					probes({ pull: { headOid: "head", reviews: [review] } }),
					at(17, 0),
				)
			).verdict,
		).toBe("done");
		expect(
			(
				await judgeDone(
					reviewed,
					probes({ pull: { reviews: [review] } }),
					at(17, 0),
				)
			).verdict,
		).toBe("unknown");
	});

	it("believes a written verdict for fifteen minutes, then asks", async () => {
		const when = {
			probe: "message-posted",
			channel: "C1",
			since: stamp(18, 0),
			verdict: { done: true, at: stamp(18, 50) },
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
	it("read his merge, approvals and changes asked, and the head, from GitHub's answer", () => {
		const record = pullRecordFrom({
			data: {
				viewer: { login: "Jitsusama" },
				repository: {
					pullRequest: {
						mergedAt: "2026-11-17T21:40:00Z",
						headRefOid: "head",
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
									state: "COMMENTED",
									submittedAt: "2026-11-17T20:15:00Z",
									commit: { oid: "head" },
								},
								{
									author: { login: "Jitsusama" },
									state: "APPROVED",
									submittedAt: "2026-11-17T20:20:00Z",
									commit: { oid: "head" },
								},
								{
									author: { login: "Jitsusama" },
									state: "CHANGES_REQUESTED",
									submittedAt: "2026-11-17T19:20:00Z",
									commit: { oid: "old" },
								},
							],
						},
					},
				},
			},
		});
		expect(record).toEqual({
			mergedAt: Date.parse("2026-11-17T21:40:00Z"),
			headOid: "head",
			reviews: [
				{ approved: true, at: Date.parse("2026-11-17T20:20:00Z"), oid: "head" },
				{ approved: false, at: Date.parse("2026-11-17T19:20:00Z"), oid: "old" },
			],
		});
	});

	it("count only his own posts since the draft, oldest first, top-level outside a thread", async () => {
		const asked: string[] = [];
		const ts = (ms: number) => `${ms / 1000}.000000`;
		const live = liveProbes(
			async () => ({ code: 1, stdout: "", stderr: "" }),
			async () => ({
				me: "U1",
				read: async (_channel, _thread, oldest) => {
					asked.push(oldest);
					return [
						{ ts: ts(at(19, 30)), user: "U1" },
						{ ts: ts(at(19, 25)), user: "U1", threadTs: ts(at(19, 1)) },
						{ ts: ts(at(19, 20)), user: "U2" },
						{ ts: ts(at(19, 18, 29)), user: "U1" },
						{ ts: ts(at(18, 50)), user: "U1" },
					];
				},
			}),
		);
		expect(await live.posts("C1", undefined, at(19, 0))).toEqual([
			at(19, 18, 29),
			at(19, 30),
		]);
		expect(asked).toEqual([`${at(19, 0) / 1000}.000000`]);
		expect(await live.posts("C1", ts(at(19, 1)), at(19, 0))).toEqual([
			at(19, 18, 29),
			at(19, 25),
			at(19, 30),
		]);
		// A thread's parent is what he was asked to answer, not his answer.
		expect(await live.posts("C1", ts(at(19, 30)), at(19, 0))).toEqual([
			at(19, 18, 29),
			at(19, 25),
		]);
		expect(await live.pull("a/b", 1)).toBeUndefined();
	});

	it("tell a searched reply by its link, which search answers without its thread", async () => {
		const ts = (ms: number) => `${ms / 1000}.000000`;
		const live = liveProbes(
			async () => ({ code: 1, stdout: "", stderr: "" }),
			async () => ({
				me: "U1",
				read: async () => [
					{
						ts: ts(at(19, 25)),
						user: "U1",
						permalink: `https://x.slack.com/archives/C1/p${at(19, 25) / 1000}000000?thread_ts=${ts(at(19, 1))}`,
					},
					{ ts: ts(at(19, 18)), user: "U1" },
				],
			}),
		);
		expect(await live.posts("#delta-dev", undefined, at(19, 0))).toEqual([
			at(19, 18),
		]);
		expect(await live.pull("a/b", 1)).toBeUndefined();
	});

	it("read Slack by search for a channel's name, by thread, or by history, under the judge's signal", async () => {
		const calls: string[] = [];
		const signals: AbortSignal[] = [];
		const read = slackReadWith({
			search: async (channel, after, signal) => {
				calls.push(`search ${channel} after ${after}`);
				signals.push(signal);
				return [{ ts: "1.000000", user: "U1" }];
			},
			thread: async (channel, ts, signal) => {
				calls.push(`thread ${channel} ${ts}`);
				signals.push(signal);
				return [];
			},
			history: async (channel, oldest, signal) => {
				calls.push(`history ${channel} ${oldest}`);
				signals.push(signal);
				return [];
			},
		});
		const oldest = `${at(19, 0) / 1000}.000000`;
		const judge = new AbortController().signal;
		expect(await read("#delta-dev", undefined, oldest, judge)).toEqual([
			{ ts: "1.000000", user: "U1" },
		]);
		await read("C1", "2.000000", oldest, judge);
		await read("C1", undefined, oldest, judge);
		expect(calls).toEqual([
			"search #delta-dev after 2026-11-15",
			"thread C1 2.000000",
			`history C1 ${oldest}`,
		]);
		expect(signals).toEqual([judge, judge, judge]);
	});

	it("stop a Slack read once the judge has given up on it, sign-in included", async () => {
		vi.useFakeTimers();
		let stopped: AbortSignal | undefined;
		const live = liveProbes(
			async () => ({ code: 1, stdout: "", stderr: "" }),
			async () => {
				// A slow keyring takes most of the judge's time.
				await new Promise((resolve) =>
					setTimeout(resolve, PROBE_WITHIN_MS - 1),
				);
				return {
					me: "U1",
					read: (_channel, _thread, _oldest, signal) =>
						new Promise((resolve) => {
							stopped = signal;
							signal.addEventListener("abort", () => resolve(undefined));
						}),
				};
			},
		);
		const reading = live.posts("C1", undefined, at(19, 0));
		await vi.advanceTimersByTimeAsync(PROBE_WITHIN_MS);
		expect(stopped?.aborted).toBe(true);
		expect(await reading).toBeUndefined();
	});
});
