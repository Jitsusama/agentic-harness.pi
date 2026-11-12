/**
 * What a session reads of a steer: the person's words, saying where they
 * came from, or a machine's, saying they aren't the person's.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	ANSWER_GONE,
	answerSteered,
	steerText,
} from "../../../extensions/mesh-workflow/steer.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import {
	forgetWants,
	type GivenAnswer,
	sessionWants,
	wantId,
} from "../../../lib/internal/session/wants.ts";

const AT = new Date("2026-11-12T06:00:00.000Z");
const WANT = wantId("question", AT.toISOString());

describe("an answer steered from the launcher", () => {
	afterEach(() => forgetWants());

	/** An ask open in session `s1`, and every answer it took. */
	function open(): { taken: GivenAnswer[]; lower: () => void } {
		const taken: GivenAnswer[] = [];
		const lower = withSession("s1", () =>
			sessionWants().raise("question", "Keep the bar?", AT, {
				choices: [{ value: "keep", label: "Keep it" }],
				take: (given) => taken.push(given),
			}),
		);
		return { taken, lower };
	}

	it("reaches the open ask it names, in the session it serves", () => {
		const { taken, lower } = open();
		const told: string[] = [];

		answerSteered(
			{
				text: "",
				act: "answer",
				want: WANT,
				given: { value: "keep" },
				file: "f",
			},
			"s1",
			(text) => told.push(text),
		);

		expect(taken, "the ask took the choice").toEqual([{ value: "keep" }]);
		expect(told, "nothing said on screen").toEqual([]);
		lower();
	});

	it("says on screen that the question moved on, when its ask is gone", () => {
		const { taken, lower } = open();
		lower();
		const told: string[] = [];

		answerSteered(
			{
				text: "",
				act: "answer",
				want: WANT,
				given: { value: "keep" },
				file: "f",
			},
			"s1",
			(text) => told.push(text),
		);

		expect(taken, "nothing was taken").toEqual([]);
		expect(told, "the window says why").toEqual([ANSWER_GONE]);
	});
});

describe("a steer as the session reads it", () => {
	it("is the person asking, to be answered first, when they or nobody named wrote it", () => {
		expect(
			steerText({ text: "hello", from: "joel", file: "f" }, { busy: true }),
		).toBe(
			"[Joel is asking from outside this window while this session works: answer first, in a line or two, then carry on.]\n\nhello",
		);
		expect(steerText({ text: "hello", file: "f" }, { busy: false })).toBe(
			"[The person is asking from outside this window: answer first, in a line or two, then do what is asked.]\n\nhello",
		);
		expect(
			steerText({ text: "hi", from: "person", file: "f" }, { busy: false }),
		).toMatch(/^\[The person is asking/);
	});

	it("never says a reply may go unread", () => {
		for (const busy of [true, false]) {
			expect(
				steerText({ text: "hello", from: "joel", file: "f" }, { busy }),
			).not.toMatch(/unread/);
		}
	});

	it("says a machine's words aren't the person's", () => {
		const said = steerText(
			{
				text: "this machine leaves at 17:00",
				from: "machine",
				file: "f",
			},
			{ busy: true },
		);
		expect(said).toMatch(
			/^\[Said by this machine's mycelium node, not by the person/,
		);
		expect(said).toMatch(/this machine leaves at 17:00$/);
	});

	it("names the machine's program that wrote it, when it says", () => {
		const said = steerText(
			{
				text: "no builder answers",
				from: "machine",
				by: "nix-offload",
				file: "f",
			},
			{ busy: false },
		);
		expect(said).toMatch(
			/^\[Said by this machine's nix-offload, not by the person/,
		);
	});
});
