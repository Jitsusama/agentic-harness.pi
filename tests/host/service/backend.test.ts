/**
 * The service holds before the engine registers and drops only after an
 * end commits. Long because every case drives the one backend through the
 * same fake engine, session host and roster, which a split would copy.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type ConversationEngine,
	hostBackend,
	type Prepared,
} from "../../../host/service/backend.ts";
import { controlRequest, drainHost } from "../../../host/service/client.ts";
import { conversationEvents } from "../../../host/service/conversation-events.ts";
import {
	type ControlRequest,
	parseDrainResult,
	parseListResult,
	parseOpenResult,
	parseSessionResult,
} from "../../../host/service/protocol.ts";
import {
	heldOrder,
	RESUME_AT_ONCE,
	resumeHeld,
} from "../../../host/service/resume-held.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
import { listenControl } from "../../../host/service/server.ts";
import { ambientSession, sessionEnv } from "../../../lib/core/session/index.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";
import { until } from "../../support/until.ts";

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

/**
 * What the backend journals, apart from each open's time when it
 * succeeds, which its own case checks, so a case reads only the lines it
 * is about; a start that fails is still said (F50).
 */
function besideStarts(said: string[]): (line: string) => void {
	return (line) => {
		const timed = /: its (open|adopt) took /.test(line);
		if (!timed || line.includes(", failing")) said.push(line);
	};
}

/**
 * An open as a requester sends it, under an id of its own: the backend
 * answers an id asked again with its first answer (repeats.ts).
 */
