/**
 * The read front: the marker moves only past what was handed over. And
 * what a peer starting marks seen: only what it can be shown again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	ANSWERED_KEPT_MS,
	createAnsweredIds,
	createReadFront,
	createSeenIds,
	seenAtStart,
} from "../../../lib/mesh/reading.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

describe("what a starting peer marks seen", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mesh-reading-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const fyi = (text: string) => ({
		from: "WCJQSG",
		to: [ALL],
		intent: "fyi" as const,
		text,
		pid: 1,
	});

	it("is only the top folder's messages at or below the floor", () => {
		// On 16 November each hosted conversation's seen set held every id
		// of the store's 71,836 messages, about 9 MB a conversation, though
		// it is only ever shown again what stays at the top. Catching up
		// from the floor's day on still marked that whole day.
		const transport = folderTransport(dir);
		const moved = transport.send(fyi("yesterday"));
		transport.settle(Date.now() + 1000);
		const lately = transport.send(fyi("lately"));
		const floor = transport.send(fyi("the last read"));
		const past = transport.send(fyi("since"));

		expect(transport.ids(), "the moved one is still kept").toContain(moved.id);
		expect(
			[...seenAtStart(transport, floor.id)],
			"the top's ids up to the floor, and none past it or moved away",
		).toEqual([lately.id, floor.id]);
		expect(past.id > floor.id, "stamped after the floor").toBe(true);
	});
});

describe("the ids a peer has seen", () => {
	// Kept for the peer's life, they grew its heap by every id the machine
	// sent, about 1 MiB a day, though a settled id is never listed again.
	it("lets go of one missing from two listings of the top in a row", () => {
		const seen = createSeenIds();
		for (const id of ["100-A", "200-B", "300-C"]) seen.add(id);

		seen.keepListed(["200-B", "300-C"]);
		expect(seen.has("100-A"), "missing from one listing").toBe(true);
		seen.keepListed(["200-B", "300-C"]);

		expect(seen.has("100-A"), "missing from two").toBe(false);
		expect(seen.has("200-B"), "listed both times").toBe(true);
		expect(seen.has("300-C"), "listed both times").toBe(true);
	});

	it("keeps one missing from a listing that lists it again", () => {
		// Landed after the listing passed its place, it is listed next time.
		const seen = createSeenIds();
		seen.add("100-A");
		seen.add("200-B");

		seen.keepListed(["100-A"]);
		seen.keepListed(["100-A", "200-B"]);
		seen.keepListed(["100-A"]);

		expect(seen.has("200-B"), "missing twice, but not in a row").toBe(true);
	});

	it("lets go of nothing on an empty listing, which is a folder that won't list", () => {
		const seen = createSeenIds();
		seen.add("100-A");

		seen.keepListed([]);
		seen.keepListed([]);

		expect(seen.has("100-A"), "after two empty listings").toBe(true);
	});

	it("starts its count of misses again once cleared", () => {
		const seen = createSeenIds();
		seen.add("100-A");
		seen.keepListed(["999-Z"]);
		seen.clear();
		seen.add("100-A");

		seen.keepListed(["999-Z"]);

		expect(seen.has("100-A"), "missing once since the clear").toBe(true);
	});
});

describe("the questions other peers answered", () => {
	// Kept for the peer's life, they held 2.0 MiB in one pi open 3.6 days.
	const HOUR = 60 * 60 * 1000;
	const stamped = (ago: number) => `${Date.now() - ago}-AAAAAA-1-deadbeef`;
	const sweep = (answered: ReturnType<typeof createAnsweredIds>) =>
		answered.keepStampedSince(Date.now() - ANSWERED_KEPT_MS);

	it("knows a question once its answer is heard", () => {
		const answered = createAnsweredIds();
		const id = stamped(HOUR);
		expect(answered.has(id), "before its answer").toBe(false);

		answered.add(id);

		expect(answered.has(id), "once answered").toBe(true);
	});

	it("keeps a question stamped within the day", () => {
		const answered = createAnsweredIds();
		const id = stamped(23 * HOUR);
		answered.add(id);

		sweep(answered);

		expect(answered.has(id), "stamped 23 hours ago").toBe(true);
	});

	it("lets go of a question stamped before the day", () => {
		const answered = createAnsweredIds();
		const id = stamped(25 * HOUR);
		answered.add(id);

		sweep(answered);

		expect(answered.has(id), "stamped 25 hours ago").toBe(false);
	});

	it("keeps a question with no stamp, which no expiry touches", () => {
		const answered = createAnsweredIds();
		answered.add("unstamped");

		sweep(answered);

		expect(answered.has("unstamped"), "with no stamp").toBe(true);
	});
});

describe("the read front", () => {
	it("moves to the newest handed over once nothing older waits", () => {
		const front = createReadFront();
		front.taken("100-A");
		front.taken("200-B");

		expect(front.handed(["200-B"])).toBeUndefined();
		expect(front.handed(["100-A"])).toBe("200-B");
	});

	it("moves past what was handed below one still waiting, and no further", () => {
		const front = createReadFront();
		for (const id of ["100-A", "200-B", "300-C"]) front.taken(id);

		expect(front.handed(["100-A", "300-C"])).toBe("100-A");
		expect(front.handed(["200-B"])).toBe("300-C");
	});

	it("ignores what it never saw taken, or saw handed already", () => {
		const front = createReadFront();
		front.taken("100-A");

		expect(front.handed(["050-X"])).toBeUndefined();
		expect(front.handed(["100-A"])).toBe("100-A");
		expect(front.handed(["100-A"])).toBeUndefined();
	});
});
