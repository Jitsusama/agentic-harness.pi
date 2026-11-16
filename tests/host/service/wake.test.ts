/** The service wakes a parked conversation as it resumes one: in turn with a close of it, through the rollout gate, and side by side with a few others, a window's first. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type ConversationEngine,
	hostBackend,
} from "../../../host/service/backend.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import type { AdmitAnother } from "../../../host/service/rollout.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
import { until } from "../../support/until.ts";

const KEY = "work-attended";
const owner = { pid: process.pid, startedAt: 1 };

let dir: string;
let host: SessionHost;
let roster: HostRoster;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wake-"));
	host = new SessionHost({ key: KEY, owner, registryDir: dir });
	roster = await openRoster({
		key: KEY,
		dir: join(dir, "rosters"),
		owner: { ...owner, startTicks: 1 },
	});
});
afterEach(async () => {
	for (const { id } of host.list()) await host.stop(id);
	host.dispose();
	await roster.close();
	await rm(dir, { recursive: true, force: true });
});

function register(conversation: {
	sessionId: string;
	file: string;
	cwd: string;
}) {
	host.register({
		id: conversation.sessionId,
		file: conversation.file,
		cwd: conversation.cwd,
		env: {},
		close: () => {},
	});
}

/** An engine registering with the real SessionHost, as the engine does. */
function engine(overrides: Partial<ConversationEngine> = {}) {
	const fake: ConversationEngine = {
		prepare: vi.fn(async () => ({
			sessionId: randomUUID(),
			file: join(dir, `${randomUUID()}.jsonl`),
			cwd: "/work",
		})),
		start: vi.fn(async (prepared) => register(prepared)),
		discard: vi.fn(async () => {}),
		resume: vi.fn(async (entry) => register(entry)),
		abort: vi.fn(async () => {}),
		backgroundOf: () => 0,
		dropped: vi.fn(async () => {}),
		handsOn: vi.fn(),
		...overrides,
	};
	return fake;
}

function backendWith(
	fake: ConversationEngine,
	admitAnother?: AdmitAnother,
	say?: (line: string) => void,
	wakes: { wakePlaces?: number; wakeLongestMs?: number } = {},
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		...(admitAnother ? { admitAnother } : {}),
		...(say ? { say } : {}),
		...wakes,
	});
}

/**
 * An engine whose resumes each wait to be let through: `begun` lists the
 * conversations whose resume has started, in order, and `finish` lets one
 * end.
 */
function heldResumes() {
	const begun: string[] = [];
	const finishes = new Map<string, () => void>();
	const fake = engine({
		resume: vi.fn(async (entry) => {
			begun.push(entry.sessionId);
			await new Promise<void>((resolve) => {
				finishes.set(entry.sessionId, resolve);
			});
			register(entry);
		}),
	});
	const finish = (sessionId: string): void => {
		const done = finishes.get(sessionId);
		if (!done) throw new Error(`${sessionId}'s resume hasn't begun`);
		done();
	};
	return { fake, begun, finish };
}

const attach = (sessionId: string) =>
	({
		v: 1,
		id: `a-${sessionId}`,
		op: "attach",
		sessionId,
		rows: 40,
		columns: 120,
	}) as const;

/** Long enough for a resume that could begin to have begun. */
const SETTLE_MS = 20;

