/**
 * What a session says it wants of its person: each want said when it
 * starts, changes and ends, across a reload, and only once a panel has
 * gone unanswered a while.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASKED_CHARS,
	answerWant,
	createOwnWants,
	createWants,
	forgetWants,
	type GivenAnswer,
	givenFrom,
	onWants,
	ownWants,
	SAID_CHARS,
	sessionWants,
	showWants,
	type WantEvent,
	waitedOn,
	wantId,
	wantsShown,
} from "../../../../lib/internal/session/wants.ts";

const AT = new Date("2026-10-22T08:00:00.000Z");
const LATER = new Date("2026-10-22T08:05:00.000Z");

/** A bus with wants bound to it, and everything said on it. */
function bound() {
	const bus = createEventBus();
	const heard: WantEvent[] = [];
	onWants(bus, (want) => heard.push(want));
	const wants = createWants();
	wants.bind(bus);
	return { bus, heard, wants };
}

afterEach(() => {
	vi.useRealTimers();
	forgetWants();
});

describe("a want", () => {
	it("is said when it starts and when it ends", () => {
		const { heard, wants } = bound();

		const lower = wants.raise("approval", "Open PR #1", AT);
		lower();

		expect(heard).toEqual([
			{ kind: "approval", since: AT.toISOString(), said: "Open PR #1" },
			{ kind: "approval", said: null },
		]);
	});

	it("keeps when it started as what it says changes, and ends with its last raising", () => {
		const { heard, wants } = bound();

		const first = wants.raise("approval", "Open PR #1", AT);
		const second = wants.raise("approval", "Open PR #2", LATER);
		first();

		expect(heard).toEqual([
			{ kind: "approval", since: AT.toISOString(), said: "Open PR #1" },
			{ kind: "approval", since: AT.toISOString(), said: "Open PR #2" },
		]);
		second();
		expect(heard.at(-1)).toEqual({ kind: "approval", said: null });
	});

	it("ends one kind only, so an ask and an approval stand apart", () => {
		const { heard, wants } = bound();
		wants.raise("question", "Which?", AT);
		wants.raise("approval", "Open PR #1", AT);

		wants.end("question");

		expect(heard.at(-1)).toEqual({ kind: "question", said: null });
		expect(heard.filter((w) => w.kind === "approval")).toHaveLength(1);
	});

	it("lowered twice, or after it ended and was raised afresh, ends nothing", () => {
		const { heard, wants } = bound();
		const stale = wants.raise("blocked", "needs your OTP", AT);
		wants.end("blocked");
		wants.raise("blocked", "needs your OTP", LATER);

		stale();
		stale();

		expect(heard.at(-1)).toEqual({
			kind: "blocked",
			since: LATER.toISOString(),
			said: "needs your OTP",
		});
	});

	it("says one line, cut short past what a launcher shows", () => {
		const { heard, wants } = bound();

		wants.raise("question", `Which\n  one ${"x".repeat(200)}?`, AT);

		const said = heard[0]?.said ?? "";
		expect(said).toMatch(/^Which one x/);
		expect(said).toHaveLength(SAID_CHARS);
		expect(said).toMatch(/\u2026$/);
	});

	// The same breaks a listing folds, hidden ones included: a variation
	// selector and a blank letter are no format or control character, so
	// only a listing's own class folds them.
	it("says a want broken by a hidden character on one line", () => {
		const { heard, wants } = bound();

		wants.raise(
			"question",
			"Push?\u2060\u0085\u200f\uFE0F\u3164OWNERQ: yes",
			AT,
		);

		expect(heard[0]?.said).toBe("Push? OWNERQ: yes");
	});

	it("is said again on the bus bound after a reload, and never on the old one", () => {
		const old = bound();
		old.wants.raise("blocked", "needs your OTP", AT);
		old.wants.unbind(old.bus);
		const fresh = createEventBus();
		const heard: WantEvent[] = [];
		onWants(fresh, (want) => heard.push(want));

		old.wants.bind(fresh);
		old.wants.end("blocked");

		expect(heard).toEqual([
			{ kind: "blocked", since: AT.toISOString(), said: "needs your OTP" },
			{ kind: "blocked", said: null },
		]);
		expect(old.heard).toHaveLength(1);
	});

	it("ignores a payload that is not one", () => {
		const bus = createEventBus();
		const heard: WantEvent[] = [];
		onWants(bus, (want) => heard.push(want));

		bus.emit("session:wants:v1", { kind: "lunch", said: null });
		bus.emit("session:wants:v1", { kind: "question", said: "no since" });

		expect(heard).toEqual([]);
	});
});

