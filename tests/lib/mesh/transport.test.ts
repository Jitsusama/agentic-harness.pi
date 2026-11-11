/**
 * The folder transport: what goes in, what comes out, and how far a
 * peer has read.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WRITING } from "../../../lib/internal/write-whole.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Draft } from "../../../lib/mesh/message.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let dir: string;

/** A wall clock that stands still, so every id falls in one millisecond. */
const FROZEN_MS = 1_800_000_000_000;

type Transport = typeof import("../../../lib/mesh/transport.ts");

/** A fresh copy of the module, as pi loads one for each conversation. */
async function loadedAgain(): Promise<Transport> {
	vi.resetModules();
	return import("../../../lib/mesh/transport.ts");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mesh-transport-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Partial<Draft> = {}): Draft => ({
	from: "WCJQSG",
	to: [ALL],
	intent: "hold",
	text: "hold heavy builds",
	pid: 1,
	...over,
});

describe("the folder transport", () => {
	it("stamps what it sends and hands it back, oldest first, leaving nothing staged", async () => {
		const transport = folderTransport(join(dir, "messages"));

		const first = transport.send(draft({ text: "one" }));
		const second = transport.send(draft({ text: "two" }));

		expect(first).toMatchObject({ v: 1, from: "WCJQSG", text: "one" });
		expect(Date.parse(first.at)).not.toBeNaN();
		expect(transport.ids()).toEqual([first.id, second.id]);
		expect(transport.read(second.id)).toEqual(second);
		// Staged out of the folder peers watch, and renamed out of that too.
		expect(
			readdirSync(join(dir, "messages")).filter((f) => f.startsWith(".")),
		).toEqual([WRITING]);
		expect(readdirSync(join(dir, "messages", WRITING))).toEqual([]);
	});

	it("keeps two messages sent in the same millisecond", () => {
		const transport = folderTransport(dir);

		for (let n = 0; n < 20; n++) transport.send(draft({ text: `${n}` }));

		expect(transport.ids()).toHaveLength(20);
	});

	it("gives what one process sends ids that rise, within a millisecond too", () => {
		const transport = folderTransport(dir);

		const sent = Array.from({ length: 20 }, (_, n) =>
			transport.send(draft({ text: `${n}` })),
		);

		expect(transport.ids()).toEqual(sent.map(({ id }) => id));
	});

	it("gives ids that rise across every copy of itself in one process", async () => {
		// A host loads a fresh copy of this module for each conversation,
		// all in one process, so one copy's burst within a millisecond
		// must not leave the next copy's id sorting before it.
		vi.spyOn(Date, "now").mockReturnValue(FROZEN_MS);
		const first = await loadedAgain();
		const second = await loadedAgain();

		const burst = Array.from({ length: 3 }, () =>
			first.stampId({ from: "AAAAAA", pid: 1 }),
		);
		const after = second.stampId({ from: "BBBBBB", pid: 1 });

		const lastOfBurst = first.stampedAt(burst.at(-1) ?? "") ?? 0;
		expect(second.stampedAt(after)).toBeGreaterThan(lastOfBurst);
		vi.restoreAllMocks();
	});

	it("passes over a file that is not a message", () => {
		const transport = folderTransport(dir);
		writeFileSync(join(dir, "1-X-1.json"), '{"nope":1}', "utf8");
		writeFileSync(join(dir, "2-X-1.json"), "{torn", "utf8");

		expect(transport.read("1-X-1")).toBeUndefined();
		expect(transport.read("2-X-1")).toBeUndefined();
	});

	it("answers an empty listing when the folder is not there yet", async () => {
		expect(folderTransport(join(dir, "never")).ids()).toEqual([]);
		await expect(
			folderTransport(join(dir, "never")).listIds(),
		).resolves.toEqual([]);
	});

	it("lists a little at a time what it lists at once, oldest first", async () => {
		const transport = folderTransport(dir);
		// More than one batch, sent in no particular order of file name.
		const sent = Array.from({ length: 600 }, (_, n) =>
			transport.send(draft({ text: `${n}` })),
		);
		writeFileSync(join(dir, "notes.txt"), "not a message", "utf8");

		const listed = await transport.listIds();

		expect(listed).toEqual(sent.map((message) => message.id));
		expect(listed).toEqual(transport.ids());
	});

	it("lets other work run between the batches it lists", async () => {
		const transport = folderTransport(dir);
		for (let n = 0; n < 600; n++) transport.send(draft({ text: `${n}` }));
		let turns = 0;
		let listing = true;
		const turn = (): void => {
			turns += 1;
			if (listing) setImmediate(turn);
		};
		setImmediate(turn);

		const listed = await transport.listIds();
		listing = false;

		expect(listed).toHaveLength(600);
		expect(turns, "other work ran between batches").toBeGreaterThan(1);
	});

	it("remembers the furthest a peer has read, under any of its addresses", () => {
		const transport = folderTransport(dir);
		transport.markRead("7M6JKG", "200-A-1");
		transport.markRead("01A15F3A", "300-A-1");

		expect(transport.lastRead(["7M6JKG", "01A15F3A"])).toBe("300-A-1");
		expect(transport.lastRead(["NOBODY"])).toBeUndefined();
	});

	it("never winds a marker back", () => {
		// A watcher can report an older message after a newer one, and a
		// marker wound back hands the newer one out again.
		const transport = folderTransport(dir);
		transport.markRead("7M6JKG", "300-A-1");
		transport.markRead("7M6JKG", "200-A-1");

		expect(transport.lastRead(["7M6JKG"])).toBe("300-A-1");
	});

	it("tells a watcher each message that arrives, until it stops", async () => {
		const transport = folderTransport(dir);
		const arrived: string[] = [];
		const stop = transport.watch((id) => arrived.push(id));

		const sent = transport.send(draft());

		await vi.waitFor(() => expect(arrived).toContain(sent.id));
		stop();
	});
});
