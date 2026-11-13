/** The service holds before the engine registers and drops only after an end commits. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type ConversationEngine,
	conversationEvents,
	hostBackend,
	type Prepared,
	resumeHeld,
} from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	type ControlRequest,
	parseListResult,
	parseOpenResult,
	parseSessionResult,
} from "../../../host/service/protocol.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
import { listenControl } from "../../../host/service/server.ts";
import { ambientSession, sessionEnv } from "../../../lib/core/session/index.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";

const KEY = "work-attended";
const owner = { pid: process.pid, startedAt: 1 };

let dir: string;
let rosters: string;
let host: SessionHost;
let roster: HostRoster;
let cleanup: ReturnType<typeof vi.fn<(why: string) => void>>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-backend-"));
	rosters = join(dir, "rosters");
	host = new SessionHost({ key: KEY, owner, registryDir: dir });
	roster = await openRoster({
		key: KEY,
		dir: rosters,
		owner: { ...owner, startTicks: 1 },
	});
	cleanup = vi.fn();
});
afterEach(async () => {
	for (const { id } of host.list()) await host.stop(id);
	host.dispose();
	await roster.close();
	await rm(dir, { recursive: true, force: true });
});

/** A fake engine that registers with the real SessionHost, as H1's will. */
function engine(overrides: Partial<ConversationEngine> = {}) {
	const seen: string[] = [];
	const fake: ConversationEngine = {
		prepare: vi.fn(async (request) => ({
			sessionId: randomUUID(),
			file:
				request.op === "adopt"
					? request.sessionFile
					: join(dir, `${randomUUID()}.jsonl`),
			cwd: request.op === "open" ? request.cwd : dir,
		})),
		start: vi.fn(async (prepared: Prepared) => {
			seen.push(
				`held:${await heldSessionStatus(prepared.sessionId, { dir: rosters })}`,
			);
			register(prepared);
		}),
		discard: vi.fn(async () => {}),
		resume: vi.fn(async (entry) => register(entry)),
		abort: vi.fn(async () => {}),
		backgroundOf: () => 0,
		...overrides,
	};
	return { fake, seen };
}

function register(conversation: {
	sessionId: string;
	file: string;
	cwd: string;
}) {
	host.register({
		id: conversation.sessionId,
		file: conversation.file,
		cwd: conversation.cwd,
		env: { PI_SESSION_ID: conversation.sessionId },
		close: cleanup,
	});
}

function backendWith(
	fake: ConversationEngine,
	admitAnother?: () => Promise<void>,
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		...(admitAnother ? { admitAnother } : {}),
		now: () => new Date("2026-11-09T16:00:00.000Z"),
	});
}

/** A gate that refuses as the rollout gate does, counting each ask. */
function refusing() {
	const stale = new Error("pid 41 runs a harness before the census change");
	return { stale, gate: vi.fn(() => Promise.reject(stale)) };
}

const open = {
	v: 1,
	id: "o",
	op: "open",
	cwd: "/work",
	attended: true,
} as const;

async function ask(path: string, request: ControlRequest): Promise<unknown> {
	const reply = await controlRequest(path, request);
	if (!reply.ok) throw new Error(reply.error.message);
	return reply.result;
}