// A run that ended on two questions said only the last, cut to a line,
// and the person couldn't answer from the launcher (24 November).
describe("a want's whole ask", () => {
	const REPLY =
		"Two things before I go on:\n\n\n\n1. Keep the cache?\n2. The signing pause: yes, no or partly?";

	it("is said beside its line, its paragraphs kept", () => {
		const { heard, wants } = bound();

		wants.raise(
			"question",
			"2. The signing pause: yes, no or partly?",
			AT,
			undefined,
			REPLY,
		);

		expect(heard).toEqual([
			{
				kind: "question",
				since: AT.toISOString(),
				said: "2. The signing pause: yes, no or partly?",
				asked:
					"Two things before I go on:\n\n1. Keep the cache?\n2. The signing pause: yes, no or partly?",
			},
		]);
	});

	it("holds each of its lines to one, so nothing in it redraws a screen", () => {
		const { heard, wants } = bound();

		wants.raise(
			"blocked",
			"OTP",
			AT,
			undefined,
			"Needs\u001b[2J your\r\nOTP\u2028now",
		);

		expect(heard[0] && "asked" in heard[0] ? heard[0].asked : undefined).toBe(
			"Needs [2J your\nOTP now",
		);
	});

	it("is left out where it says no more than the line", () => {
		const { heard, wants } = bound();

		wants.raise(
			"question",
			"Which launcher?",
			AT,
			undefined,
			"  Which launcher?\n",
		);

		expect(heard[0]).not.toHaveProperty("asked");
	});

	it("is cut in its middle, keeping the start and the questions it ends on", () => {
		const { heard, wants } = bound();
		const long = `What I did.\n\n${Array.from({ length: 1000 }, () => "word").join(" ")}\n\n1. Keep the cache?\n2. Sign now?`;

		wants.raise("question", "2. Sign now?", AT, undefined, long);

		const asked = heard[0] && "asked" in heard[0] ? (heard[0].asked ?? "") : "";
		expect(asked.length).toBeLessThanOrEqual(ASKED_CHARS);
		expect(asked.length).toBeGreaterThan(ASKED_CHARS - 40);
		expect(asked).toMatch(/^What I did\.\n\nword word/);
		expect(asked).toMatch(/word\n\n1\. Keep the cache\?\n2\. Sign now\?$/);
		const [head = "", count = "", tail = ""] = asked.split(
			/\n\n\u2026 \((\d+) characters cut\)\n\n/,
		);
		expect(
			head.length + Number(count) + tail.length,
			"the cut says how much went",
		).toBe(long.length);
	});

	it("never splits a character at its cut", () => {
		const { heard, wants } = bound();
		// One letter first, so the start's cut falls inside a pair.
		const rockets = `x${"\u{1F680}".repeat(ASKED_CHARS)}`;

		wants.raise("question", "Go?", AT, undefined, `${rockets}\nGo?`);

		const asked = heard[0] && "asked" in heard[0] ? (heard[0].asked ?? "") : "";
		expect(asked.length).toBeLessThanOrEqual(ASKED_CHARS);
		expect(asked, "no lone half of a pair").not.toMatch(/\p{Cs}/u);
		expect(asked).toMatch(/\nGo\?$/);
	});

	it("keeps the indentation of its lists and code", () => {
		const { heard, wants } = bound();

		wants.raise(
			"question",
			"2. Signing?",
			AT,
			undefined,
			"1. Cache?\n   - keep  it\n   - drop it\n2. Signing?",
		);

		expect(heard[0] && "asked" in heard[0] ? heard[0].asked : undefined).toBe(
			"1. Cache?\n   - keep  it\n   - drop it\n2. Signing?",
		);
	});

	it("puts a credential it quotes out of sight", () => {
		const { heard, wants } = bound();
		const token = `ghp_${"aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4".slice(0, 36)}`;

		wants.raise(
			"blocked",
			"Blocked: the push",
			AT,
			undefined,
			`Tried with ${token}.\n\nBlocked: the push`,
		);

		const asked = heard[0] && "asked" in heard[0] ? (heard[0].asked ?? "") : "";
		expect(asked).toMatch(/Blocked: the push$/);
		expect(asked).not.toContain(token);
	});

	it("is said again when it alone changes, and not when nothing does", () => {
		const { heard, wants } = bound();

		wants.raise("question", "Go on?", AT, undefined, "First.\n\nGo on?");
		wants.raise("question", "Go on?", AT, undefined, "First.\n\nGo on?");
		wants.raise("question", "Go on?", AT, undefined, "Second.\n\nGo on?");
		wants.raise("question", "Go on?", AT);

		expect(heard.map((one) => ("asked" in one ? one.asked : "none"))).toEqual([
			"First.\n\nGo on?",
			"Second.\n\nGo on?",
			"none",
		]);
	});

	it("goes with an owner's want and a panel's", async () => {
		vi.useFakeTimers();
		const { heard, wants } = bound();
		createOwnWants(wants).say("blocked", "needs your OTP", AT, REPLY);
		let answer: (value: string) => void = () => undefined;
		const waited = waitedOn(
			"approval",
			"Open PR #1",
			new Promise<string>((resolve) => {
				answer = resolve;
			}),
			wants,
			10,
			undefined,
			"Open PR #1\n\nagainst main",
		);
		vi.advanceTimersByTime(10);
		answer("yes");
		await waited;

		expect(
			heard
				.filter((one) => one.said !== null)
				.map((one) => ("asked" in one ? one.asked : undefined)),
		).toEqual([
			"Two things before I go on:\n\n1. Keep the cache?\n2. The signing pause: yes, no or partly?",
			"Open PR #1\n\nagainst main",
		]);
	});
});

