/**
 * A message is never lost and never handed over twice: through a
 * session switched out, a watcher that never reports it, an old copy
 * written back, a message caught half written, and what retention
 * lets go of.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	fixture,
	fromElsewhere,
	judging,
	notYours,
	session,
	startSession,
} from "./support/mesh.ts";

// The folder's watcher, as a test can have it: deaf, as one is when the
// kernel drops its events, and with a message landing as it is armed.
const watching = vi.hoisted(() => ({
	deaf: false,
	armed: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		watch: ((...args: Parameters<typeof fs.watch>) => {
			watching.armed?.();
			return watching.deaf ? { close() {} } : fs.watch(...args);
		}) as typeof fs.watch,
	};
});

beforeEach(() => {
	watching.deaf = false;
	watching.armed = undefined;
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
	const writtenBack = (text: string) => {
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
	};

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