describe("hostBackend", () => {
	it("lists an idle conversation busy while it holds background work, and only that one", async () => {
		const working = new Set<string>();
		const { fake } = engine({
			backgroundOf: (sessionId) => (working.has(sessionId) ? 1 : 0),
		});
		const backend = backendWith(fake);
		const lingering = parseOpenResult(await backend.execute(open));
		const quiet = parseOpenResult(await backend.execute({ ...open, id: "o2" }));
		working.add(lingering.sessionId);
		const states = async () =>
			Object.fromEntries(
				parseListResult(
					await backend.execute({ v: 1, id: "l", op: "list" }),
				).sessions.map((one) => [one.sessionId, one.state]),
			);

		expect(await states(), "listed while one holds background work").toEqual({
			[lingering.sessionId]: "busy",
			[quiet.sessionId]: "idle",
		});
		working.clear();
		expect(await states(), "listed once its work is done").toEqual({
			[lingering.sessionId]: "idle",
			[quiet.sessionId]: "idle",
		});
	});

	it("holds durably before start registers, and answers the live identity", async () => {
		const { fake, seen } = engine();
		const opened = parseOpenResult(await backendWith(fake).execute(open));
		expect(seen).toEqual(["held:held"]);
		expect(opened).toMatchObject({ cwd: "/work", state: "idle" });
		expect(roster.entries()).toEqual([
			expect.objectContaining({
				sessionId: opened.sessionId,
				attended: true,
				since: "2026-11-09T16:00:00.000Z",
			}),
		]);
	});

	it("undoes a start that never registered, but keeps one that registered and failed", async () => {
		const never = engine({
			start: vi.fn(async () => {
				throw new Error("extension load failed");
			}),
		});
		await expect(backendWith(never.fake).execute(open)).rejects.toThrow(
			"extension load failed",
		);
		expect(never.fake.discard).toHaveBeenCalledOnce();
		expect(roster.entries()).toEqual([]);

		const after = engine({
			start: vi.fn(async (prepared: Prepared) => {
				register(prepared);
				host.state(prepared.sessionId, "parked");
				throw new Error("first submit failed");
			}),
		});
		await expect(backendWith(after.fake).execute(open)).rejects.toThrow(
			"first submit failed",
		);
		expect(after.fake.discard).not.toHaveBeenCalled();
		expect(roster.entries()).toHaveLength(1);
	});

	it("holds the launch environment prepare derived, and a restart's resume gets it back exactly", async () => {
		const launch = { SHOPIFY_EXP_ARM: "treatment", SHOPIFY_EXP_ID: "e1" };
		const derived = engine({
			prepare: vi.fn(async () => ({
				sessionId: randomUUID(),
				file: join(dir, `${randomUUID()}.jsonl`),
				cwd: "/work",
				launch,
			})),
		});
		const { sessionId } = parseOpenResult(
			await backendWith(derived.fake).execute(open),
		);
		const plain = parseOpenResult(
			await backendWith(engine().fake).execute(open),
		).sessionId;
		for (const { id } of host.list()) await host.stop(id);
		await roster.close();

		roster = await openRoster({
			key: KEY,
			dir: rosters,
			owner: { ...owner, startTicks: 2 },
		});
		const restart = engine();
		await resumeHeld({ roster, engine: restart.fake });
		const resumed = vi
			.mocked(restart.fake.resume)
			.mock.calls.map(([entry]) => [entry.sessionId, entry.launch]);
		expect(resumed).toEqual([
			[sessionId, launch],
			[plain, undefined],
		]);
	});

	it("refuses a launch environment naming a credential, holding and keeping nothing", async () => {
		const leaky = engine({
			prepare: vi.fn(async () => ({
				sessionId: randomUUID(),
				file: join(dir, `${randomUUID()}.jsonl`),
				cwd: "/work",
				launch: { SHOPIFY_EXP_ARM: "a", PI_PROXY_API_KEY: "sk-live" },
			})),
		});
		await expect(backendWith(leaky.fake).execute(open)).rejects.toThrow(
			"never holds a credential, which the host gives per request: PI_PROXY_API_KEY",
		);
		expect(leaky.fake.discard).toHaveBeenCalledOnce();
		expect(leaky.fake.start).not.toHaveBeenCalled();
		expect(roster.entries()).toEqual([]);
	});

	it("refuses a second adopt of one file without starting it", async () => {
		const { fake } = engine();
		const adopt = {
			v: 1,
			id: "a",
			op: "adopt",
			sessionFile: "/sessions/original.jsonl",
			attended: false,
		} as const;
		const backend = backendWith(fake);
		await backend.execute(adopt);
		await expect(backend.execute(adopt)).rejects.toThrow("already held");
		expect(fake.start).toHaveBeenCalledOnce();
		expect(fake.discard).toHaveBeenCalledOnce();
	});

	it("drops a hold only after close or release commits, never after stop", async () => {
		const { fake } = engine();
		const backend = backendWith(fake);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++)
			ids.push(parseOpenResult(await backend.execute(open)).sessionId);
		const [closed, released, stopped] = ids as [string, string, string];
		await backend.execute({ v: 1, id: "c", op: "close", sessionId: closed });
		await backend.execute({
			v: 1,
			id: "r",
			op: "release",
			sessionId: released,
		});
		await host.stop(stopped);
		expect(cleanup.mock.calls).toEqual([
			["closed, asked by a control request that didn't say who sent it"],
			["released, asked by a control request that didn't say who sent it"],
			["host stopped"],
		]);
		expect(roster.entries().map((held) => held.sessionId)).toEqual([stopped]);
	});

	it("closes with the caller a request names, and journals a close of one held but not running", async () => {
		const { fake } = engine();
		const said: string[] = [];
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: fake,
			say: (line) => said.push(line),
		});
		const running = parseOpenResult(await backend.execute(open)).sessionId;
		const stranded = parseOpenResult(await backend.execute(open)).sessionId;
		await host.stop(stranded);

		await backend.execute({
			v: 1,
			id: "c",
			op: "close",
			sessionId: running,
			by: "the launcher\n",
		});
		await backend.execute({
			v: 1,
			id: "s",
			op: "close",
			sessionId: stranded,
			by: "mycelium close",
		});

		expect(
			cleanup,
			"a running one closes naming its caller, kept to one line",
		).toHaveBeenCalledWith(
			"closed, asked by the launcher  over the control socket",
		);
		const address = stranded.replace(/-/g, "").slice(-8).toUpperCase();
		expect(
			said,
			"one not running has no end to say it, so it's said here",
		).toEqual([
			`${address} (${stranded}) ended: closed, asked by mycelium close over the control socket, held but not running`,
		]);
	});

	it("keeps a hold whose close failed, so the next start still owes it", async () => {
		const { fake } = engine();
		const backend = backendWith(fake);
		const { sessionId } = parseOpenResult(await backend.execute(open));
		cleanup.mockImplementationOnce(() => {
			throw new Error("shutdown hook failed");
		});
		await expect(
			backend.execute({ v: 1, id: "c", op: "close", sessionId }),
		).rejects.toThrow("shutdown hook failed");
		expect(await heldSessionStatus(sessionId, { dir: rosters })).toBe("held");
	});

	it("keeps a hold whose start step can't be said, and resumes the rest", async () => {
		const { fake } = engine();
		const first = backendWith(fake);
		const a = parseOpenResult(await first.execute(open)).sessionId;
		const b = parseOpenResult(await first.execute(open)).sessionId;
		for (const id of [a, b]) await host.stop(id);

		const unheard = new Error("nobody to tell");
		const restart = engine({ resume: vi.fn(async (entry) => register(entry)) });
		expect(
			await resumeHeld({
				roster,
				engine: restart.fake,
				starting: async ({ sessionId }) => {
					if (sessionId === a) throw unheard;
				},
			}),
		).toEqual({
			resumed: [b],
			unresumed: [{ sessionId: a, reason: unheard }],
		});
		expect(await heldSessionStatus(a, { dir: rosters })).toBe("held");
	});

	it("resumes every hold at start and lists one that would not resume as parked", async () => {
		const { fake } = engine();
		const first = backendWith(fake);
		const a = parseOpenResult(await first.execute(open)).sessionId;
		const b = parseOpenResult(await first.execute(open)).sessionId;
		for (const id of [a, b]) await host.stop(id);

		const missing = new Error("session file is gone");
		const restart = engine({
			resume: vi.fn(async (entry) => {
				if (entry.sessionId === b) throw missing;
				register(entry);
			}),
		});
		expect(await resumeHeld({ roster, engine: restart.fake })).toEqual({
			resumed: [a],
			unresumed: [{ sessionId: b, reason: missing }],
		});
		const listed = parseListResult(
			await backendWith(restart.fake).execute({ v: 1, id: "l", op: "list" }),
		);
		expect(
			listed.sessions.map(({ sessionId, state }) => [sessionId, state]),
		).toEqual([
			[a, "idle"],
			[b, "parked"],
		]);
		await expect(
			backendWith(restart.fake).execute({
				v: 1,
				id: "x",
				op: "abort",
				sessionId: b,
			}),
		).rejects.toThrow("not hosted");
		await backendWith(restart.fake).execute({
			v: 1,
			id: "c",
			op: "close",
			sessionId: b,
		});
		expect(await heldSessionStatus(b, { dir: rosters })).toBe("unheld");
	});

	describe("with the rollout gate", () => {
		it("opens the first conversation without asking, and refuses a second before preparing or holding it", async () => {
			const { fake } = engine();
			const { stale, gate } = refusing();
			const backend = backendWith(fake, gate);
			const first = parseOpenResult(await backend.execute(open)).sessionId;
			expect(gate).not.toHaveBeenCalled();

			await expect(backend.execute(open)).rejects.toBe(stale);
			await expect(
				backend.execute({
					v: 1,
					id: "a",
					op: "adopt",
					sessionFile: join(dir, "other.jsonl"),
					attended: true,
				}),
			).rejects.toBe(stale);
			expect(gate).toHaveBeenCalledTimes(2);
			expect(fake.prepare).toHaveBeenCalledTimes(1);
			expect(roster.entries().map(({ sessionId }) => sessionId)).toEqual([
				first,
			]);
		});

		it("opens a second once the gate passes", async () => {
			const gate = vi.fn(() => Promise.resolve());
			const backend = backendWith(engine().fake, gate);
			await backend.execute(open);
			await backend.execute(open);
			expect(gate).toHaveBeenCalledTimes(1);
			expect(roster.entries()).toHaveLength(2);
		});

		it("counts an open still starting, so two at once on an empty host can't both go first", async () => {
			const { stale, gate } = refusing();
			const backend = backendWith(engine().fake, gate);
			const results = await Promise.allSettled([
				backend.execute(open),
				backend.execute(open),
			]);
			expect(results.map(({ status }) => status)).toEqual([
				"fulfilled",
				"rejected",
			]);
			expect(results[1]).toMatchObject({ reason: stale });
			expect(roster.entries()).toHaveLength(1);
		});

		it("counts a stranded hold as a conversation the host already has", async () => {
			const { fake } = engine();
			const a = parseOpenResult(
				await backendWith(fake).execute(open),
			).sessionId;
			await host.stop(a);
			const { stale, gate } = refusing();
			await expect(backendWith(fake, gate).execute(open)).rejects.toBe(stale);
		});

		it("leaves a hold that rests parked unbuilt, asking the gate only for each built after the first", async () => {
			const { fake } = engine();
			const opening = backendWith(fake);
			const held: string[] = [];
			for (let n = 0; n < 3; n++)
				held.push(parseOpenResult(await opening.execute(open)).sessionId);
			for (const id of held) await host.stop(id);
			const [resting, a, b] = held;

			const restart = engine({
				restsParked: vi.fn((entry) => entry.sessionId === resting),
			});
			const gate = vi.fn(() => Promise.resolve());
			expect(
				await resumeHeld({ roster, engine: restart.fake, admitAnother: gate }),
			).toEqual({ resumed: [a, b], unresumed: [] });
			expect(
				vi.mocked(restart.fake.resume).mock.calls.map(([e]) => e.sessionId),
				"only those that don't rest are built",
			).toEqual([a, b]);
			expect(gate, "asked for b alone, a going first").toHaveBeenCalledTimes(1);
			const listed = parseListResult(
				await backendWith(restart.fake).execute({ v: 1, id: "l", op: "list" }),
			);
			expect(
				listed.sessions.map(({ sessionId, state }) => [sessionId, state]),
				"still held, listed parked",
			).toEqual([
				[a, "idle"],
				[b, "idle"],
				[resting, "parked"],
			]);
		});

		it("resumes the first hold that resumes and parks each after it with the gate's reason, in the order they were held", async () => {
			const { fake } = engine();
			const opening = backendWith(fake);
			const held: string[] = [];
			for (let n = 0; n < 3; n++)
				held.push(parseOpenResult(await opening.execute(open)).sessionId);
			for (const id of held) await host.stop(id);
			const [a, b, c] = held;

			const gone = new Error("session file is gone");
			const restart = engine({
				resume: vi.fn(async (entry) => {
					if (entry.sessionId === a) throw gone;
					register(entry);
				}),
			});
			const { stale, gate } = refusing();
			expect(
				await resumeHeld({ roster, engine: restart.fake, admitAnother: gate }),
			).toEqual({
				resumed: [b],
				unresumed: [
					{ sessionId: a, reason: gone },
					{ sessionId: c, reason: stale },
				],
			});
			expect(restart.fake.resume).toHaveBeenCalledTimes(2);
			const listed = parseListResult(
				await backendWith(restart.fake).execute({ v: 1, id: "l", op: "list" }),
			);
			expect(
				listed.sessions.map(({ sessionId, state }) => [sessionId, state]),
			).toEqual([
				[b, "idle"],
				[a, "parked"],
				[c, "parked"],
			]);
		});
	});

	it("answers an attach on a conversation still starting once its start has settled", async () => {
		const sessionId = randomUUID();
		let screenUp = (): void => undefined;
		const order: string[] = [];
		const { fake } = engine({
			prepare: vi.fn(async (request) => ({
				sessionId,
				file: request.op === "adopt" ? request.sessionFile : dir,
				cwd: dir,
			})),
			// Registered, so listed, seconds before its screen exists, as the
			// engine's build does.
			start: vi.fn(async (prepared: Prepared) => {
				register(prepared);
				await new Promise<void>((done) => {
					screenUp = done;
				});
				order.push("screen");
			}),
		});
		const backend = backendWith(fake);
		const adopting = backend.execute({
			v: 1,
			id: "a",
			op: "adopt",
			sessionFile: join(dir, "moved.jsonl"),
			attended: false,
		});
		await vi.waitFor(() => expect(host.holds(sessionId)).toBeDefined());
		const attaching = backend
			.execute({
				v: 1,
				id: "t",
				op: "attach",
				sessionId,
				rows: 1,
				columns: 1,
			})
			.then((answer) => {
				order.push("attach");
				return answer;
			});
		// Long enough for an attach that doesn't wait to have answered.
		await new Promise((done) => setTimeout(done, 50));
		expect(order).toEqual([]);
		screenUp();
		await adopting;
		expect(parseSessionResult(await attaching)).toEqual({ sessionId });
		expect(order).toEqual(["screen", "attach"]);
	});

	it("refuses an attach on a conversation whose start failed before it registered", async () => {
		const sessionId = randomUUID();
		let fail = (): void => undefined;
		const { fake } = engine({
			prepare: vi.fn(async () => ({ sessionId, file: dir, cwd: dir })),
			start: vi.fn(
				() =>
					new Promise<void>((_, refuse) => {
						fail = () => refuse(new Error("extension load failed"));
					}),
			),
		});
		const backend = backendWith(fake);
		const opening = backend.execute(open);
		await vi.waitFor(() => expect(roster.entries()).toHaveLength(1));
		const attaching = backend.execute({
			v: 1,
			id: "t",
			op: "attach",
			sessionId,
			rows: 1,
			columns: 1,
		});
		fail();
		await expect(opening).rejects.toThrow("extension load failed");
		await expect(attaching).rejects.toThrow("not hosted");
	});

	it("refuses to end, abort or attach a conversation it never held", async () => {
		const backend = backendWith(engine().fake);
		const sessionId = randomUUID();
		for (const op of ["close", "release", "abort"] as const)
			await expect(
				backend.execute({ v: 1, id: op, op, sessionId }),
			).rejects.toThrow("not hosted");
		await expect(
			backend.execute({
				v: 1,
				id: "t",
				op: "attach",
				sessionId,
				rows: 1,
				columns: 1,
			}),
		).rejects.toThrow("not hosted");
	});

	it("serves two sessions over the real socket, each in its own environment", async () => {
		const seenEnv: [string | undefined, string | undefined][] = [];
		const { fake } = engine({
			abort: vi.fn(async (sessionId: string) => {
				seenEnv.push([ambientSession(), sessionEnv().get("PI_SESSION_ID")]);
				expect(ambientSession()).toBe(sessionId);
			}),
		});
		const backend = backendWith(fake);
		const path = join(dir, "sock", "host.sock");
		const listener = await listenControl({ path, backend, report: () => {} });
		try {
			const ids: string[] = [];
			for (const id of ["o1", "o2"])
				ids.push(parseOpenResult(await ask(path, { ...open, id })).sessionId);
			const expectedHost = { key: host.key, owner: host.owner };
			const aborted = await Promise.all(
				ids.map((sessionId, n) =>
					ask(path, {
						v: 1,
						id: `a${n}`,
						op: "abort",
						sessionId,
						expectedHost,
					}),
				),
			);
			expect(
				aborted.map((result) => parseSessionResult(result).sessionId),
			).toEqual(ids);
			expect(seenEnv).toEqual(
				expect.arrayContaining(ids.map((id) => [id, id])),
			);
			const listed = parseListResult(
				await ask(path, { v: 1, id: "l", op: "list" }),
			);
			expect(listed.host).toEqual(expectedHost);
			expect(listed.sessions).toHaveLength(2);
		} finally {
			await listener.close();
		}
	});
});