describe("an owner's wants", () => {
	it("replace what each kind says without ending it between", () => {
		const { heard, wants } = bound();
		const own = createOwnWants(wants);

		own.say("approval", "Holds a call for you: Open PR #1", AT);
		own.say("approval", "Holds 2 calls for you, the latest: Open PR #2", LATER);
		own.settle("approval");

		expect(heard.map((w) => w.said)).toEqual([
			"Holds a call for you: Open PR #1",
			"Holds 2 calls for you, the latest: Open PR #2",
			null,
		]);
	});

	it("are the same ones for a reloaded copy of the extension", () => {
		const bus = createEventBus();
		const heard: WantEvent[] = [];
		onWants(bus, (want) => heard.push(want));
		sessionWants().bind(bus);

		ownWants("away-workflow").say("blocked", "needs your OTP", AT);
		ownWants("away-workflow").settle("blocked");

		expect(heard.at(-1)).toEqual({ kind: "blocked", said: null });
	});
});

describe("a panel waited on", () => {
	it("says nothing when answered at a glance", async () => {
		vi.useFakeTimers();
		const { heard, wants } = bound();

		const answer = waitedOn(
			"approval",
			"Open PR #1",
			Promise.resolve("yes"),
			wants,
			5_000,
		);

		await expect(answer).resolves.toBe("yes");
		vi.advanceTimersByTime(10_000);
		expect(heard).toEqual([]);
	});

	it("wants its person once unanswered a while, dated from when it opened, until answered", async () => {
		vi.useFakeTimers({ now: AT });
		const { heard, wants } = bound();
		let answer: (value: string) => void = () => {};
		const shown = new Promise<string>((resolve) => {
			answer = resolve;
		});

		const waited = waitedOn("question", "Which?", shown, wants, 5_000);
		vi.advanceTimersByTime(5_000);
		expect(heard).toEqual([
			{ kind: "question", since: AT.toISOString(), said: "Which?" },
		]);

		answer("that one");
		await expect(waited).resolves.toBe("that one");
		expect(heard.at(-1)).toEqual({ kind: "question", said: null });
	});

	it("stops wanting when the panel fails as well", async () => {
		vi.useFakeTimers();
		const { heard, wants } = bound();
		let fail: (error: Error) => void = () => {};
		const shown = new Promise<string>((_resolve, reject) => {
			fail = reject;
		});

		const waited = waitedOn("approval", "Open PR #1", shown, wants, 5_000);
		vi.advanceTimersByTime(5_000);
		fail(new Error("session ended"));

		await expect(waited).rejects.toThrow("session ended");
		expect(heard.at(-1)).toEqual({ kind: "approval", said: null });
	});
});