/** Let a resume that may begin do so, before checking that it didn't. */
function settle(): Promise<void> {
	// A real pause is the point: a resume held back must not begin in it.
	return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

const open = {
	v: 1,
	id: "o",
	op: "open",
	cwd: "/work",
	attended: true,
} as const;

/** Open a conversation, then park it as the engine does: a host stop, keeping its hold. */
async function parked(backend: ReturnType<typeof backendWith>) {
	const { sessionId } = parseOpenResult(await backend.execute(open));
	await host.stop(sessionId, "parked while idle");
	return sessionId;
}

describe("waking a parked conversation", () => {
	it("resumes it once, leaving one already awake alone", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		await Promise.all([backend.wake(sessionId), backend.wake(sessionId)]);

		expect(
			fake.resume,
			"two wakes at once resume it once, as a wake",
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ sessionId }),
			true,
		);
		expect(host.holds(sessionId), "it runs again").toBe("idle");
	});

	it("leaves one released while it slept gone, telling its screen why, even with the wake asked first", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		const closing = backend.execute({
			v: 1,
			id: "c",
			op: "release",
			sessionId,
			by: "the cutover",
		});
		const waking = backend.wake(sessionId);
		await Promise.all([closing, waking]);

		expect(
			fake.resume,
			"the wake asked in the close's turn finds it gone",
		).not.toHaveBeenCalled();
		expect(
			fake.dropped,
			"its kept screen was let go, told it was released",
		).toHaveBeenCalledWith(
			sessionId,
			"released, asked by the cutover over the control socket",
		);
		expect(
			fake.handsOn,
			"a release hands it on, so what its calls left is kept",
		).toHaveBeenCalledExactlyOnceWith(sessionId);
		expect(host.holds(sessionId), "it stays closed").toBeUndefined();
	});

	it("hands nothing on when one is closed for good, parked or running", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sleeping = await parked(backend);
		const { sessionId: running } = parseOpenResult(await backend.execute(open));

		for (const [id, sessionId] of [
			["c1", sleeping],
			["c2", running],
		] as const)
			await backend.execute({ v: 1, id, op: "close", sessionId, by: "Joel" });

		expect(
			fake.handsOn,
			"a close ends what its calls left",
		).not.toHaveBeenCalled();
		expect(host.holds(running), "it closed").toBeUndefined();
	});

	it("closes one released while it parks as a parked one, saying the end before telling its screen", async () => {
		const said: string[] = [];
		let parking: Promise<void> | undefined;
		const fake = engine({
			parkSettled: () => parking ?? Promise.resolve(),
			dropped: vi.fn(async () => {
				said.push("dropped");
			}),
		});
		const backend = backendWith(fake, undefined, (line) => said.push(line));
		const { sessionId } = parseOpenResult(await backend.execute(open));

		parking = host.stop(sessionId, "parked while idle");
		await backend.execute({
			v: 1,
			id: "r",
			op: "release",
			sessionId,
			by: "the cutover",
		});

		expect(
			fake.dropped,
			"its kept screen was let go, told it was released",
		).toHaveBeenCalledWith(
			sessionId,
			"released, asked by the cutover over the control socket",
		);
		expect(said, "the end was said, then its screen told").toEqual([
			expect.stringContaining(
				"ended: released, asked by the cutover over the control socket, held but not running",
			),
			"dropped",
		]);
		expect(
			roster.entries().map((held) => held.sessionId),
			"the roster let it go",
		).not.toContain(sessionId);
	});

	it("says a wake of one held but not running can't, since its start or its park failed, and that a close lets it go", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const { sessionId } = parseOpenResult(await backend.execute(open));
		host.state(sessionId, "parked");

		await expect(
			backend.wake(sessionId),
			"the wake says why it can't",
		).rejects.toThrow(
			/is held but not running, since its last start or park failed; close it and open it again/,
		);
		expect(fake.resume, "nothing resumed").not.toHaveBeenCalled();
	});

	it("waits out every wake under way before saying it settled", async () => {
		let resumed: (() => void) | undefined;
		const waking = new Promise<void>((resolve) => {
			resumed = resolve;
		});
		const fake = engine({
			resume: vi.fn(async (entry) => {
				await waking;
				register(entry);
			}),
		});
		const backend = backendWith(fake);
		const sessionId = await parked(backend);
		let settled = false;

		const woke = backend.wake(sessionId);
		const settling = backend.settled().then(() => {
			settled = true;
		});
		await until(
			"the wake to resume it",
			() => vi.mocked(fake.resume).mock.calls.length > 0,
		);
		expect(settled, "unsettled while the wake resumes").toBe(false);
		resumed?.();
		await woke;
		await settling;

		expect(host.holds(sessionId), "settled once it runs").toBe("idle");
	});

	it("goes through the rollout gate beside another conversation, and stays parked when refused", async () => {
		const fake = engine();
		const refused = new Error("pid 41 runs a harness before the census change");
		const gate = vi.fn(() => Promise.reject(refused));
		const backend = backendWith(fake, gate);
		const sessionId = await parked(backend);
		// The first open passes without asking; a second would ask.
		gate.mockClear();
		await backendWith(engine()).execute(open);

		await expect(backend.wake(sessionId)).rejects.toBe(refused);

		expect(
			gate,
			"the wake asked the gate, as a wake",
		).toHaveBeenCalledExactlyOnceWith("wake");
		expect(
			fake.resume,
			"a refused wake resumes nothing",
		).not.toHaveBeenCalled();
		expect(
			roster.entries().map((held) => held.sessionId),
			"it stays held, parked",
		).toContain(sessionId);
	});

	it("wakes it as a window attaches, then answers its identity", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		await expect(
			backend.execute({
				v: 1,
				id: "t",
				op: "attach",
				sessionId,
				rows: 40,
				columns: 120,
			}),
		).resolves.toEqual({ sessionId });

		expect(fake.resume, "the attach woke it").toHaveBeenCalledOnce();
		expect(host.holds(sessionId), "it runs for the window").toBe("idle");
	});
});

