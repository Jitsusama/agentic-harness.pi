/**
 * Landings: what a session says it landed, how many stand, and when
 * a message only names one.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	isLanding,
	LANDINGS_FOR_MS,
	type Landing,
	MOST_LANDINGS,
	namesLanding,
	onLanded,
	SESSION_LANDED,
	sayLanded,
	standing,
	withLanding,
} from "../../../../lib/internal/session/landings.ts";

const noon = Date.parse("2026-11-01T12:00:00.000Z");
const landing = (ref: string, minutesAgo = 0): Landing => ({
	at: new Date(noon - minutesAgo * 60_000).toISOString(),
	ref,
	what: `${ref} landed`,
});

/** A bus as pi's: emit and on, with a disposer. */
function bus() {
	const emitter = new EventEmitter();
	return {
		emit: (channel: string, data: unknown) => emitter.emit(channel, data),
		on: (channel: string, handler: (data: unknown) => void) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

describe("a landing said on the bus", () => {
	it("is heard with its time and a single line", () => {
		const events = bus();
		const heard: Landing[] = [];
		onLanded(events, (one) => heard.push(one));

		sayLanded(
			events,
			{ ref: "agentic-harness.pi#920", what: "Carry  jobs\nacross" },
			noon,
		);

		expect(heard).toEqual([
			{
				at: "2026-11-01T12:00:00.000Z",
				ref: "agentic-harness.pi#920",
				what: "Carry jobs across",
			},
		]);
	});

	it("is not heard when it isn't one", () => {
		const events = bus();
		const heard: Landing[] = [];
		onLanded(events, (one) => heard.push(one));

		events.emit(SESSION_LANDED, { ref: "core.nix#1", what: "no time" });
		events.emit(SESSION_LANDED, { ...landing(""), ref: "" });

		expect(heard).toEqual([]);
		expect(
			isLanding({ ...landing("x"), person: "Try it" }),
			"a landing whose person's line is text is one",
		).toBe(true);
		expect(
			isLanding({ ...landing("x"), person: 1 }),
			"a landing whose person's line is a number is none",
		).toBe(false);
		expect(
			isLanding({ ...landing("x"), url: "https://x.invalid/1" }),
			"a landing whose url is text is one",
		).toBe(true);
		expect(
			isLanding({ ...landing("x"), url: 1 }),
			"a landing whose url is a number is none",
		).toBe(false);
	});

	it("carries its web page and its person's line when said", () => {
		const events = bus();
		const heard: Landing[] = [];
		onLanded(events, (one) => heard.push(one));

		sayLanded(
			events,
			{
				ref: "core.nix#2140",
				what: "Landed",
				url: " https://github.com/Jitsusama/core.nix/pull/2140 ",
				person: "Try\nit",
			},
			noon,
		);
		sayLanded(events, { ref: "core.nix#2141", what: "x", url: "" }, noon);

		expect(heard[0]).toMatchObject({
			url: "https://github.com/Jitsusama/core.nix/pull/2140",
			person: "Try it",
		});
		expect(heard[1]).not.toHaveProperty("url");
	});
});

describe("the landings standing", () => {
	it("are the day's newest, at most five", () => {
		const many = [
			landing("a#1", 30),
			landing("a#2", 10),
			landing("a#3", LANDINGS_FOR_MS / 60_000 + 1),
			landing("a#4", 20),
			landing("a#5", 5),
			landing("a#6", 1),
			landing("a#7", 40),
		];

		expect(standing(many, noon).map((one) => one.ref)).toEqual(
			["a#6", "a#5", "a#2", "a#4", "a#1"].slice(0, MOST_LANDINGS),
		);
	});

	it("take a ref landing again in place of the earlier one", () => {
		const again = { ...landing("core.nix#1491"), what: "again" };

		expect(
			withLanding(
				[landing("core.nix#1491", 5), landing("core.nix#1490", 3)],
				again,
				noon,
			),
		).toEqual([again, landing("core.nix#1490", 3)]);
	});
});

describe("a message naming a landing", () => {
	const landings = [
		landing("agentic-harness.pi#920"),
		landing("PLAN-20261030-QMUYBH#14a"),
	];

	it.each([
		"#920 is merged and installed.",
		"PR 920 landed.",
		"Ticked 14a in PLAN-20261030-QMUYBH.",
	])("names one: %s", (text) => {
		expect(namesLanding(text, landings), `${text} names a landing`).toBe(true);
	});

	it.each([
		"#9201 is merged.",
		"920 tests pass.",
		"Ticked PLAN-20261030-IH3IS7#7.",
	])("names none: %s", (text) => {
		expect(namesLanding(text, landings), `${text} names no landing`).toBe(
			false,
		);
	});
});
