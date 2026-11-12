import { describe, expect, it } from "vitest";
import type { Look } from "../../../lib/mesh/looks.ts";
import {
	askableElsewhere,
	changeOf,
	type HostedState,
	MOST_ASKED_ELSEWHERE,
	resolutionsElsewhere,
} from "../../../lib/mesh/looks-hosted.ts";

const HOSTED = "https://code.example.com/acme/app/pull";

/** A waiting look at a pull request on a host other than GitHub. */
const look = (number: number, over: Partial<Look> = {}): Look => ({
	v: 1,
	id: `look-${number}`,
	at: "2026-11-11T20:00:00Z",
	session: "S1",
	kind: "pr",
	target: `${HOSTED}/${number}`,
	title: `Change ${number}`,
	why: "For you to approve.",
	state: "waiting",
	...over,
});

// Joel, 11 November 20:26: "if it is no longer applicable because i took
// too long and things have changed, it should disappear."
describe("asking a change's own host about the person's looks at it", () => {
	it("asks only about waiting looks at changes GitHub's ask doesn't reach", () => {
		const looks = [
			look(1),
			look(2, { kind: "diff" }),
			look(3, { target: "https://github.com/Jitsusama/core.nix/pull/3" }),
			look(4, { state: "opened" }),
			look(5, { kind: "page" }),
			look(6, { kind: "file", target: "/home/someone/notes.md" }),
		];

		expect(askableElsewhere(looks, 0).map((one) => one.id)).toEqual([
			"look-1",
			"look-2",
		]);
	});

	it("asks a few each turn, taking up where the last turn left off", () => {
		const many = Array.from({ length: 25 }, (_, at) => look(at));
		const turns = [0, 1, 2].map((turn) =>
			askableElsewhere(many, turn).map((one) => one.id),
		);

		expect(turns.map((ids) => ids.length)).toEqual([
			MOST_ASKED_ELSEWHERE,
			MOST_ASKED_ELSEWHERE,
			MOST_ASKED_ELSEWHERE,
		]);
		expect(turns[1]?.[0], "the second turn starts past the first").toBe(
			"look-10",
		);
		expect(
			new Set(turns.flat()).size,
			"three turns ask every one of the 25",
		).toBe(25);
	});

	it("names the change without the place on its page a look points at", () => {
		expect(changeOf(` ${HOSTED}/7#pullrequestreview-12 `)).toBe(`${HOSTED}/7`);
	});

	it("resolves what merged or closed, and leaves what's open or unanswered", async () => {
		const states: Record<string, HostedState | undefined> = {
			[`${HOSTED}/1`]: "merged",
			[`${HOSTED}/2`]: "closed",
			[`${HOSTED}/3`]: "open",
		};
		const stateOf = (change: string) =>
			change === `${HOSTED}/5`
				? Promise.reject(new Error("the host is down"))
				: Promise.resolve(states[change]);
		const asked = [1, 2, 3, 4, 5].map((number) =>
			look(number, { target: `${HOSTED}/${number}#files` }),
		);

		expect(await resolutionsElsewhere(asked, stateOf)).toEqual([
			{ id: "look-1", how: "merged" },
			{ id: "look-2", how: "closed" },
		]);
	});
});
