/**
 * A running session waking a parked one on its machine for a message a
 * node carried in from another machine, which no sender here woke for:
 * heard as the message lands, before what reaches the running session
 * is sorted out, since a question to the parked peer's own home reaches
 * nobody else.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeParked } from "../../../lib/internal/session/park.ts";
import { homeOf } from "../../../lib/mesh/group.ts";
import { ENVELOPE, type Message } from "../../../lib/mesh/message.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import { writeAtomically } from "../../../lib/mesh/transport.ts";
import { fixture, fromElsewhere, startSession } from "./support/mesh.ts";

/** Two parked sessions here, by session and address. */
const asleep = {
	first: { session: "01a1fc10-93e7-77b8-95cc-2a7894d52cae", address: "4U90K6" },
	second: {
		session: "01a1fc2b-0d1e-7a41-9c3f-5e2b8d7a6c10",
		address: "7QH2LM",
	},
};

/** How long a wake has to land after its message does, in milliseconds. */
const WAKE_WITHIN_MS = 5000;

/** How far back a session with no read marker catches up, as start.ts. */
const FIRST_CATCH_UP_MS = 60 * 60 * 1000;

/** A day, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A question to a parked session's home, stamped by its sender before
 * the catch-up a session started now reads from, landing late as a node
 * carrying it from another machine would write it. Its stamp stays on
 * the catch-up's day, which messages from a day before never leave.
 */
function carriedLate(address: string): Message {
	const catchUp = Date.now() - FIRST_CATCH_UP_MS;
	const stamp = Math.max(
		catchUp - 60_000,
		Math.floor(catchUp / DAY_MS) * DAY_MS,
	);
	const pid = process.pid + 1;
	const message: Message = {
		v: ENVELOPE,
		id: `${stamp}-85PKB2-${pid}-0a1b2c3d`,
		at: new Date(stamp).toISOString(),
		from: "85PKB2",
		to: [homeOf(address)],
		intent: "question",
		text: "are you awake?",
		pid,
	};
	writeAtomically(
		join(fixture.paths.mesh, "messages"),
		`${message.id}.json`,
		JSON.stringify(message),
	);
	return message;
}

/** The file a parked session's holder wakes it on. */
const wakeOf = (address: string) => join(fixture.root, `${address}.wake`);

/** Publish a presence as its peer, or the node carrying it, would. */
function present(over: Partial<Presence> & Pick<Presence, "session">) {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		addresses: [],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
		...over,
	});
}

/** Park a session as it would park itself: its marker, then its presence. */
function park(one: { session: string; address: string }) {
	writeParked({
		session: one.session,
		sessionFile: join(fixture.root, `${one.session}.jsonl`),
		cwd: fixture.root,
		addresses: [one.address],
		parkedAt: new Date().toISOString(),
		pid: process.pid + 2,
		wake: wakeOf(one.address),
	});
	present({ session: one.session, addresses: [one.address], state: "parked" });
}

/** What a parked session's holder was asked to wake it for, if anything. */
function wokenFor(address: string): string | undefined {
	if (!existsSync(wakeOf(address))) return undefined;
	return JSON.parse(readFileSync(wakeOf(address), "utf8")).messageId;
}

/** A question from 85PKB2, on optimus, to one parked session's home. */
function carriedTo(address: string, intent: Message["intent"] = "question") {
	return fromElsewhere({
		from: "85PKB2",
		to: [homeOf(address)],
		intent,
		text: "are you awake?",
	});
}

beforeEach(() => {
	vi.stubEnv("XDG_STATE_HOME", join(fixture.root, "state"));
	park(asleep.first);
	park(asleep.second);
	// A session on optimus, whose presence the node carried here.
	present({
		session: "01a1ecc0-0ce5-76e8-8e98-0c2d25243c75",
		addresses: ["85PKB2"],
		machine: "optimus",
	});
	// A session running on this machine beside the test's own.
	present({
		session: "01a1f70c-4fd2-7507-ad15-fc884e9a9e0f",
		addresses: ["P9R1KI"],
	});
});

describe("a message carried in to a parked session's own home", () => {
	it("wakes it, though it reaches no session running here", async () => {
		await startSession();
		const question = carriedTo(asleep.first.address);
		await vi.waitFor(
			() => expect(wokenFor(asleep.first.address)).toBe(question.id),
			{ timeout: WAKE_WITHIN_MS },
		);
	});

	it("is woken for by a session starting after it landed", async () => {
		const question = carriedTo(asleep.first.address);
		await startSession();
		await vi.waitFor(
			() => expect(wokenFor(asleep.first.address)).toBe(question.id),
			{ timeout: WAKE_WITHIN_MS },
		);
	});

	it("wakes it when it lands stamped before the catch-up", async () => {
		await startSession();
		const late = carriedLate(asleep.first.address);
		await vi.waitFor(
			() => expect(wokenFor(asleep.first.address)).toBe(late.id),
			{ timeout: WAKE_WITHIN_MS },
		);
	});

	// Each case lands its message before one that wakes the second parked
	// session, so once that wake is asked the first message was judged too.
	it("is left to its sender when that sender runs here", async () => {
		await startSession();
		fromElsewhere({
			from: "P9R1KI",
			to: [homeOf(asleep.first.address)],
			intent: "question",
			text: "are you awake?",
		});
		const question = carriedTo(asleep.second.address);
		await vi.waitFor(
			() => expect(wokenFor(asleep.second.address)).toBe(question.id),
			{ timeout: WAKE_WITHIN_MS },
		);
		expect(wokenFor(asleep.first.address)).toBeUndefined();
	});

	it("wakes nobody when it gives no turn", async () => {
		await startSession();
		carriedTo(asleep.first.address, "fyi");
		const question = carriedTo(asleep.second.address);
		await vi.waitFor(
			() => expect(wokenFor(asleep.second.address)).toBe(question.id),
			{ timeout: WAKE_WITHIN_MS },
		);
		expect(wokenFor(asleep.first.address)).toBeUndefined();
	});
});
