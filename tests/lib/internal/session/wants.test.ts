/**
 * What a session says it wants of its person: each want said when it
 * starts, changes and ends, across a reload, and only once a panel has
 * gone unanswered a while.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOwnWants,
	createWants,
	forgetWants,
	onWants,
	ownWants,
	SAID_CHARS,
	sessionWants,
	type WantEvent,
	waitedOn,
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
		expect(said.startsWith("Which one x")).toBe(true);
		expect(said).toHaveLength(SAID_CHARS);
		expect(said.endsWith("\u2026")).toBe(true);
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