describe("conversationEvents", () => {
	const at = () => new Date("2026-11-10T06:00:00.000Z");

	async function opened(launch?: Record<string, string>) {
		const { fake } = engine({
			prepare: vi.fn(async () => ({
				sessionId: randomUUID(),
				file: join(dir, `${randomUUID()}.jsonl`),
				cwd: "/work",
				...(launch ? { launch } : {}),
			})),
		});
		const { sessionId } = parseOpenResult(
			await backendWith(fake).execute({ ...open, quest: "QEST-1" }),
		);
		return sessionId;
	}

	it("drops a conversation that ended inside pi, so the next start doesn't bring it back", async () => {
		const id = await opened();
		const events = conversationEvents({ roster, report: vi.fn(), now: at });
		await events.ended(id, "quit");
		expect(await heldSessionStatus(id, { dir: rosters })).toBe("unheld");
		await events.ended(id, "closed");
		expect(roster.entries(), "a second end is a no-op").toEqual([]);
	});

	it("journals each conversation that ends, by its address and id, saying why", async () => {
		const id = await opened();
		const said: string[] = [];
		const events = conversationEvents({
			roster,
			report: vi.fn(),
			now: at,
			say: (line) => said.push(line),
		});
		await events.ended(id, "quit, asked by viewer 2 in window 7");
		const address = id.replace(/-/g, "").slice(-8).toUpperCase();
		expect(said).toEqual([
			`${address} (${id}) ended: quit, asked by viewer 2 in window 7`,
		]);
	});

	it("reports a drop that fails rather than throwing it back into pi", async () => {
		const id = await opened();
		await roster.close();
		const report = vi.fn();
		await conversationEvents({ roster, report, now: at }).ended(id, "quit");
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Roster is closed" }),
		);
		roster = await openRoster({
			key: KEY,
			dir: rosters,
			owner: { ...owner, startTicks: 1 },
		});
	});

	it("holds what a conversation became in its place, keeping attended, quest and launch", async () => {
		const id = await opened({ SHOPIFY_EXP_ARM: "b" });
		const next = randomUUID();
		const file = join(dir, `${next}.jsonl`);
		await conversationEvents({ roster, report: vi.fn(), now: at }).became(id, {
			sessionId: next,
			file,
			cwd: "/elsewhere",
		});
		expect(roster.entries()).toEqual([
			{
				sessionId: next,
				file,
				cwd: "/elsewhere",
				attended: true,
				quest: "QEST-1",
				since: "2026-11-10T06:00:00.000Z",
				launch: { SHOPIFY_EXP_ARM: "b" },
			},
		]);
	});

	it("takes a launch environment the engine derived anew over the old one", async () => {
		const id = await opened({ SHOPIFY_EXP_ARM: "b" });
		const next = randomUUID();
		await conversationEvents({ roster, report: vi.fn(), now: at }).became(id, {
			sessionId: next,
			file: join(dir, `${next}.jsonl`),
			cwd: "/work",
			launch: { SHOPIFY_EXP_ARM: "c" },
		});
		expect(roster.entries()[0]?.launch).toEqual({ SHOPIFY_EXP_ARM: "c" });
	});

	it("rejects becoming from a conversation not held, or into a file another holds, changing nothing", async () => {
		const id = await opened();
		const other = await opened();
		const events = conversationEvents({ roster, report: vi.fn(), now: at });
		const held = roster.entries();
		await expect(
			events.became(randomUUID(), {
				sessionId: randomUUID(),
				file: join(dir, "x.jsonl"),
				cwd: "/work",
			}),
		).rejects.toThrow("not held");
		const otherFile = held.find((entry) => entry.sessionId === other)?.file;
		if (!otherFile) throw new Error("the other conversation is held");
		await expect(
			events.became(id, {
				sessionId: randomUUID(),
				file: otherFile,
				cwd: "/work",
			}),
		).rejects.toThrow("already held");
		expect(roster.entries()).toEqual(held);
	});
});