describe("waking conversations side by side, a window's first", () => {
	it("resumes wakes side by side up to its places, the next once one ends", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, { wakePlaces: 2 });
		const [first, second, third] = [
			await parked(backend),
			await parked(backend),
			await parked(backend),
		];

		const woken = [first, second, third].map((id) => backend.wake(id));
		await until("two wakes to resume", () => begun.length === 2);
		await settle();

		expect(begun, "two resume at once, the third waits").toEqual([
			first,
			second,
		]);
		finish(second);
		await until("the third wake to resume", () => begun.length === 3);
		finish(first);
		finish(third);
		await Promise.all(woken);

		expect(host.holds(third), "the third runs too").toBe("idle");
	});

	it("resumes a window's attach at once, every place taken", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, { wakePlaces: 1 });
		const waking = await parked(backend);
		const messaged = await parked(backend);
		const watched = await parked(backend);

		const woken = backend.wake(waking);
		await until("the first wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		const attached = backend.execute(attach(watched));
		await until("the window's wake to resume", () => begun.length === 2);

		expect(begun, "the window's went past the one waiting").toEqual([
			waking,
			watched,
		]);
		finish(watched);
		await attached;
		finish(waking);
		await until("the message's wake to resume", () => begun.length === 3);
		finish(messaged);
		await Promise.all([woken, queued]);

		expect(host.holds(messaged), "the message's wake still ran").toBe("idle");
	});

	it("begins no other wake while a window's resumes", async () => {
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, { wakePlaces: 4 });
		const watched = await parked(backend);
		const messaged = await parked(backend);

		const attached = backend.execute(attach(watched));
		await until("the window's wake to resume", () => begun.length === 1);
		const queued = backend.wake(messaged);
		await settle();

		expect(begun, "the message's wake waits for the window's").toEqual([
			watched,
		]);
		finish(watched);
		await until("the message's wake to resume", () => begun.length === 2);
		finish(messaged);
		await Promise.all([attached, queued]);

		expect(host.holds(messaged), "it runs once the window's has").toBe("idle");
	});

	it("resumes a wake that has waited its longest though no place is free", async () => {
		const longestMs = 60;
		const { fake, begun, finish } = heldResumes();
		const backend = backendWith(fake, undefined, undefined, {
			wakePlaces: 1,
			wakeLongestMs: longestMs,
		});
		const stuck = await parked(backend);
		const next = await parked(backend);

		const woken = backend.wake(stuck);
		await until("the first wake to resume", () => begun.length === 1);
		const askedAt = Date.now();
		const waited = backend.wake(next);
		await until("the second wake to resume", () => begun.length === 2);

		expect(
			Date.now() - askedAt,
			"it waited for a place first",
		).toBeGreaterThanOrEqual(longestMs - 5);
		finish(next);
		await waited;
		expect(host.holds(next), "it runs, the first still resuming").toBe("idle");
		finish(stuck);
		await woken;
	});

	it("wakes a burst of twenty in a few resumes' time, not twenty", async () => {
		// Each resume waits this long on its disk, as a real one waits on its
		// session file and extensions, and holds no place on the thread.
		const waitsMs = 50;
		const burst = 20;
		const fake = engine({
			resume: vi.fn(async (entry) => {
				await new Promise((resolve) => setTimeout(resolve, waitsMs));
				register(entry);
			}),
		});
		const backend = backendWith(fake);
		const ids: string[] = [];
		for (let made = 0; made < burst; made += 1) ids.push(await parked(backend));

		const began = Date.now();
		await Promise.all(ids.map((id) => backend.wake(id)));
		const tookMs = Date.now() - began;

		// One at a time would take the burst times each wait; half of that
		// leaves a slow machine room and still fails a burst taken in turn.
		expect(
			tookMs,
			`twenty wakes took ${tookMs} ms, against ${burst * waitsMs} ms one at a time`,
		).toBeLessThan((burst * waitsMs) / 2);
		for (const id of ids)
			expect(host.holds(id), `${id} runs again`).toBe("idle");
	});
});
