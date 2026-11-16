/**
 * The read front: the marker moves only past what was handed over. And
 * what a peer starting marks seen: only what it can be shown again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import { createReadFront, seenAtStart } from "../../../lib/mesh/reading.ts";
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
