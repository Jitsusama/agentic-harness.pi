/**
 * A message is never lost and never handed over twice: through a
 * session switched out, a watcher that never reports it, an old copy
 * written back, a message caught half written, and what retention
 * lets go of.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delivered } from "../../../extensions/mesh-workflow/delivery.ts";
import { SWEPT_STAMP } from "../../../lib/mesh/retention.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	judging,
	notYours,
	type Sent,
	session,
	startSession,
} from "./support/mesh.ts";

// The folder's watcher, as a test can have it: deaf, as one is when the
// kernel drops its events, and with a message landing as it is armed.
const watching = vi.hoisted(() => ({
	deaf: false,
	armed: undefined as (() => void) | undefined,
}));
// The folders listed, while a test keeps a list of them.
const listing = vi.hoisted(() => ({ dirs: undefined as string[] | undefined }));
// The files read, while a test keeps a list of them.
const reading = vi.hoisted(() => ({ files: undefined as string[] | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
			listing.dirs?.push(String(args[0]));
			return fs.readdirSync(...args);
		}) as typeof fs.readdirSync,
		readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
			reading.files?.push(String(args[0]));
			return fs.readFileSync(...args);
		}) as typeof fs.readFileSync,
		watch: ((...args: Parameters<typeof fs.watch>) => {
			watching.armed?.();
			return watching.deaf ? { close() {} } : fs.watch(...args);
		}) as typeof fs.watch,
	};
});

beforeEach(() => {
	watching.deaf = false;
	watching.armed = undefined;
	listing.dirs = undefined;
	reading.files = undefined;
});

describe("a session switched out", () => {
	it("lets go of a message still being judged, never reading the old session's context", async () => {
		// On 29 October a rollover switched a session out while its mesh
		// was mid-way through work; that work then read the old context,
		// which pi had made stale, and the throw cost the session its ears.
		let answer: (value: unknown) => void = () => {};
		let judged = false;
		let stale = false;
		let staleReads = 0;
		const read = <T>(value: T): T => {
			if (stale) staleReads += 1;
			return value;
		};
		const first = await startSession(
			{},
			{
				modelRegistry: {
					getAvailableOfType: async () => [
						{ provider: "typesafe", id: "jev-latest" },
					],
					classify: () =>
						new Promise((resolve) => {
							judged = true;
							answer = resolve;
						}),
				},
				isIdle: () => read(true),
				sessionManager: {
					getSessionId: () => read(session),
					getSessionFile: () => read(join(fixture.root, `${session}.jsonl`)),
					getBranch: () => read([]),
					getSessionName: () => read(undefined),
					getCwd: () => read(fixture.root),
				},
			},
		);
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() =>
			expect(judged, "the message reached the classifier").toBe(true),
		);

		await first.fire("session_shutdown", { reason: "resume" });
		stale = true;
		answer({ stopReason: "stop", answers: { about: notYours } });
		// A real pause: the test is that the late verdict reads and sends nothing.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(staleReads).toBe(0);
		expect(first.sent).toEqual([]);
	});
});

describe("a message never lost", () => {
	const slow = { settleMs: 400, spreadMs: 0 };
	const day = 24 * 60 * 60 * 1000;

	/** The day's folder a message stamped at this time settles into. */
	const dayFolder = (at: number) =>
		join(fixture.paths.mesh, "messages", new Date(at).toISOString().slice(0, 10));

	/** A question to this peer stamped at this time, kept in its day's folder. */
	const settled = (at: number, text: string): string => {
		const id = `${at}-WCJQSG-7-dddddddd`;
		mkdirSync(dayFolder(at), { recursive: true });
		writeFileSync(
			join(dayFolder(at), `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				at: new Date(at).toISOString(),
				from: "WCJQSG",
				to: ["@7M6JKG"],
				intent: "question",
				text,
				pid: 7,
			}),
		);
		return id;
	};

	/** Every message text handed over in full, once per handing. */
	const handed = (sent: Sent[]) =>
		sent.flatMap(
			({ message }) =>
				(message.details as Delivered | undefined)?.messages.map(
					(one) => one.text,
				) ?? [],
		);

	it("is caught up on without listing the days before the peer last read", async () => {
		// Listing every day's folder at each start took 325 ms of a wake on
		// 15 November, for ids it then passed by as read.
		const now = Date.now();
		settled(now - 4 * day, "7M6JKG: read days ago?");
		const dir = join(fixture.paths.mesh, "messages");
		writeFileSync(join(dir, ".read-7M6JKG"), `${now - 2 * day}-X-1-bbbbbbbb`);
		settled(now - 2 * day + 1000, "7M6JKG: since you read?");
		settled(now - day, "7M6JKG: yesterday?");
		// Swept this hour already, as a busy machine is, so what is listed
		// is the catch-up's alone.
		writeFileSync(join(fixture.paths.mesh, SWEPT_STAMP), `${now}`);
		listing.dirs = [];

		const { sent } = await startSession();
		const listed = listing.dirs;
		listing.dirs = undefined;

		await vi.waitFor(() => expect(handed(sent)).toHaveLength(2));
		expect(handed(sent).sort()).toEqual([
			"7M6JKG: since you read?",
			"7M6JKG: yesterday?",
		]);
		expect(listed).toContain(dayFolder(now - day));
		expect(listed, "a day all read before the peer last read").not.toContain(
			dayFolder(now - 4 * day),
		);
	});

	it("is heard once across a restart, whichever folder it rests in", async () => {
		const now = Date.now();
		settled(now - 4 * day, "7M6JKG: read days ago?");
		const dir = join(fixture.paths.mesh, "messages");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".read-7M6JKG"), `${now - 3 * day}-X-1-bbbbbbbb`);
		const first = await startSession({}, { isIdle: () => true });
		fromElsewhere({ to: ["@7M6JKG"], intent: "question", text: "7M6JKG: before?" });
		await vi.waitFor(() => expect(handed(first.sent)).toHaveLength(1));
		await first.fire("session_shutdown");
		// While it was gone: one message settled into its day's folder with
		// the one it was handed, and one still at the top.
		fromElsewhere({ to: ["@7M6JKG"], intent: "question", text: "7M6JKG: settled?" });
		folderTransport(dir).settle(Date.now() + 1000);
		fromElsewhere({ to: ["@7M6JKG"], intent: "question", text: "7M6JKG: at the top?" });

		const again = await startSession({}, { isIdle: () => true });

		await vi.waitFor(() => expect(handed(again.sent)).toHaveLength(2));
		fromElsewhere({ to: ["@7M6JKG"], intent: "question", text: "7M6JKG: after?" });
		await vi.waitFor(() => expect(handed(again.sent)).toHaveLength(3));
		// A real pause: the test is that nothing is handed over twice in it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(handed(again.sent).sort()).toEqual([
			"7M6JKG: after?",
			"7M6JKG: at the top?",
			"7M6JKG: settled?",
		]);
	});

	it("is handed over at the next start when it was waiting to act as the session went", async () => {
		// Marked read as it arrived, it was lost with the process that held it.
		const first = await startSession({}, { isIdle: () => true }, [], slow);
		fromElsewhere({ intent: "question", text: "7M6JKG: your bug?" });
		// Shorter than the slow settling, so it still waits to act as the session goes.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await first.fire("session_shutdown");
		expect(first.sent).toEqual([]);

		const again = await startSession();

		await vi.waitFor(() => expect(again.sent).toHaveLength(1));
		expect(again.sent[0]?.message.content).toContain("your bug");
	});

	it("is handed over once, even when it was handed over while another waited", async () => {
		const first = await startSession({}, { isIdle: () => true }, [], slow);
		fromElsewhere({ intent: "question", text: "7M6JKG: your bug?" });
		// Shorter than the slow settling, so the question still waits.
		await new Promise((resolve) => setTimeout(resolve, 20));
		fromElsewhere({ to: ["@7M6JKG"], text: "done here" });
		await vi.waitFor(() => expect(first.sent).toHaveLength(1));
		await first.fire("session_shutdown");
		const branch = first.sent.map(({ message }) => ({
			type: "custom_message",
			...message,
		}));

		const again = await startSession({}, {}, branch);

		await vi.waitFor(() => expect(again.sent).toHaveLength(1));
		// A real pause: the test is that nothing is handed over twice in it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(again.sent).toHaveLength(1);
		expect(again.sent[0]?.message.content).toContain("your bug");
		expect(again.sent[0]?.message.content).not.toContain("done here");
	});

	it("is read once glanced at, or taken by a run something else started", async () => {
		const first = await startSession(
			{},
			{ ...judging(notYours), isIdle: () => true },
			[],
			slow,
		);
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(first.entries).toHaveLength(1));
		fromElsewhere({ intent: "question", text: "7M6JKG: your bug?" });
		// Shorter than the slow settling, so the question still waits for the run.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await first.fire("before_agent_start");
		await first.fire("session_shutdown");

		const again = await startSession();

		// A real pause: the test is that nothing is handed over again in it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(again.sent).toEqual([]);
		expect(again.entries).toEqual([]);
	});

	it("is heard when it lands as the peer starts watching", async () => {
		// Watching only after the catch-up lost what landed between the two.
		watching.deaf = true;
		watching.armed = () => {
			watching.armed = undefined;
			fromElsewhere({ to: ["@7M6JKG"], text: "just in time" });
		};

		const { sent } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("just in time");
	});

	it("is looked for again when the watcher never reports it", async () => {
		watching.deaf = true;
		const { sent } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			undefined,
			20,
		);

		fromElsewhere({ to: ["@7M6JKG"], text: "dropped by the kernel" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("dropped by the kernel");
	});

	it("is looked for again as a run ends", async () => {
		watching.deaf = true;
		const { sent, fire } = await startSession();
		fromElsewhere({ to: ["@7M6JKG"], text: "dropped by the kernel" });

		await fire("agent_end");

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("dropped by the kernel");
	});
});

describe("an old copy written back", () => {
	/** Write a message stamped long before this peer last read, as a link to another machine writes one back. */
	const writtenBack = (text: string): string => {
		const dir = join(fixture.paths.mesh, "messages");
		const sent = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const id = `${sent}-WCJQSG-7-cccccccc`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				at: new Date(sent).toISOString(),
				from: "WCJQSG",
				to: ["@7M6JKG"],
				intent: "question",
				text,
				pid: 7,
			}),
		);
		return id;
	};

	it("is passed by unread, as it lands or when looked for again", async () => {
		// A week written back at once, about 48,000 files on 14 November,
		// would have every session read and parse each in one burst.
		const { sent, fire } = await startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		reading.files = [];

		const old = writtenBack("7M6JKG: still on your bug from last week?");
		// A real pause of several looks again, any of which could read the old copy.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await fire("agent_end");
		const news = fromElsewhere({ to: ["@7M6JKG"], text: "news from now" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const read = reading.files;
		reading.files = undefined;
		expect(
			read.filter((file) => file.endsWith(`${news.id}.json`)),
			"the message from now, read as it was handed over",
		).not.toEqual([]);
		expect(
			read.filter((file) => file.endsWith(`${old}.json`)),
			"a copy from a day before the catch-up began",
		).toEqual([]);
	});

	it("is never handed over, as it lands or when looked for again", async () => {
		// Seen live on 14 November: a move to another machine wrote a week
		// of expired messages back at the top, and every session took each
		// as new, its questions with a turn.
		watching.deaf = true;
		const { sent, entries, fire } = await startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);

		writtenBack("7M6JKG: still on your bug from last week?");
		// A real pause of several looks again, any of which could take the old copy.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await fire("agent_end");
		fromElsewhere({ to: ["@7M6JKG"], text: "news from now" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("news from now");
		expect(sent[0]?.message.content).not.toContain("last week");
		expect(entries, "no glance at the old copy either").toEqual([]);
	});

	it("is never handed over as it lands while the peer watches", async () => {
		const { sent, entries } = await startSession({}, { isIdle: () => true });

		writtenBack("7M6JKG: still on your bug from last week?");
		fromElsewhere({ to: ["@7M6JKG"], text: "news from now" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		// A real pause: the test is that the old copy isn't handed over in it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).not.toContain("last week");
		expect(entries, "no glance at the old copy either").toEqual([]);
	});
});

describe("a message caught half written", () => {
	it("is taken once it reads, not lost", async () => {
		const { sent } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		const dir = join(fixture.paths.mesh, "messages");
		const id = `${Date.now()}-TESTER-1-c0ffee00`;
		writeFileSync(join(dir, `${id}.json`), "");
		// A real pause of several looks again while the message is still empty.
		await new Promise((done) => setTimeout(done, 60));
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				at: new Date().toISOString(),
				from: "TESTER",
				to: ["@7M6JKG"],
				intent: "fyi",
				text: "written at last",
				pid: process.pid + 1,
			}),
		);

		await vi.waitFor(() =>
			expect(sent.map((one) => one.message.content).join()).toContain(
				"written at last",
			),
		);
	});
});

describe("retention", () => {
	it("lets go of what is past its time as a session starts", async () => {
		const dir = join(fixture.paths.mesh, "messages");
		mkdirSync(dir, { recursive: true });
		const old = `${Date.now() - 8 * 24 * 60 * 60 * 1000}-WCJQSG-1-aaaa`;
		writeFileSync(join(dir, `${old}.json`), "{}");

		await startSession();
		// A real pause, for the start to let go of what is past its time.
		await new Promise((done) => setTimeout(done, 20));

		const stale = join(dir, `${old}.json`);
		expect(existsSync(stale), `${stale} is removed`).toBe(false);
	});
});