function anOpen() {
	return {
		v: 1,
		id: randomUUID(),
		op: "open",
		cwd: "/work",
		attended: true,
	} as const;
}

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
		const lingering = parseOpenResult(await backend.execute(anOpen()));
		const quiet = parseOpenResult(
			await backend.execute({ ...anOpen(), id: "o2" }),
		);
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
		const opened = parseOpenResult(await backendWith(fake).execute(anOpen()));
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
		await expect(backendWith(never.fake).execute(anOpen())).rejects.toThrow(
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
		await expect(backendWith(after.fake).execute(anOpen())).rejects.toThrow(
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
			await backendWith(derived.fake).execute(anOpen()),
		);
		const plain = parseOpenResult(
			await backendWith(engine().fake).execute(anOpen()),
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
		await expect(backendWith(leaky.fake).execute(anOpen())).rejects.toThrow(
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
		await expect(backend.execute({ ...adopt, id: "a-again" })).rejects.toThrow(
			"already held",
		);
		// The host's roster refuses it before the engine prepares anything, so nothing is left to discard.
		expect(fake.prepare).toHaveBeenCalledOnce();
		expect(fake.start).toHaveBeenCalledOnce();
		expect(fake.discard).not.toHaveBeenCalled();
	});

	it("drops a hold only after close or release commits, never after stop", async () => {
		const { fake } = engine();
		const backend = backendWith(fake);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++)
			ids.push(parseOpenResult(await backend.execute(anOpen())).sessionId);
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
			say: besideStarts(said),
		});
		const running = parseOpenResult(await backend.execute(anOpen())).sessionId;
		const stranded = parseOpenResult(await backend.execute(anOpen())).sessionId;
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

	// F34: a child whose conversation parked away heard nothing of its
	// close or release, so it ended as parked 30 s later.
	it.each(["close", "release"] as const)(
		"tells what hears its changes of a %s of one held but not running",
		async (op) => {
			const { fake } = engine();
			const left: [string, string][] = [];
			const backend = hostBackend({
				identity: { key: host.key, owner: host.owner },
				host,
				roster,
				engine: fake,
				changes: { left: (ending, why) => left.push([ending, why]) },
			});
			const stranded = parseOpenResult(
				await backend.execute(anOpen()),
			).sessionId;
			await host.stop(stranded);
			left.length = 0;

			await backend.execute({
				v: 1,
				id: "s",
				op,
				sessionId: stranded,
				by: "the launcher",
			});

			const ending = op === "close" ? "closed" : "released";
			expect(left).toEqual([
				[ending, `${ending}, asked by the launcher over the control socket`],
			]);
		},
	);

	it("keeps a hold whose close failed, so the next start still owes it", async () => {
		const { fake } = engine();
		const backend = backendWith(fake);
		const { sessionId } = parseOpenResult(await backend.execute(anOpen()));
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
		const a = parseOpenResult(await first.execute(anOpen())).sessionId;
		const b = parseOpenResult(await first.execute(anOpen())).sessionId;
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
			parked: [],
			dropped: [],
			unresumed: [{ sessionId: a, reason: unheard }],
		});
		expect(await heldSessionStatus(a, { dir: rosters })).toBe("held");
	});

	it("holds the runs a restart cut off from before the first resume until after the last, one failing or not", async () => {
		const { fake } = engine();
		const first = backendWith(fake);
		const a = parseOpenResult(await first.execute(anOpen())).sessionId;
		const b = parseOpenResult(await first.execute(anOpen())).sessionId;
		for (const id of [a, b]) await host.stop(id);

		const order: string[] = [];
		const told: string[][] = [];
		const restart = engine({
			resuming: (held) => {
				told.push([...held]);
				order.push("held");
			},
			resumed: () => order.push("let go"),
			resume: vi.fn(async (entry) => {
				order.push(entry.sessionId);
				if (entry.sessionId === b) throw new Error("pi would not open it");
				register(entry);
			}),
		});
		await resumeHeld({ roster, engine: restart.fake });
		expect(order).toEqual(["held", a, b, "let go"]);
		expect(
			told,
			"told once which it holds, so only their first reaps share a reading",
		).toEqual([[a, b]]);
	});

	describe("a few at a time", () => {
		/** Hold `count` conversations, as a stopped host leaves them. */
		async function holding(count: number): Promise<string[]> {
			const opening = backendWith(engine().fake);
			const held: string[] = [];
			for (let n = 0; n < count; n++)
				held.push(parseOpenResult(await opening.execute(anOpen())).sessionId);
			for (const id of held) await host.stop(id);
			return held;
		}

		/** An engine whose resumes each take a moment, counting how many run at once as each begins. */
		function overlapping(fails?: string) {
			let running = 0;
			const atBegin: number[] = [];
			const restart = engine({
				resume: vi.fn(async (entry) => {
					running += 1;
					atBegin.push(running);
					try {
						// A real pause, so the resumes after the first overlap.
						await new Promise((resolve) => setTimeout(resolve, 5));
						if (entry.sessionId === fails)
							throw new Error("pi would not open it");
						register(entry);
					} finally {
						running -= 1;
					}
				}),
			});
			return { restart, atBegin };
		}

		it("resumes the first alone, then never more than RESUME_AT_ONCE together", async () => {
			const held = await holding(RESUME_AT_ONCE + 3);
			const { restart, atBegin } = overlapping();
			const result = await resumeHeld({ roster, engine: restart.fake });
			expect(
				atBegin.slice(0, RESUME_AT_ONCE + 1),
				"the first alone, then the next RESUME_AT_ONCE together",
			).toEqual([
				1,
				...Array.from({ length: RESUME_AT_ONCE }, (_, n) => n + 1),
			]);
			expect(
				atBegin[RESUME_AT_ONCE + 1],
				"the next begins as one ends, while the others still run",
			).toBe(RESUME_AT_ONCE);
			expect(Math.max(...atBegin)).toBe(RESUME_AT_ONCE);
			expect([...result.resumed].sort()).toEqual([...held].sort());
		});

		it("ends a start whose listener throws only once no resume is still building", async () => {
			await holding(RESUME_AT_ONCE + 2);
			let running = 0;
			const atLetGo: number[] = [];
			const restart = engine({
				resumed: () => atLetGo.push(running),
				resume: vi.fn(async (entry) => {
					running += 1;
					try {
						// A real pause, so some are still building when the last ends.
						await new Promise((resolve) => setTimeout(resolve, 5));
						register(entry);
					} finally {
						running -= 1;
					}
				}),
			});
			const broken = new Error("a listener's fault");
			await expect(
				resumeHeld({
					roster,
					engine: restart.fake,
					finished: (step) => {
						if (step.number === 2) throw broken;
					},
				}),
			).rejects.toBe(broken);
			expect(atLetGo, "let go once, with nothing still building").toEqual([0]);
		});

		it("fails only its own resume when a listener throws as it marks a phase", async () => {
			const held = await holding(3);
			const { restart } = overlapping();
			const broken = new Error("a mark's fault");
			const result = await resumeHeld({
				roster,
				engine: restart.fake,
				mark: (step) => {
					if (step.number === 2) throw broken;
				},
			});
			expect(result.unresumed).toEqual([
				expect.objectContaining({ sessionId: held[1], reason: broken }),
			]);
			expect([...result.resumed].sort()).toEqual([held[0], held[2]].sort());
		});

		it("keeps going alone after a first that failed, until one resumes", async () => {
			const held = await holding(RESUME_AT_ONCE + 2);
			const { restart, atBegin } = overlapping(held[0]);
			const result = await resumeHeld({ roster, engine: restart.fake });
			expect(
				atBegin.slice(0, RESUME_AT_ONCE + 2),
				"a fails alone, b resumes alone, then RESUME_AT_ONCE together",
			).toEqual([
				1,
				1,
				...Array.from({ length: RESUME_AT_ONCE }, (_, n) => n + 1),
			]);
			expect(result.unresumed.map(({ sessionId }) => sessionId)).toEqual([
				held[0],
			]);
		});

		it("says each resume's phases and its end under its own step", async () => {
			const held = await holding(RESUME_AT_ONCE + 1);
			const restart = engine({
				resume: vi.fn(async (entry, _adopt, mark) => {
					mark?.("log");
					// A real pause, so each one's phases interleave with the others'.
					await new Promise((resolve) => setTimeout(resolve, 5));
					mark?.("screen");
					register(entry);
				}),
			});
			const heard: string[] = [];
			await resumeHeld({
				roster,
				engine: restart.fake,
				mark: (step, phase) => heard.push(`${step.sessionId} ${phase}`),
				finished: (step, end) => heard.push(`${step.sessionId} ${end}`),
			});
			for (const id of held)
				expect(
					heard.filter((line) => line.startsWith(id)),
					"its own phases, in order",
				).toEqual([
					`${id} ask`,
					`${id} gate`,
					`${id} log`,
					`${id} screen`,
					`${id} resumed`,
				]);
		});

		it("says how each resume ended: resumed, left parked or not resumed", async () => {
			const [first, resting, failing] = await holding(3);
			const restart = engine({
				restsParked: vi.fn((entry) => entry.sessionId === resting),
				resume: vi.fn(async (entry) => {
					if (entry.sessionId === failing)
						throw new Error("pi would not open it");
					register(entry);
				}),
			});
			const ends = new Map<string, string>();
			await resumeHeld({
				roster,
				engine: restart.fake,
				finished: (step, end) => ends.set(step.sessionId, end),
			});
			expect([first, resting, failing].map((id) => ends.get(id ?? ""))).toEqual(
				["resumed", "parked", "unresumed"],
			);
		});

		it("resumes one woken elsewhere as woken, without asking whether it rests", async () => {
			const [woke, resting] = await holding(2);
			const restsParked = vi.fn((_entry: { sessionId: string }) => true);
			const wokenAs = new Map<string, boolean>();
			const restart = engine({
				restsParked,
				resume: vi.fn(async (entry, woken) => {
					wokenAs.set(entry.sessionId, woken === true);
					register(entry);
				}),
			});
			const ends = new Map<string, string>();
			await resumeHeld({
				roster,
				engine: restart.fake,
				woken: (entry) => entry.sessionId === woke,
				finished: (step, end) => ends.set(step.sessionId, end),
			});
			expect(
				[woke, resting].map((id) => ends.get(id ?? "")),
				"the woken one resumed and the other still rests",
			).toEqual(["resumed", "parked"]);
			expect([...wokenAs], "resumed as woken").toEqual([[woke, true]]);
			expect(
				restsParked.mock.calls.map(([entry]) => entry.sessionId),
				"asked only of the one not woken",
			).toEqual([resting]);
		});
	});

	it("resumes every hold at start and lists one that would not resume as parked", async () => {
		const { fake } = engine();
		const first = backendWith(fake);
		const a = parseOpenResult(await first.execute(anOpen())).sessionId;
		const b = parseOpenResult(await first.execute(anOpen())).sessionId;
		for (const id of [a, b]) await host.stop(id);

		const refused = new Error("pi would not open it");
		const restart = engine({
			resume: vi.fn(async (entry) => {
				if (entry.sessionId === b) throw refused;
				register(entry);
			}),
		});
		expect(await resumeHeld({ roster, engine: restart.fake })).toEqual({
			resumed: [a],
			parked: [],
			dropped: [],
			unresumed: [{ sessionId: b, reason: refused }],
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

	it("drops a hold whose session file is gone at start, building nothing for it", async () => {
		const { fake } = engine();
		const first = backendWith(fake);
		const a = parseOpenResult(await first.execute(anOpen())).sessionId;
		const b = parseOpenResult(await first.execute(anOpen())).sessionId;
		for (const id of [a, b]) await host.stop(id);

		const restart = engine({ lost: (entry) => entry.sessionId === b });
		const said: string[] = [];
		expect(
			await resumeHeld({
				roster,
				engine: restart.fake,
				starting: async (step) => {
					said.push(step.sessionId);
				},
			}),
		).toEqual({
			resumed: [a],
			parked: [],
			dropped: [b],
			unresumed: [],
		});
		expect(said, "the dropped one is never said as resuming").toEqual([a]);
		expect(
			vi.mocked(restart.fake.resume).mock.calls.map(([e]) => e.sessionId),
			"only the one with a log is built",
		).toEqual([a]);
		expect(
			await heldSessionStatus(b, { dir: rosters }),
			"no longer held, so the next start doesn't find it either",
		).toBe("unheld");
		expect(await heldSessionStatus(a, { dir: rosters })).toBe("held");
	});

	describe("with the rollout gate", () => {
		it("opens the first conversation without asking, and refuses a second before preparing or holding it", async () => {
			const { fake } = engine();
			const { stale, gate } = refusing();
			const backend = backendWith(fake, gate);
			const first = parseOpenResult(await backend.execute(anOpen())).sessionId;
			expect(gate).not.toHaveBeenCalled();

			await expect(backend.execute(anOpen())).rejects.toBe(stale);
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
			await backend.execute(anOpen());
			await backend.execute(anOpen());
			expect(gate).toHaveBeenCalledTimes(1);
			expect(roster.entries()).toHaveLength(2);
		});

		it("counts an open still starting, so two at once on an empty host can't both go first", async () => {
			const { stale, gate } = refusing();
			const backend = backendWith(engine().fake, gate);
			const results = await Promise.allSettled([
				backend.execute(anOpen()),
				backend.execute(anOpen()),
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
				await backendWith(fake).execute(anOpen()),
			).sessionId;
			await host.stop(a);
			const { stale, gate } = refusing();
			await expect(backendWith(fake, gate).execute(anOpen())).rejects.toBe(
				stale,
			);
		});

		it("leaves a hold that rests parked unbuilt, asking the gate only for each built after the first", async () => {
			const { fake } = engine();
			const opening = backendWith(fake);
			const held: string[] = [];
			for (let n = 0; n < 3; n++)
				held.push(parseOpenResult(await opening.execute(anOpen())).sessionId);
			for (const id of held) await host.stop(id);
			const [resting, a, b] = held;

			const restart = engine({
				restsParked: vi.fn((entry) => entry.sessionId === resting),
			});
			const gate = vi.fn(() => Promise.resolve());
			expect(
				await resumeHeld({ roster, engine: restart.fake, admitAnother: gate }),
			).toEqual({
				resumed: [a, b],
				parked: [resting],
				dropped: [],
				unresumed: [],
			});
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
				held.push(parseOpenResult(await opening.execute(anOpen())).sessionId);
			for (const id of held) await host.stop(id);
			const [a, b, c] = held;

			const refused = new Error("pi would not open it");
			const restart = engine({
				resume: vi.fn(async (entry) => {
					if (entry.sessionId === a) throw refused;
					register(entry);
				}),
			});
			const { stale, gate } = refusing();
			expect(
				await resumeHeld({ roster, engine: restart.fake, admitAnother: gate }),
			).toEqual({
				resumed: [b],
				parked: [],
				dropped: [],
				unresumed: [
					{ sessionId: a, reason: refused },
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

	it("journals an attach left waiting, naming what it waits on, and when it is answered", async () => {
		// Six of Joel's windows sat blank for hours after a host start on 18
		// November, and nothing the host journaled said which attach waited
		// on what.
		const sessionId = randomUUID();
		let screenUp = (): void => undefined;
		const { fake } = engine({
			prepare: vi.fn(async (request) => ({
				sessionId,
				file: request.op === "adopt" ? request.sessionFile : dir,
				cwd: dir,
			})),
			start: vi.fn(async (prepared: Prepared) => {
				register(prepared);
				await new Promise<void>((done) => {
					screenUp = done;
				});
			}),
		});
		const said: string[] = [];
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: fake,
			say: besideStarts(said),
			attachSlowMs: 20,
		});
		const adopting = backend.execute({
			v: 1,
			id: "a",
			op: "adopt",
			sessionFile: join(dir, "moved.jsonl"),
			attended: false,
		});
		await vi.waitFor(() => expect(host.holds(sessionId)).toBeDefined());
		const attaching = backend.execute({
			v: 1,
			id: "t",
			op: "attach",
			sessionId,
			rows: 1,
			columns: 1,
		});
		await vi.waitFor(() =>
			expect(said, "the journal says the attach waits on the open").toEqual([
				expect.stringMatching(
					new RegExp(
						`\\(${sessionId}\\): a window's attach has waited [0-9.]+ s, now on its open to finish$`,
					),
				),
			]),
		);
		screenUp();
		await adopting;
		expect(parseSessionResult(await attaching)).toEqual({ sessionId });
		expect(said[1], "and says when it was answered").toMatch(
			new RegExp(
				`\\(${sessionId}\\): a window's attach was answered after [0-9.]+ s$`,
			),
		);
		// A real pause past the bound is the point: a timer the attach left
		// armed would fire within it.
		await new Promise((done) => setTimeout(done, 60));
		expect(said, "nothing more, then or after").toHaveLength(2);
	});

	it("journals how long an open took and where, and why one failed", async () => {
		// A fresh conversation took 17 s to take its first words on 23
		// November, and nothing the host journaled said where they went.
		const { fake } = engine({
			start: vi.fn(async (prepared: Prepared, _request, mark) => {
				mark?.("services");
				if (prepared.cwd === "/broken") throw new Error("pi would not open it");
				register(prepared);
				mark?.("screen");
			}),
		});
		const said: string[] = [];
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: fake,
			say: (line) => said.push(line),
		});
		const { sessionId } = parseOpenResult(await backend.execute(anOpen()));
		const seconds = "[0-9]+\\.[0-9] s";
		expect(said, "the open says each phase, in order").toEqual([
			expect.stringMatching(
				new RegExp(
					`\\(${sessionId}\\): its open took ${seconds} \\(prepare ${seconds}, roster ${seconds}, services ${seconds}, screen ${seconds}, rest ${seconds}\\)$`,
				),
			),
		]);
		await expect(
			backend.execute({ ...anOpen(), cwd: "/broken" }),
		).rejects.toThrow("pi would not open it");
		expect(said[1], "a failed one says how far it got, and why").toMatch(
			new RegExp(
				`: its open took ${seconds} \\(prepare ${seconds}, roster ${seconds}, services ${seconds}, rest ${seconds}\\), failing: pi would not open it$`,
			),
		);
	});

	it("journals a slow attach that is refused as refused, and why", async () => {
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
		const said: string[] = [];
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: fake,
			say: besideStarts(said),
			attachSlowMs: 20,
		});
		const opening = backend.execute(anOpen());
		await vi.waitFor(() => expect(roster.entries()).toHaveLength(1));
		const attaching = backend.execute({
			v: 1,
			id: "t",
			op: "attach",
			sessionId,
			rows: 1,
			columns: 1,
		});
		await vi.waitFor(() =>
			expect(said, "the journal says the attach waits").toHaveLength(1),
		);
		fail();
		await expect(opening).rejects.toThrow("extension load failed");
		await expect(attaching).rejects.toThrow("not hosted");
		// The failed open says its own line too (F46), so the two follow the wait.
		expect(said.slice(1), "a refusal is not said to be an answer").toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					new RegExp(
						`\\(${sessionId}\\): a window's attach was refused after [0-9.]+ s: .*not hosted`,
					),
				),
				expect.stringMatching(
					/its open took .*, failing: extension load failed$/,
				),
			]),
		);
		expect(said, "nothing more").toHaveLength(3);
	});

	it("journals nothing for an attach answered at once", async () => {
		const said: string[] = [];
		const { fake } = engine();
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: fake,
			say: besideStarts(said),
			attachSlowMs: 1_000,
		});
		const { sessionId } = parseOpenResult(await backend.execute(anOpen()));
		await backend.execute({
			v: 1,
			id: "t",
			op: "attach",
			sessionId,
			rows: 1,
			columns: 1,
		});
		expect(said, "an attach answered at once says nothing").toEqual([]);
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
		const opening = backend.execute(anOpen());
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

	// 16 November: a hand restart of the background host ended six heavy
	// runs, since nothing said which were going (WCJQSG [a6d540f2]).
	it("drains for a restart and lifts it, answering how the conversations stand and which heavy runs go, and saying who asked", async () => {
		const drains: boolean[] = [];
		const { fake } = engine({
			drain: (on) => {
				drains.push(on);
				return on ? ["c1: job-2 shell: nix-offload there --changed"] : [];
			},
		});
		const said: string[] = [];
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: fake,
			say: besideStarts(said),
		});
		const busy = parseOpenResult(await backend.execute(anOpen()));
		await backend.execute({ ...anOpen(), id: "o2" });
		host.state(busy.sessionId, "busy");

		const drained = parseDrainResult(
			await backend.execute({
				v: 1,
				id: "d",
				op: "drain",
				on: true,
				by: "integration",
			}),
		);
		const lifted = parseDrainResult(
			await backend.execute({ v: 1, id: "d2", op: "drain", on: false }),
		);

		expect(drained).toEqual({
			draining: true,
			busy: 1,
			idle: 1,
			parked: 0,
			heavy: ["c1: job-2 shell: nix-offload there --changed"],
		});
		expect(lifted).toMatchObject({ draining: false, heavy: [] });
		expect(drains, "the engine was asked each time").toEqual([true, false]);
		expect(said[0]).toContain(
			"Draining for a restart, asked by integration over the control socket",
		);
		expect(said[1]).toContain("Drain lifted");
	});

	it("drains over the real socket naming the host it listed, and refuses a drain naming none", async () => {
		const { fake } = engine({ drain: () => [] });
		const backend = backendWith(fake);
		const path = join(dir, "sock", "host.sock");
		const listener = await listenControl({ path, backend, report: () => {} });
		try {
			expect(await drainHost(path, true, "integration")).toEqual({
				draining: true,
				busy: 0,
				idle: 0,
				parked: 0,
				heavy: [],
			});
			await expect(
				controlRequest(path, { v: 1, id: "d", op: "drain", on: false }),
			).rejects.toThrow("expectedHost");
		} finally {
			await listener.close();
		}
	});

	it("refuses a drain where its engine can't drain", async () => {
		const backend = backendWith(engine().fake);
		await expect(
			backend.execute({ v: 1, id: "d", op: "drain", on: true }),
		).rejects.toThrow("This host can't drain");
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
				ids.push(
					parseOpenResult(await ask(path, { ...anOpen(), id })).sessionId,
				);
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

describe("the order a start resumes what it held", () => {
	/**
	 * Three conversations held and stopped, as a restart finds them, and an
	 * engine whose first resume waits until `go`, saying each it resumes.
	 */
	async function heldThree() {
		const first = backendWith(engine().fake);
		const held = async (id: string) =>
			parseOpenResult(await first.execute({ ...anOpen(), id })).sessionId;
		const a = await held("a");
		const b = await held("b");
		const c = await held("c");
		for (const id of [a, b, c]) await host.stop(id);
		let go = (): void => undefined;
		const going = new Promise<void>((resolve) => {
			go = resolve;
		});
		const resumes: [string, boolean | undefined][] = [];
		const restart = engine({
			resume: vi.fn(async (entry, woken) => {
				resumes.push([entry.sessionId, woken]);
				if (entry.sessionId === a) await going;
				register(entry);
			}),
		});
		return { a, b, c, go, resumes, restart: restart.fake };
	}

	it("resumes one asked for ahead of those it had yet to reach, answering once it has", async () => {
		const { a, b, c, go, resumes, restart } = await heldThree();
		const order = heldOrder(roster);
		const started = resumeHeld({ roster, engine: restart, order });
		await until("the start to resume its first", () => resumes.length === 1);
		let answered = false;
		const asked = order.ahead(c).then(() => {
			answered = true;
		});
		await Promise.resolve();
		expect(answered, "not before it has resumed").toBe(false);
		go();
		await asked;
		expect(host.holds(c), "running once answered").toBeDefined();
		expect(await started).toEqual({
			resumed: [a, c, b],
			parked: [],
			dropped: [],
			unresumed: [],
		});
		expect(resumes.map(([id]) => id)).toEqual([a, c, b]);
	});

	it("answers at once for one it owes nothing, and for every one once the start has ended", async () => {
		const { a, go, restart } = await heldThree();
		const order = heldOrder(roster);
		await expect(order.ahead(randomUUID())).resolves.toBeUndefined();
		go();
		await resumeHeld({ roster, engine: restart, order });
		await expect(order.ahead(a)).resolves.toBeUndefined();
	});

	it("lets a window, a wake or a close asked as it starts wait for the start's own resume, so none resumes twice", async () => {
		const { a, b, c, go, resumes, restart } = await heldThree();
		const order = heldOrder(roster);
		const backend = hostBackend({
			identity: { key: host.key, owner: host.owner },
			host,
			roster,
			engine: restart,
			held: order,
		});
		const started = resumeHeld({ roster, engine: restart, order });
		await until("the start to resume its first", () => resumes.length === 1);
		const attached = backend.execute({
			v: 1,
			id: "w",
			op: "attach",
			sessionId: c,
			rows: 24,
			columns: 80,
		});
		const woke = backend.wake(b);
		const closed = backend.execute({
			v: 1,
			id: "x",
			op: "close",
			sessionId: a,
		});
		go();
		await Promise.all([attached, woke, closed, started]);
		expect(
			resumes,
			"each resumed once, by the start, as a start resumes",
		).toEqual([
			[a, false],
			[c, false],
			[b, false],
		]);
		expect(host.holds(a), "the close came after its resume").toBeUndefined();
		expect(roster.entries().map(({ sessionId }) => sessionId)).toEqual([b, c]);
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
			await backendWith(fake).execute({ ...anOpen(), quest: "QEST-1" }),
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