describe("an ask answered from away", () => {
	const CHOICES = {
		choices: [
			{ value: "keep", label: "Keep it", description: "As it reads now" },
			{ value: "back", label: "Roll it back" },
		],
		recommended: "keep",
		allowOther: true,
	};

	/** An ask raised on fresh wants, and every answer its panel took. */
	function asked(allowOther = true) {
		const { heard, wants } = bound();
		const taken: GivenAnswer[] = [];
		const lower = wants.raise("question", "Keep the bar?", AT, {
			...CHOICES,
			allowOther,
			take: (given) => taken.push(given),
		});
		return { heard, lower, taken, wants };
	}
	const ID = wantId("question", AT.toISOString());

	it("says its choices, without what takes the answer", () => {
		const { heard } = asked();

		expect(heard, "the want says the ask's choices as they are").toEqual([
			{
				kind: "question",
				since: AT.toISOString(),
				said: "Keep the bar?",
				ask: CHOICES,
			},
		]);
	});

	it("reaches its panel with a choice it offers, or words it allows", () => {
		const { taken, wants } = asked();

		expect(answerWant(ID, { value: "back" }, wants), "a choice").toBe(true);
		expect(answerWant(ID, { other: "Shorter" }, wants), "words").toBe(true);
		expect(taken, "the panel took both as given").toEqual([
			{ value: "back" },
			{ other: "Shorter" },
		]);
	});

	it("takes nothing it doesn't offer, nor for a want gone or never raised", () => {
		const { lower, taken, wants } = asked(false);

		expect(answerWant(ID, { value: "maybe" }, wants), "no such choice").toBe(
			false,
		);
		expect(answerWant(ID, { other: "Shorter" }, wants), "no words").toBe(false);
		expect(
			answerWant(wantId("question", LATER.toISOString()), { value: "keep" }),
			"another want's id",
		).toBe(false);
		lower();
		expect(answerWant(ID, { value: "keep" }, wants), "its want ended").toBe(
			false,
		);
		expect(taken, "the panel took nothing").toEqual([]);
	});

	it("drops its choices once its own panel goes while the want stands", () => {
		const { heard, wants } = bound();
		const plain = wants.raise("question", "Keep the bar?", AT);
		const lower = wants.raise("question", "Keep the bar?", AT, {
			...CHOICES,
			take: () => {},
		});
		lower();

		expect(heard.at(-1), "the want stands without choices").toEqual({
			kind: "question",
			since: AT.toISOString(),
			said: "Keep the bar?",
		});
		expect(answerWant(ID, { value: "keep" }, wants), "nothing takes it").toBe(
			false,
		);
		plain();
	});

	it("is answered by nothing on wants from before answers were kept", () => {
		const { answer: _gone, ...old } = createWants();

		expect(answerWant(ID, { value: "keep" }, old), "an old copy's wants").toBe(
			false,
		);
	});

	it("reads an answer given from outside, and nothing that is none", () => {
		expect(givenFrom({ value: "keep" }), "a choice").toEqual({
			value: "keep",
		});
		expect(givenFrom({ other: "Shorter" }), "words").toEqual({
			other: "Shorter",
		});
		expect(givenFrom({ value: 3 }), "not words").toBeUndefined();
		expect(givenFrom("keep"), "not an answer").toBeUndefined();
	});
});

describe("wants shown to the person", () => {
	afterEach(() => forgetWants());

	it("are shown while any showing stands, each hidden once", () => {
		expect(wantsShown(), "nothing is shown before any showing").toBe(false);
		const old = showWants();
		// A reload's new copy shows them before the old copy hides its own.
		const reloaded = showWants();
		old();
		old();

		expect(
			wantsShown(),
			"the reloaded copy's showing stands though the old one hid twice",
		).toBe(true);
		reloaded();
		expect(wantsShown(), "nothing is shown once every showing is hidden").toBe(
			false,
		);
	});
});
