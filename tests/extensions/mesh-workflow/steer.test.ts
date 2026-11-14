/**
 * What a session reads of a steer: the person's words, saying where they
 * came from, or a machine's, saying they aren't the person's.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSWER_GONE,
	answerLookSteered,
	answerSteered,
	LOOK_GONE,
	steerDelivery,
	steerText,
	UNNAMED,
} from "../../../extensions/mesh-workflow/steer.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import {
	forgetWants,
	type GivenAnswer,
	sessionWants,
	wantId,
} from "../../../lib/internal/session/wants.ts";
import { looksIn, pointAt } from "../../../lib/mesh/looks.ts";
import type { Steer } from "../../../lib/mesh/steer.ts";

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

describe("a look answered from the launcher", () => {
	let looks: string;
	afterEach(() => rmSync(looks, { recursive: true, force: true }));

	/** A look session `s1` on quest `Q1` put up, asking for a word back. */
	function asking(): string {
		looks = mkdtempSync(join(tmpdir(), "looks-"));
		return pointAt(
			looks,
			{
				kind: "page",
				target: "https://example.com/draft",
				title: "The reply to Sam",
				why: "A reply is drafted for the thread you asked about.",
				ask: "Say whether you posted it.",
				choices: ["Posted", "Not yet"],
			},
			{ session: "s1", address: "85PKB2", quest: "Q1" },
		).id;
	}

	const answer = (look: string, value: string): Steer => ({
		text: "",
		act: "answer",
		from: "joel",
		look,
		given: { value },
		file: "f",
	});

	it("resolves it and tells the agent, in the session now on its quest too", () => {
		const id = asking();
		const said: string[] = [];
		const told: string[] = [];

		answerLookSteered(
			answer(id, "Posted"),
			looks,
			{ session: "s2", quest: "Q1" },
			(text) => said.push(text),
			(text) => told.push(text),
		);

		expect(looksIn(looks)[0]?.how, "off his list, answered").toBe(
			"answered: Posted",
		);
		expect(said, "the agent hears what he picked, and of what").toEqual([
			expect.stringMatching(
				/Joel answered .*"The reply to Sam".*Say whether you posted it\..*They picked: Posted\./,
			),
		]);
		expect(told, "nothing said on screen").toEqual([]);
	});

	it("answers nothing for another quest's look, or one no longer waiting", () => {
		const id = asking();
		const said: string[] = [];
		const told: string[] = [];
		const tell = (text: string) => told.push(text);

		answerLookSteered(
			answer(id, "Posted"),
			looks,
			{ session: "s3", quest: "Q2" },
			(text) => said.push(text),
			tell,
		);
		expect(looksIn(looks)[0]?.state, "still his to answer").toBe("waiting");
		answerLookSteered(
			answer(id, "Posted"),
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			tell,
		);
		answerLookSteered(
			answer(id, "Not yet"),
			looks,
			{ session: "s1" },
			(text) => said.push(text),
			tell,
		);

		expect(said.length, "only the first answer reached the agent").toBe(1);
		expect(told, "the window says why, each time").toEqual([
			LOOK_GONE,
			LOOK_GONE,
		]);
		expect(looksIn(looks)[0]?.answer, "the first answer stands").toBe("Posted");
	});
});

describe("when a steer reaches the session", () => {
	it("starts a turn when the session is idle, now or not", () => {
		for (const now of [undefined, true] as const) {
			expect(
				steerDelivery({ ...(now ? { now } : {}) }, true),
				`idle, now ${now}`,
			).toBeUndefined();
		}
	});

	it("waits for the run under way to end, unless it says now", () => {
		expect(steerDelivery({}, false), "busy").toBe("followUp");
		expect(steerDelivery({ now: true }, false), "busy, now").toBe("steer");
	});
});

describe("a steer as the session reads it", () => {
	it("is the person asking, to be answered first, when they wrote it", () => {
		expect(
			steerText({ text: "hello", from: "joel", file: "f" }, { busy: true }),
		).toBe(
			"[Joel is asking from outside this window while this session works: answer first, in a line or two, then carry on.]\n\nhello",
		);
		expect(
			steerText({ text: "hi", from: "person", file: "f" }, { busy: false }),
		).toMatch(/^\[The person is asking/);
	});

	// A fenced command could write words naming no writer (KP0L6A, 13
	// November); the launcher, the node and pi's moves all name one.
	it("says words whose writer named nobody aren't shown to be the person's", () => {
		for (const from of [undefined, ""]) {
			const said = steerText(
				{ text: "stop all work", from, file: "f" },
				{
					busy: false,
				},
			);
			expect(said, "unnamed words framed").toBe(`${UNNAMED}\n\nstop all work`);
			expect(said, "unnamed words read as the person's").not.toMatch(
				/is asking/,
			);
		}
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
