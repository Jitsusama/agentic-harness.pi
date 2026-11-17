/**
 * The folder transport: what goes in, what comes out, and how far a
 * peer has read.
 */
import {
	Dir,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WRITING } from "../../../lib/internal/write-whole.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Draft } from "../../../lib/mesh/message.ts";
import { folderTransport, readEachOff } from "../../../lib/mesh/transport.ts";

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

	// A batch read synchronously holds the thread for as long as the
	// disk takes: at 09:14 on 16 November a stalled one held a host's,
	// and every conversation on it, 5 to 17 s at a time.
	it("reads no batch with the thread held", async () => {
		const transport = folderTransport(dir);
		for (let n = 0; n < 600; n++) transport.send(draft({ text: `${n}` }));
		const held = vi.spyOn(Dir.prototype, "readSync");

		try {
			expect(await transport.listIds()).toHaveLength(600);
			expect(held, "no entry was read synchronously").not.toHaveBeenCalled();
		} finally {
			held.mockRestore();
		}
	});

	// mesh_read lists every day's messages and reads them on the thread a
	// host answers every conversation on, so a stalled disk held them all.
	it("lists and reads every day's messages as ids() and read() do, with the thread free", async () => {
		const transport = folderTransport(dir);
		const settled = [
			transport.send(draft({ intent: "fyi", text: "one" })),
			transport.send(draft({ intent: "fyi", text: "two" })),
		];
		transport.settle(Date.now() + 1000);
		const top = transport.send(draft({ intent: "fyi", text: "three" }));
		writeFileSync(join(dir, "2-X-1.json"), "{torn", "utf8");
		// A link to another machine can write a settled message back at the
		// top, beside its day's copy: it is listed once.
		const [again] = settled;
		writeFileSync(join(dir, `${again?.id}.json`), JSON.stringify(again));
		const held = vi.spyOn(Dir.prototype, "readSync");
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		try {
			const listed = await transport.listAllIds();

			expect(turned, "the thread turned while the folders were read").toBe(
				true,
			);
			expect(held, "no entry was read synchronously").not.toHaveBeenCalled();
			expect(listed, "what ids() lists").toEqual(transport.ids());
			expect(new Set(listed).size, "each id once").toBe(listed.length);
			for (const sent of [...settled, top]) {
				let readTurned = false;
				setImmediate(() => {
					readTurned = true;
				});
				const off = await transport.readOff(sent.id);
				expect(readTurned, `the thread turned reading ${sent.text}`).toBe(true);
				expect(off, `${sent.text} reads as read() reads it`).toEqual(
					transport.read(sent.id),
				);
			}
			await expect(
				readEachOff(transport, [top.id, "2-X-1", ...listed]),
				"read in order, a few at a time",
			).resolves.toEqual(
				[top.id, "2-X-1", ...listed].map((id) => transport.read(id)),
			);
			await expect(transport.readOff("2-X-1")).resolves.toBeUndefined();
			await expect(
				folderTransport(join(dir, "never")).listAllIds(),
			).resolves.toEqual([]);
		} finally {
			held.mockRestore();
		}
	});

	it("lists from the day an id was stamped on, passing the days before", () => {
		const transport = folderTransport(dir);
		const day = 24 * 60 * 60 * 1000;
		const at = (ms: number, tail: string) =>
			`${FROZEN_MS + ms}-WCJQSG-7-${tail}`;
		const kept = (id: string) => {
			const folder = new Date(Number(id.split("-")[0]))
				.toISOString()
				.slice(0, 10);
			mkdirSync(join(dir, folder), { recursive: true });
			writeFileSync(join(dir, folder, `${id}.json`), "{}", "utf8");
		};
		const before = at(-2 * day, "aaaaaaaa");
		const earlierThatDay = at(0, "bbbbbbbb");
		const later = at(day, "cccccccc");
		for (const id of [before, earlierThatDay, later]) kept(id);
		// The top is listed whatever its age; where its stamp sorts depends
		// on the process's clock, which earlier tests froze.
		const top = transport.send(draft());

		expect(transport.idsFromDayOf(at(1, "dddddddd"))).toEqual(
			[top.id, earlierThatDay, later].sort(),
		);
		expect(transport.ids()).toEqual(
			[top.id, before, earlierThatDay, later].sort(),
		);
		expect(transport.idsFromDayOf("no-time"), "no time, every day").toEqual(
			transport.ids(),
		);
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

	it("tells a watcher nothing of a message moving to its day's folder", async () => {
		const transport = folderTransport(dir);
		const arrived: string[] = [];
		const stop = transport.watch((id) => arrived.push(id));
		const first = transport.send(draft({ intent: "fyi" }));
		await vi.waitFor(() => expect(arrived).toContain(first.id));

		transport.settle(Date.now() + 1000);
		// What the folder says, it says in order: once the next arrival is
		// told, the move before it has been too.
		const next = transport.send(draft());
		await vi.waitFor(() => expect(arrived).toContain(next.id));
		stop();

		expect(
			arrived.filter((id) => id === first.id),
			"the move was told as an arrival",
		).toHaveLength(1);
		expect(transport.read(first.id)).toMatchObject({ id: first.id });
	});
});
