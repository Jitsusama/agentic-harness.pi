/**
 * The live probes behind the judge of a done act: how they read his
 * pull requests from GitHub's answer and his posts from Slack.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	liveProbes,
	PROBE_WITHIN_MS,
	pullRecordFrom,
} from "../../../lib/orchestration/done-acts.ts";
import { slackReadWith } from "../../../lib/orchestration/done-acts-slack.ts";

/** A local time on 16 November 2026, in ms. */
const at = (hours: number, minutes: number, seconds = 0): number =>
	new Date(2026, 10, 16, hours, minutes, seconds).getTime();

afterEach(() => {
	vi.useRealTimers();
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
		expect(stopped?.aborted, "the read's signal stopped").toBe(true);
		expect(await reading).toBeUndefined();
	});
});
