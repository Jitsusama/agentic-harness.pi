/**
 * A host process: kind from argv, realm from env, ready once listening,
 * parked on a stop signal. Long because every case drives one runHost from
 * start to stop over the same fakes, and its start, its asks of systemd and
 * its stop change together.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import { hostKey } from "../../../host/service/address.ts";
import type { ConversationEngine } from "../../../host/service/backend.ts";
import { childHost } from "../../../host/service/child.ts";
import { controlRequest } from "../../../host/service/client.ts";
import type {
	BeatOptions,
	ProfileOptions,
} from "../../../host/service/hold-watch.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import { hostKind, runHost, slotResumed } from "../../../host/service/run.ts";
import type { BackstopOptions } from "../../../host/service/stop-backstop.ts";
import { STEP_ALLOWANCE_MS } from "../../../host/service/systemd.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";
import { placeChildren } from "../../../lib/internal/priority/place.ts";
import { fakeUnits } from "./support/fake-children.ts";
import { shortRuntime } from "./support/short-runtime.ts";

// The net is process-wide; serve.test.ts checks a host sets it.
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: () => {},
}));

// A real backstop would SIGKILL this whole worker past a case whose stop
// never ended; stop-backstop.test.ts runs the thread in a child of its own.
vi.mock("../../../host/service/stop-backstop.ts", () => ({
	backstopStop: () => ({ held() {}, done() {} }),
}));

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-run-"));
	// What a host keeps between its runs stays in the case's own folder.
	vi.stubEnv("XDG_STATE_HOME", join(dir, "state"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

const places = () => ({
	rosterDir: join(dir, "rosters"),
	registryDir: join(dir, "hosts"),
});

const env = () => ({
	MYCELIUM_REALM: "work",
	XDG_RUNTIME_DIR: join(dir, "run"),
});

const socket = () => join(dir, "run", "pi-host", "work-background.sock");

/** An engine that registers what it opens with the real SessionHost. */
const engine = async (host: SessionHost): Promise<ConversationEngine> => ({
	prepare: async () => ({
		sessionId: randomUUID(),
		file: join(dir, `${randomUUID()}.jsonl`),
		cwd: dir,
	}),
	start: async ({ sessionId, file, cwd }) => {
		host.register({ id: sessionId, file, cwd, env: {}, close: () => {} });
	},
	discard: async () => {},
	resume: async () => {},
	abort: async () => {},
	backgroundOf: () => 0,
});

/** The engine, with a resume that takes `ms`, as one does while others take their turns. */
function slowResume(ms: number) {
	return async (host: SessionHost): Promise<ConversationEngine> => ({
		...(await engine(host)),
		// The resume's own length is what the case measures the asks against.
		resume: () => new Promise((resolve) => setTimeout(resolve, ms)),
	});
}

/** Leave one conversation held, as a stopped host leaves it, answering its id. */
async function heldOne(): Promise<string> {
	const [sessionId] = await heldSome(1);
	if (!sessionId) throw new Error("nothing held");
	return sessionId;
}

/** Lets every conversation after the first in, as a current install would. */
const admitting = async () => {};

/** Open `count` conversations and stop, so the next start holds them. */
async function heldSome(count: number): Promise<string[]> {
	const signals = new EventEmitter();
	const seeded = await runHost({
		argv: ["background"],
		env: env(),
		engine,
		signals,
		ready: async () => {},
		progress: async () => {},
		say: () => {},
		report: () => {},
		places: places(),
		rollout: admitting,
	});
	const held: string[] = [];
	try {
		for (let n = 0; n < count; n++) {
			const reply = await controlRequest(seeded.serving.path, {
				v: 1,
				id: `o${n}`,
				op: "open",
				cwd: dir,
				attended: false,
			});
			if (!reply.ok) throw new Error(reply.error.message);
			held.push(parseOpenResult(reply.result).sessionId);
		}
	} finally {
		signals.emit("SIGTERM");
		await seeded.stopped;
	}
	return held;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe("hostKind", () => {
	it("takes attended or background alone", () => {
		expect(hostKind(["attended"])).toBe("attended");
		expect(hostKind(["background"])).toBe("background");
	});

	it("refuses anything else", () => {
		for (const argv of [[], ["work"], ["attended", "extra"]])
			expect(() => hostKind(argv)).toThrow(
				"Usage: pi-host attended|background",
			);
	});
});

describe("slotResumed", () => {
	const ID = "a0000000-0000-4000-8000-000000000001";
	const slot = {
		held: {
			sessionId: ID,
			file: `/s/${ID}.jsonl`,
			cwd: "/w",
			attended: false,
			since: "2026-11-20T00:00:00.000Z",
		},
	};
	const listed = [{ id: ID, state: "parked" as const, since: slot.held.since }];

	it.each([
		["resumed", { held: () => listed, dropped: [], unresumed: [] }],
		["parked", { held: () => [], dropped: [], unresumed: [] }],
		["unresumed", { held: () => [], dropped: [ID], unresumed: [] }],
		[
			"unresumed",
			{
				held: () => listed,
				dropped: [],
				unresumed: [{ sessionId: ID, reason: "its build threw" }],
			},
		],
	] as const)(
		"reads %s from what the start held, dropped and could not resume",
		(end, serving) => {
			expect(slotResumed(serving, slot)).toBe(end);
		},
	);
});

describe("a child host", () => {
	// A child's key is its supervisor's, so the policy that started it
	// moves its conversation too: asked, it would start another unit.
	it("runs its own conversation, never asking its key's policy to move it", async () => {
		const runtime = join(dir, "run");
		const folder = join(runtime, "pi-host", "work-background.d");
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await writeFile(join(folder, "s.json"), "{}");
		const started = childHost(
			{
				PI_HOST_CHILD_KEY: "work-background",
				PI_HOST_CHILD_SOCKET: join(folder, "s.sock"),
				MYCELIUM_REALM: "work",
				XDG_RUNTIME_DIR: runtime,
			},
			"/harness",
		);
		const units = fakeUnits(folder, "work-background", vi.fn());
		const policy = vi.fn(async () => ({
			moves: () => true,
			opens: () => true,
			close: () => undefined,
		}));
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["--child"],
			env: { MYCELIUM_REALM: "work", XDG_RUNTIME_DIR: runtime },
			child: { slot: started.slot, life: started.life },
			engine: (host) => {
				started.hosts(host);
				return engine(host);
			},
			signals,
			ready: async () => {},
			report: vi.fn(),
			children: { units, policy },
			places: { registryDir: join(dir, "hosts") },
		});
		try {
			const reply = await controlRequest(run.serving.path, {
				v: 1,
				id: "o",
				op: "open",
				cwd: dir,
				attended: false,
			});
			expect(reply.ok, "the child opened its conversation").toBe(true);
			expect(policy, "nobody asked the key's policy").not.toHaveBeenCalled();
			expect(units.started, "no unit started for it").toEqual([]);
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
	});

	// The other side of the guard: a realm host keeps its children, so a
	// guard that dropped them for every host would fail here.
	it("leaves a realm host asking its key's policy what moves to a child", async () => {
		// A realm host whose children's sockets wouldn't fit runs without
		// them and reports it, so this host's runtime folder is one they
		// fit in, as /run/user/<uid> is.
		const runtime = await shortRuntime("work-background");
		onTestFinished(() => rm(runtime, { recursive: true, force: true }));
		const folder = join(runtime, "pi-host", "work-background.d");
		await mkdir(folder, { recursive: true, mode: 0o700 });
		const unitFaults = vi.fn();
		const units = fakeUnits(folder, "work-background", unitFaults);
		const policy = vi.fn(async () => ({
			moves: () => false,
			opens: () => false,
			close: () => undefined,
		}));
		const signals = new EventEmitter();
		const report = vi.fn();
		const run = await runHost({
			argv: ["background"],
			env: { MYCELIUM_REALM: "work", XDG_RUNTIME_DIR: runtime },
			engine,
			signals,
			ready: async () => {},
			report,
			children: { units, policy },
			places: { registryDir: join(dir, "hosts") },
		});
		// Its start asks the policy, before anything opens.
		try {
			expect(policy).toHaveBeenCalledExactlyOnceWith("work-background");
			expect(units.started, "its start opens no child").toEqual([]);
			expect(report).not.toHaveBeenCalled();
			expect(unitFaults).not.toHaveBeenCalled();
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
	});
});

/** When each ping came, in ms since the run began. */
function pingTimes(): { at: number[]; alive: () => Promise<void> } {
	const began = performance.now();
	const at: number[] = [];
	return {
		at,
		alive: async () => {
			at.push(performance.now() - began);
		},
	};
}

/** The longest wait between two pings. */
function longestGap(at: readonly number[]): number {
	return Math.max(...at.slice(1).map((time, index) => time - (at[index] ?? 0)));
}

// A watchdog timeout of a second, so pings come every 250 ms.
const WATCHED = { WATCHDOG_USEC: "1000000" };
const TIMEOUT_MS = 1000;
// Twice that for the long turn, so a starved lender's late timer isn't
// read as a gap.
const LONG_WATCHED = { WATCHDOG_USEC: "2000000" };
const LONG_TIMEOUT_MS = 2000;
// The journal's line for a loop held past a beat: how long, of how long,
// and how many conversations were mid-turn.
const HELD =
	/^the loop held (\d+\.\d) s past a watchdog beat, of the (\d+\.\d) s systemd waits, with (\d+) of (\d+) conversations mid-turn$/;

describe("runHost's watchdog", () => {
	it("keeps pinging through a turn twice the timeout's length", async () => {
		// A conversation's work is awaited, never run on the loop, so a turn
		// as long as it likes leaves the loop free to ping: here an open the
		// engine takes two timeouts to start stands in for a ten-minute turn.
		const slow = async (host: SessionHost): Promise<ConversationEngine> => {
			const inner = await engine(host);
			return {
				...inner,
				start: async (prepared, request) => {
					const turn = 2 * LONG_TIMEOUT_MS;
					// The turn itself, which the host awaits as it would a model's.
					await new Promise((resolve) => setTimeout(resolve, turn));
					await inner.start(prepared, request);
				},
			};
		};
		const pings = pingTimes();
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: { ...env(), ...LONG_WATCHED },
			engine: slow,
			signals,
			ready: async () => {},
			status: async () => {},
			alive: pings.alive,
			say: () => {},
			report: () => {},
			places: places(),
		});
		try {
			const reply = await controlRequest(run.serving.path, {
				v: 1,
				id: "o",
				op: "open",
				cwd: dir,
				attended: false,
			});
			if (!reply.ok) throw new Error(reply.error.message);
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
		expect(
			pings.at.length,
			`pinged through the turn: ${pings.at.join(", ")}`,
		).toBeGreaterThanOrEqual(6);
		expect(
			longestGap(pings.at),
			`the longest wait between pings: ${pings.at.join(", ")}`,
		).toBeLessThan(LONG_TIMEOUT_MS);
	});

	it("lets a ping that never comes back hold back only the next one", async () => {
		const at: number[] = [];
		const within: number[] = [];
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: { ...env(), ...WATCHED },
			engine,
			signals,
			ready: async () => {},
			status: async () => {},
			// The first ping hangs, as a systemd-notify that never ends would.
			alive: (_env, given) => {
				at.push(performance.now());
				within.push(given);
				return at.length === 1 ? new Promise(() => {}) : Promise.resolve();
			},
			say: () => {},
			report: () => {},
			places: places(),
		});
		try {
			await vi.waitFor(
				() => {
					expect(at.length, "pings after the one that hung").toBeGreaterThan(2);
				},
				{ timeout: 2 * TIMEOUT_MS },
			);
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
		expect(
			within.every((given) => given === TIMEOUT_MS / 4),
			`each ping given a beat: ${within.join(", ")}`,
		).toBe(true);
		expect(
			(at[1] ?? 0) - (at[0] ?? 0),
			"the hung ping held back one beat, not every beat after it",
		).toBeLessThan(TIMEOUT_MS);
	});

	it("pings at once when its loop turns again after a hold, though the last ping's end is still unread", async () => {
		// On 15 November a host's loop held 61 s, and the beat that came
		// once it turned again took the ping before the hold as still on its
		// way: that ping's end comes through the loop's poll, which a turn
		// reaches only after its timers. So it skipped, and systemd's two
		// minutes ran out 0.8 s before the beat after it.
		const at: number[] = [];
		const beat = LONG_TIMEOUT_MS / 4;
		// Late by more than half the timeout, as a beat must be to count
		// as held.
		const hold = 4 * beat;
		let spun = false;
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: { ...env(), ...LONG_WATCHED },
			engine,
			signals,
			ready: async () => {},
			status: async () => {},
			alive: () => {
				at.push(performance.now());
				if (at.length === 2 && !spun) {
					spun = true;
					// Hold the loop just after this ping goes, before its end is read.
					setImmediate(() => {
						const until = performance.now() + hold;
						while (performance.now() < until) {
							// Spinning, as a loop held by synchronous work or by
							// faulting its heap back from swap is.
						}
					});
				}
				// It ends as systemd-notify does, a child's exit read in the
				// loop's poll, a moment after the hold began.
				return new Promise((resolve) =>
					execFile("sleep", ["0.05"], () => resolve()),
				);
			},
			say: () => {},
			report: () => {},
			places: places(),
		});
		try {
			await vi.waitFor(
				() => {
					expect(at.length, "a ping after the hold").toBeGreaterThan(2);
				},
				{ timeout: 4 * LONG_TIMEOUT_MS },
			);
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
		expect(
			(at[2] ?? 0) - (at[1] ?? 0),
			`the first ping after the hold came as the loop turned, not a beat on: ${at.join(", ")}`,
		).toBeLessThan(hold + beat / 2);
	});

	it("stops pinging while its loop is blocked, so a wedged host is restarted", async () => {
		const pings = pingTimes();
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: { ...env(), ...WATCHED },
			engine,
			signals,
			ready: async () => {},
			status: async () => {},
			alive: pings.alive,
			say: () => {},
			report: () => {},
			places: places(),
		});
		try {
			await vi.waitFor(() => {
				expect(pings.at.length, "a ping before the block").toBeGreaterThan(0);
			});
			// The test shares the host's loop, so spinning here wedges it as a
			// host stuck in a loop of its own would be.
			const until = performance.now() + 1.5 * TIMEOUT_MS;
			while (performance.now() < until) {
				// Spinning, as a wedged loop does.
			}
			const blocked = pings.at.length;
			await vi.waitFor(() => {
				expect(pings.at.length, "a ping once it turns again").toBeGreaterThan(
					blocked,
				);
			});
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
		expect(
			longestGap(pings.at),
			`no ping while blocked: ${pings.at.join(", ")}`,
		).toBeGreaterThanOrEqual(1.5 * TIMEOUT_MS);
	});

	it("says in the journal how long its loop held past a beat", async () => {
		const said: string[] = [];
		const pings = pingTimes();
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: { ...env(), ...WATCHED },
			engine,
			signals,
			ready: async () => {},
			status: async () => {},
			alive: pings.alive,
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
		});
		try {
			await vi.waitFor(() => {
				expect(pings.at.length, "a ping before the block").toBeGreaterThan(0);
			});
			const until = performance.now() + 1.5 * TIMEOUT_MS;
			while (performance.now() < until) {
				// Spinning, as a loop held by synchronous work is.
			}
			await vi.waitFor(() => {
				expect(said.join("\n")).toMatch(/loop held/);
			});
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
		const held = said
			.map((line) => HELD.exec(line))
			.find((match) => match !== null);
		expect(held, `a held line: ${said.join(" | ")}`).toBeDefined();
		expect(
			Number(held?.[1]),
			"held for about the block, less the beat it was due in",
		).toBeGreaterThanOrEqual(TIMEOUT_MS / 1000);
		expect(held?.[2], "the watchdog's own timeout").toBe("1.0");
		expect(held?.slice(3), "none mid-turn, of none held").toEqual(["0", "0"]);
	});

	it("watches what holds its loop while systemd watches it, and stops with it", async () => {
		const serve = async (extra: NodeJS.ProcessEnv) => {
			const watches = { started: 0, stopped: 0 };
			const beats: (BeatOptions | undefined)[] = [];
			const profiles: (ProfileOptions | undefined)[] = [];
			const signals = new EventEmitter();
			const run = await runHost({
				argv: ["background"],
				env: { ...env(), ...extra },
				engine,
				signals,
				ready: async () => {},
				status: async () => {},
				alive: async () => {},
				holds: (watch) => {
					beats.push(watch.beat);
					profiles.push(watch.profile);
					watches.started += 1;
					return () => {
						watches.stopped += 1;
					};
				},
				say: () => {},
				report: () => {},
				places: places(),
			});
			const running = { ...watches };
			signals.emit("SIGTERM");
			await run.stopped;
			return { running, stopped: watches, beats, profiles };
		};
		const socket = { ...WATCHED, NOTIFY_SOCKET: "/run/systemd/notify" };
		const watched = await serve(socket);
		const folder = watched.profiles[0]?.folder ?? "";
		expect(
			folder.endsWith(
				["", "host-service", hostKey("work", "background"), "held"].join(sep),
			),
			`a spin profiled into the host's own state: ${folder}`,
		).toBe(true);
		expect(
			watched.beats.map((beat) => beat?.every),
			"beats for a loop in the disk as often as the loop beats",
		).toEqual([TIMEOUT_MS / 4]);
		expect(
			watched.beats[0]?.env.NOTIFY_SOCKET,
			"in the environment naming systemd's socket",
		).toBe(socket.NOTIFY_SOCKET);
		const unbeaten = await serve(WATCHED);
		expect(
			unbeaten.beats,
			"watched, but unbeaten, where systemd names no socket",
		).toEqual([undefined]);
		expect(
			unbeaten.profiles[0]?.folder,
			"a spin profiled there all the same",
		).toBe(folder);
		expect(watched.running, "watched once while serving").toEqual({
			started: 1,
			stopped: 0,
		});
		expect(watched.stopped, "stopped with the host").toEqual({
			started: 1,
			stopped: 1,
		});
		const unwatched = await serve({});
		expect(unwatched.stopped, "not watched without a watchdog").toEqual({
			started: 0,
			stopped: 0,
		});
	});

	it("doesn't ping without a watchdog, nor once stopped", async () => {
		// One host at a time, as a process installs only one.
		const serve = async (
			extra: NodeJS.ProcessEnv,
			pings: ReturnType<typeof pingTimes>,
			during: () => Promise<void>,
		) => {
			const signals = new EventEmitter();
			const run = await runHost({
				argv: ["background"],
				env: { ...env(), ...extra },
				engine,
				signals,
				ready: async () => {},
				status: async () => {},
				alive: pings.alive,
				say: () => {},
				report: () => {},
				places: places(),
			});
			try {
				await during();
			} finally {
				signals.emit("SIGTERM");
				await run.stopped;
			}
		};
		const unwatched = pingTimes();
		await serve({}, unwatched, async () => {
			// Two pings' worth of a timeout, had it one.
			await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS / 2));
		});
		const watched = pingTimes();
		await serve(WATCHED, watched, async () => {
			await vi.waitFor(() => {
				expect(watched.at.length, "the watched host pings").toBeGreaterThan(1);
			});
		});
		const stopped = watched.at.length;
		// Two pings' worth, to show none comes once the host has stopped.
		await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS / 2));
		expect(unwatched.at, "no pings without a watchdog").toEqual([]);
		expect(watched.at.length, "no pings once stopped").toBe(stopped);
	});
});

describe("runHost", () => {
	it("keeps its status current as conversations come and go", async () => {
		const signals = new EventEmitter();
		const statuses: string[] = [];
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals,
			ready: async (_env, status) => {
				statuses.push(status);
			},
			status: async (_env, status) => {
				statuses.push(status);
			},
			statusEvery: 10,
			say: () => {},
			report: () => {},
			places: places(),
		});
		try {
			const reply = await controlRequest(run.serving.path, {
				v: 1,
				id: "o",
				op: "open",
				cwd: dir,
				attended: false,
			});
			if (!reply.ok) throw new Error(reply.error.message);
			await vi.waitFor(() => {
				expect(statuses.at(-1), "the status once one opened").toBe(
					"ready: loaded 1, parked 0, dropped 0",
				);
			});
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
		const after = statuses.length;
		// Five checks' worth, to show none comes once the host has stopped.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(statuses, "said only as it changed").toEqual([
			"ready: loaded 0, parked 0, dropped 0",
			"ready: loaded 1, parked 0, dropped 0",
			"stopping, parking 1 conversation",
		]);
		expect(statuses.length, "nothing said once stopped").toBe(after);
	});

	it("says it is ready only once it listens, and parks on a stop signal", async () => {
		const signals = new EventEmitter();
		const ready = vi.fn(async () => {
			expect(await exists(socket()), "the socket listens before ready").toBe(
				true,
			);
		});
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals,
			ready,
			say: () => {},
			report: () => {},
			places: places(),
		});
		expect(ready).toHaveBeenCalledTimes(1);
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);

		expect(run.signalled(), "no stop signal has come yet").toBe(false);
		signals.emit("SIGTERM");
		await run.stopped;
		expect(run.signalled(), "it was stopped by a signal").toBe(true);
		expect(await exists(socket()), "a stopped host leaves no socket").toBe(
			false,
		);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
		).toBe("held");
	});

	// A `launchctl stop` while a Mac's host parks to restart keeps it down.
	it("remembers a stop signal that comes while a stop it asked of itself parks, and hears a second", async () => {
		const signals = new EventEmitter();
		// The stop's status holds until the test lets it go, so both signals
		// come while the stop is under way, not before it began.
		let letGo = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		const told: string[] = [];
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals,
			ready: async () => {},
			status: async (_env, now) => {
				told.push(now);
				if (now.startsWith("stopping")) await held;
			},
			say: () => {},
			report: () => {},
			places: places(),
		});
		await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		const stopping = run.stop();
		await vi.waitFor(() => {
			expect(told, "the stop is under way").toContain(
				"stopping, parking 1 conversation",
			);
		});
		signals.emit("SIGTERM");
		expect(
			signals.listenerCount("SIGTERM"),
			"a second stop signal is still heard, so node's default never kills the host by it",
		).toBeGreaterThan(0);
		signals.emit("SIGTERM");
		letGo();
		await stopping;
		await run.stopped;
		expect(run.signalled(), "the signal came during the stop").toBe(true);
	});

	// Node's default would kill a host signalled as it starts, which
	// launchd starts again.
	it("hears a stop signal that comes while it starts, and stops once it serves", async () => {
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine: async (host) => {
				signals.emit("SIGTERM");
				return engine(host);
			},
			signals,
			ready: async () => {},
			say: () => {},
			report: () => {},
			places: places(),
		});
		await run.stopped;
		expect(run.signalled(), "the signal came during the start").toBe(true);
		expect(await exists(socket()), "a stopped host leaves no socket").toBe(
			false,
		);
	});

	// launchd counts its ExitTimeOut from the signal, not from when the
	// host serves, so a slow start leaves the stop that much less.
	it("counts a stop's bounds from a signal that came while it started", async () => {
		const signals = new EventEmitter();
		const armed: number[] = [];
		const run = await runHost({
			argv: ["background"],
			// A unit stopping within 160 s, of which the backstop takes 7/8.
			env: { ...env(), PI_HOST_STOP_USEC: "160000000" },
			engine: async (host) => {
				signals.emit("SIGTERM");
				// The start goes on a while after the signal, as a slow one would.
				await new Promise((resolve) => setTimeout(resolve, 300));
				return engine(host);
			},
			signals,
			ready: async () => {},
			status: async () => {},
			backstop: ({ within }) => {
				armed.push(within);
				return { held() {}, done() {} };
			},
			say: () => {},
			report: () => {},
			places: places(),
		});
		await run.stopped;
		expect(armed, "armed once, as the stop began").toHaveLength(1);
		expect(
			armed[0],
			"the backstop's 140 s counts from the signal, 300 ms before the stop",
		).toBeLessThanOrEqual(140_000 - 300);
		expect(
			armed[0],
			"nor does it count from much before the signal",
		).toBeGreaterThan(140_000 - 10_000);
	});

	it("parks on a stop it asks of itself as on a stop signal, as a Mac's restart does", async () => {
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals: new EventEmitter(),
			ready: async () => {},
			say: () => {},
			report: () => {},
			places: places(),
		});
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);

		await run.stop();
		await run.stopped;
		expect(run.signalled(), "it stopped without a signal").toBe(false);
		expect(await exists(socket()), "a stopped host leaves no socket").toBe(
			false,
		);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
		).toBe("held");
	});

	// On 14 November a park never settled, awaiting a model request its
	// abort hadn't ended, and systemd killed the host 60 s into its stop.
	it("ends a stop a park holds, naming the conversation, inside its bound", async () => {
		const signals = new EventEmitter();
		const said: string[] = [];
		let parks = () => {};
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine: async (host) => ({
				...(await engine(host)),
				start: async ({ sessionId, file, cwd }) => {
					// A park that doesn't end until the case lets it, as a hung durable close.
					const close = () =>
						new Promise<void>((parked) => {
							parks = parked;
						});
					host.register({ id: sessionId, file, cwd, env: {}, close });
				},
			}),
			signals,
			ready: async () => {},
			status: async () => {},
			stopWithin: 200,
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
		});
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);

		signals.emit("SIGTERM");
		await run.stopped;
		expect(
			said.filter((line) => line.includes("not parked")),
			"says which conversation it ends unparked",
		).toEqual([
			expect.stringMatching(
				new RegExp(
					`stopping after \\d+ ms, past its 200 ms bound, 1 not parked: ${sessionId}`,
				),
			),
		]);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			"the next host takes it up",
		).toBe("held");
		// The process would end here; the case lets the park end instead, so
		// the host it installed is gone before the next case starts one.
		parks();
		await run.serving.stop();
	});

	it("ends a stop a park holds within three quarters of its unit's stop limit", async () => {
		const signals = new EventEmitter();
		const said: string[] = [];
		let parks = () => {};
		const run = await runHost({
			argv: ["background"],
			// A unit stopping within 400 ms, as systemd's 150 s is to its 112.5 s.
			env: { ...env(), PI_HOST_STOP_USEC: "400000" },
			engine: async (host) => ({
				...(await engine(host)),
				start: async ({ sessionId, file, cwd }) => {
					const close = () =>
						new Promise<void>((parked) => {
							parks = parked;
						});
					host.register({ id: sessionId, file, cwd, env: {}, close });
				},
			}),
			signals,
			ready: async () => {},
			status: async () => {},
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
		});
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);

		signals.emit("SIGTERM");
		await run.stopped;
		expect(
			said.filter((line) => line.includes("not parked")),
			"ends at three quarters of the unit's limit, naming what it left",
		).toEqual([
			expect.stringMatching(
				new RegExp(
					`stopping after \\d+ ms, past its 300 ms bound, 1 not parked: ${sessionId}`,
				),
			),
		]);
		parks();
		await run.serving.stop();
	});

	// At 04:33 on 18 November a stop's loop ran on a CPU past its own
	// bound, a timer that never fired, and systemd killed the host.
	it("arms a backstop beside the loop with what is unparked, tells it each second, and disarms it as the stop ends", async () => {
		const signals = new EventEmitter();
		const armed: BackstopOptions[] = [];
		const told: (readonly string[])[] = [];
		let disarmed = 0;
		let parks = () => {};
		const run = await runHost({
			argv: ["background"],
			// A unit stopping within 160 s, of which the backstop takes 7/8.
			env: { ...env(), PI_HOST_STOP_USEC: "160000000" },
			engine: async (host) => ({
				...(await engine(host)),
				start: async ({ sessionId, file, cwd }) => {
					const close = () =>
						new Promise<void>((parked) => {
							parks = parked;
						});
					host.register({ id: sessionId, file, cwd, env: {}, close });
				},
			}),
			signals,
			ready: async () => {},
			status: async () => {},
			// Long enough for a second's telling before the bound ends it.
			stopWithin: 1500,
			backstop: (options) => {
				armed.push(options);
				return {
					held(ids) {
						told.push(ids);
					},
					done() {
						disarmed += 1;
					},
				};
			},
			say: () => {},
			report: () => {},
			places: places(),
		});
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);

		signals.emit("SIGTERM");
		await run.stopped;
		expect(armed, "armed once, as the stop began").toEqual([
			{
				within: 140_000,
				file: expect.stringMatching(/\/not-parked\.json$/),
				ids: [sessionId],
			},
		]);
		expect(told, "told again a second in").toEqual([[sessionId]]);
		expect(disarmed, "disarmed as the stop ended").toBe(1);
		parks();
		await run.serving.stop();
	});

	// On 14 November the attended host's next start resumed two
	// conversations in 72 s each, and nothing said which had parked.
	it("says on the next start's resume which conversation the last stop left unparked, once", async () => {
		const signals = new EventEmitter();
		let parks = () => {};
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine: async (host) => ({
				...(await engine(host)),
				start: async ({ sessionId, file, cwd }) => {
					const close = () =>
						new Promise<void>((parked) => {
							parks = parked;
						});
					host.register({ id: sessionId, file, cwd, env: {}, close });
				},
			}),
			signals,
			ready: async () => {},
			status: async () => {},
			stopWithin: 200,
			say: () => {},
			report: () => {},
			places: places(),
		});
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		signals.emit("SIGTERM");
		await run.stopped;
		parks();
		await run.serving.stop();

		const resumingLines = async () => {
			const said: string[] = [];
			const next = new EventEmitter();
			const started = await runHost({
				argv: ["background"],
				env: env(),
				engine,
				signals: next,
				ready: async () => {},
				progress: async () => {},
				say: (line) => said.push(line),
				report: () => {},
				places: places(),
			});
			next.emit("SIGTERM");
			await started.stopped;
			return said.filter((line) => line.includes(": resuming "));
		};
		expect(await resumingLines(), "the start after it").toEqual([
			expect.stringMatching(
				new RegExp(
					`: resuming 1 of 1: ${sessionId} \\(not parked at the \\d\\d:\\d\\d stop\\)$`,
				),
			),
		]);
		expect(await resumingLines(), "a start after one that parked").toEqual([
			expect.stringMatching(new RegExp(`: resuming 1 of 1: ${sessionId}$`)),
		]);
	});

	it("gives serve the viewer bridge, built once over the host it runs", async () => {
		const signals = new EventEmitter();
		const viewer = vi.fn((_host: SessionHost) => ({
			attach: () => {
				throw new Error("no screens here");
			},
		}));
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			viewer,
			signals,
			ready: async () => {},
			say: () => {},
			report: () => {},
			places: places(),
		});
		expect(viewer.mock.calls.map(([host]) => host.key)).toEqual([
			"work-background",
		]);
		signals.emit("SIGTERM");
		await run.stopped;
	});

	it("refuses to start without a realm, before any socket", async () => {
		await expect(
			runHost({
				argv: ["background"],
				env: { XDG_RUNTIME_DIR: join(dir, "run") },
				engine,
				signals: new EventEmitter(),
				ready: async () => {},
				places: places(),
			}),
		).rejects.toThrow("Host needs MYCELIUM_REALM or PI_HOME_REALM");
		expect(await exists(socket()), "no socket without a realm").toBe(false);
	});

	it("says each step of the start before ready, and how long it took", async () => {
		const first = new EventEmitter();
		const seeded = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals: first,
			ready: async () => {},
			progress: async () => {},
			say: () => {},
			report: () => {},
			places: places(),
		});
		const reply = await controlRequest(seeded.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		first.emit("SIGTERM");
		await seeded.stopped;

		const heard: string[] = [];
		const said: string[] = [];
		const second = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals: second,
			ready: async () => {
				heard.push("ready");
			},
			progress: async (_env, status) => {
				heard.push(status);
			},
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
		});
		try {
			expect(heard).toEqual([
				"building the engine",
				`resuming 1 of 1: ${sessionId}`,
				"ready",
			]);
			expect(said).toHaveLength(4);
			expect(said[0]).toMatch(/^\d+\.\d s: building the engine$/);
			expect(said[1]).toMatch(/^\d+\.\d s: resuming 1 of 1: /);
			expect(said[2]).toMatch(
				/^\d+\.\d s: resumed 1 of 1 in \d+\.\d s \(ask \d+\.\d s, gate \d+\.\d s, rest \d+\.\d s\)$/,
			);
			// This engine's resume registers nothing, so the host runs none and
			// counts the one it holds parked, as its list would show it.
			expect(said[3]).toMatch(
				/^\d+\.\d s: ready: loaded 0, parked 1, dropped 0, listening on /,
			);
		} finally {
			second.emit("SIGTERM");
			await run.stopped;
		}
	});

	// The attended host on 14 November: two resumes took 72 s each, and
	// nothing said which part of them did.
	it("says how long each phase of a resume took", async () => {
		const sessionId = await heldOne();
		const PHASE_MS = 120;
		const said: string[] = [];
		const second = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine: async (host) => ({
				...(await engine(host)),
				resume: async (_entry, _woken, mark) => {
					mark?.("log");
					// A real pause: each phase's logged time is what is measured.
					await new Promise((done) => setTimeout(done, PHASE_MS));
					mark?.("runtime");
					// A real pause, for the second phase's time.
					await new Promise((done) => setTimeout(done, PHASE_MS));
				},
			}),
			signals: second,
			ready: async () => {},
			progress: async () => {},
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
		});
		try {
			const line = said.find((each) => each.includes("resumed 1 of 1"));
			expect(line, `the resume of ${sessionId} is said`).toMatch(
				/ \(ask \d+\.\d s, gate \d+\.\d s, log \d+\.\d s, runtime (\d+\.\d) s, rest (\d+\.\d) s\)$/,
			);
			const [, runtime, rest] =
				line?.match(/runtime (\d+\.\d) s, rest (\d+\.\d) s/) ?? [];
			expect(
				Number(runtime),
				"the phase that waited is the one named",
			).toBeGreaterThanOrEqual(0.1);
			expect(
				Number(rest),
				"what followed the last mark",
			).toBeGreaterThanOrEqual(0.1);
		} finally {
			second.emit("SIGTERM");
			await run.stopped;
		}
	});

	// The background host on 18 November resumed 81 one at a time in 479 s.
	it("says each of the resumes that run together under its own step, with its own phases", async () => {
		await heldSome(3);
		const PHASE_MS = 60;
		const said: string[] = [];
		const second = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine: async (host) => ({
				...(await engine(host)),
				resume: async (_entry, _woken, mark) => {
					mark?.("log");
					// A real pause, so the two after the first overlap.
					await new Promise((done) => setTimeout(done, PHASE_MS));
				},
			}),
			signals: second,
			ready: async () => {},
			progress: async () => {},
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
			rollout: admitting,
		});
		try {
			const steps = said
				.map((line) => line.replace(/^\d+\.\d s: /, ""))
				.filter((line) => /^resum/.test(line))
				.map((line) => line.replace(/ in .*|: .*/, ""));
			expect(
				steps.slice(0, 4),
				"the second and third begin before either ends",
			).toEqual([
				"resuming 1 of 3",
				"resumed 1 of 3",
				"resuming 2 of 3",
				"resuming 3 of 3",
			]);
			expect(steps.slice(4).sort(), "then each ends, in either order").toEqual([
				"resumed 2 of 3",
				"resumed 3 of 3",
			]);
			for (const number of [2, 3])
				expect(
					said.find((line) => line.includes(`resumed ${number} of 3`)),
					"its phases alone",
				).toMatch(
					/ \(ask \d+\.\d s, gate \d+\.\d s, log \d+\.\d s, rest \d+\.\d s\)$/,
				);
		} finally {
			second.emit("SIGTERM");
			await run.stopped;
		}
	});

	it("says a resume that failed as one it could not resume, with why, and a parked one as left parked", async () => {
		const [, parked, failing, unsaid] = await heldSome(4);
		const said: string[] = [];
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine: async (host) => ({
				...(await engine(host)),
				restsParked: (entry) => entry.sessionId === parked,
				resume: async (entry) => {
					if (entry.sessionId === failing)
						throw new Error("\n  its log is gone\r\npid 12 still holds it");
					// A message that isn't text says nothing, rather than failing the start.
					if (entry.sessionId === unsaid)
						throw Object.assign(new Error("replaced below"), { message: 12 });
				},
			}),
			signals,
			ready: async () => {},
			progress: async () => {},
			say: (line) => said.push(line),
			report: () => {},
			places: places(),
			rollout: admitting,
		});
		try {
			const ends = said
				.map((line) => line.replace(/^\d+\.\d s: /, ""))
				.filter((line) => / \d of 4 in /.test(line))
				.map((line) => line.replace(/ in \d+\.\d s \([^)]*\)/, ""))
				.sort();
			expect(ends).toEqual([
				"could not resume 3 of 4: its log is gone",
				"could not resume 4 of 4",
				"left parked 2 of 4",
				"resumed 1 of 4",
			]);
		} finally {
			signals.emit("SIGTERM");
			await run.stopped;
		}
	});

	// The cases below end their resumes on what they see, or past GIVE_UP_MS
	// once it is clear they won't see it, so the checks say what broke; each
	// case's own time sits well past that, seeding included.
	const GIVE_UP_MS = 5_000;
	const CASE_MS = 20_000;

	it(
		"keeps asking for each of the resumes that run together until its own ends",
		async () => {
			// Each resume ends only once the test has seen what it checks, so a
			// stalled machine can't merge two ends: the short one once the long
			// one asks beside it, the long one once it has asked three times
			// since, and the tail, still running, once it has asked three times
			// since the long one ended. A shared renewal would stop the long
			// one's asks at the short one's end, or keep them past its own.
			const [, short = "", long = "", tail = ""] = await heldSome(4);
			const RENEW_MS = 10;
			const ending = new Map<string, () => void>();
			const ends = new Map(
				[short, long, tail].map((id) => [
					id,
					new Promise<void>((end) => ending.set(id, end)),
				]),
			);
			const asked: { status: string; at: number }[] = [];
			const ended: { line: string; at: number }[] = [];
			const endOf = (step: string) =>
				ended.find(({ line }) => line.includes(`resumed ${step}`))?.at ?? 0;
			const askedSince = (status: string, since: number) =>
				asked.filter((ask) => ask.status === status && ask.at > since).length;
			const longAsks = `resuming 3 of 4: ${long}`;
			const tailAsks = `resuming 4 of 4: ${tail}`;
			const endWhatIsSeen = () => {
				const shortEnd = endOf("2 of 4");
				const longEnd = endOf("3 of 4");
				if (askedSince(longAsks, 0) >= 1) ending.get(short)?.();
				if (shortEnd > 0 && askedSince(longAsks, shortEnd) >= 3)
					ending.get(long)?.();
				if (longEnd > 0 && askedSince(tailAsks, longEnd) >= 3)
					ending.get(tail)?.();
			};
			// Past this a renewal is broken: every resume ends, so the checks say how.
			const giveUp = setTimeout(() => {
				for (const end of ending.values()) end();
			}, GIVE_UP_MS);
			const signals = new EventEmitter();
			const run = await runHost({
				argv: ["background"],
				env: env(),
				engine: async (host) => ({
					...(await engine(host)),
					resume: async (entry) => {
						await ends.get(entry.sessionId);
					},
				}),
				signals,
				ready: async () => {},
				progress: async (_env, status) => {
					asked.push({ status, at: performance.now() });
					endWhatIsSeen();
				},
				stepRenewEvery: RENEW_MS,
				say: (line) => ended.push({ line, at: performance.now() }),
				report: () => {},
				places: places(),
				rollout: admitting,
			});
			clearTimeout(giveUp);
			try {
				const shortEnd = endOf("2 of 4");
				const longEnd = endOf("3 of 4");
				const tailEnd = endOf("4 of 4");
				expect(shortEnd, "the short one ended").toBeGreaterThan(0);
				expect(longEnd, "after the short one").toBeGreaterThan(shortEnd);
				expect(tailEnd, "the tail after the long one").toBeGreaterThan(longEnd);
				expect(
					askedSince(`resuming 2 of 4: ${short}`, shortEnd),
					"the short one asks no more once it ends",
				).toBe(0);
				expect(
					askedSince(longAsks, shortEnd),
					"the long one goes on asking beside it",
				).toBeGreaterThanOrEqual(3);
				expect(
					askedSince(longAsks, longEnd),
					"nor the long one once it ends, while the tail still runs",
				).toBe(0);
				expect(
					askedSince(tailAsks, longEnd),
					"the tail goes on asking",
				).toBeGreaterThanOrEqual(3);
			} finally {
				signals.emit("SIGTERM");
				await run.stopped;
			}
		},
		CASE_MS,
	);

	it(
		"names a resume that runs past its ceiling as it stops asking",
		async () => {
			const sessionId = await heldOne();
			const RENEW_MS = 10;
			let passed: () => void = () => {};
			const ceilingSaid = new Promise<void>((said) => {
				passed = said;
			});
			// Past this the ceiling was never said: the resume ends, so the check says so.
			const giveUp = setTimeout(() => passed(), GIVE_UP_MS);
			const said: string[] = [];
			const signals = new EventEmitter();
			const run = await runHost({
				argv: ["background"],
				env: env(),
				engine: async (host) => ({
					...(await engine(host)),
					resume: async () => {
						await ceilingSaid;
					},
				}),
				signals,
				ready: async () => {},
				progress: async () => {},
				stepRenewEvery: RENEW_MS,
				stepCeiling: 20 * RENEW_MS,
				say: (line) => {
					said.push(line);
					if (line.includes("asking no more")) passed();
				},
				report: () => {},
				places: places(),
				rollout: admitting,
			});
			clearTimeout(giveUp);
			try {
				const stillSaid = said
					.filter((line) => line.includes("asking no more"))
					.map((line) => line.replace(/^\d+\.\d s: /, ""));
				expect(stillSaid).toEqual([
					`still resuming 1 of 1: ${sessionId} after 0.2 s; asking no more, and the start waits on it`,
				]);
			} finally {
				signals.emit("SIGTERM");
				await run.stopped;
			}
		},
		CASE_MS,
	);

	// The background host on 13 November: resumes took 80 to 135 s each,
	// past the 120 s one ask gave, so the start outlived its time.
	it("keeps asking for time while a step runs long, up to its ceiling, and none once ready", async () => {
		const sessionId = await heldOne();
		const RENEW_MS = 10;
		const RESUME_MS = 300;
		for (const ceiling of [Number.POSITIVE_INFINITY, 4 * RENEW_MS]) {
			const asked: { status: string; at: number }[] = [];
			const signals = new EventEmitter();
			const run = await runHost({
				argv: ["background"],
				env: env(),
				engine: slowResume(RESUME_MS),
				signals,
				ready: async () => {},
				progress: async (_env, status) => {
					asked.push({ status, at: performance.now() });
				},
				stepRenewEvery: RENEW_MS,
				stepCeiling: ceiling,
				say: () => {},
				report: () => {},
				places: places(),
			});
			const readyAt = performance.now();
			// Five renewals' worth once ready, to show none comes after.
			await new Promise((resolve) => setTimeout(resolve, 5 * RENEW_MS));
			signals.emit("SIGTERM");
			await run.stopped;
			const resuming = asked.filter(
				({ status }) => status === `resuming 1 of 1: ${sessionId}`,
			);
			const first = resuming[0]?.at ?? 0;
			if (ceiling === Number.POSITIVE_INFINITY)
				expect(
					resuming.length,
					"the long resume asked again as it went",
				).toBeGreaterThanOrEqual(3);
			else
				expect(
					resuming.every(({ at }) => at - first < ceiling + RENEW_MS),
					"no ask past the step's ceiling",
				).toBe(true);
			expect(
				asked.filter(({ at }) => at > readyAt),
				"no ask once ready",
			).toEqual([]);
		}
	});

	it("starts anyway when it can't ask for more time, and reports why", async () => {
		const report = vi.fn();
		const refused = new Error("no notify socket");
		const ready = vi.fn(async () => {});
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals,
			ready,
			progress: async () => {
				throw refused;
			},
			say: () => {},
			report,
			places: places(),
		});
		expect(report).toHaveBeenCalledWith(refused);
		expect(ready).toHaveBeenCalledTimes(1);
		signals.emit("SIGTERM");
		await run.stopped;
	});

	it("keeps serving when readiness can't be said, and reports why", async () => {
		const report = vi.fn();
		const failed = new Error("systemd-notify failed");
		const signals = new EventEmitter();
		const run = await runHost({
			argv: ["background"],
			env: env(),
			engine,
			signals,
			ready: async () => {
				throw failed;
			},
			say: () => {},
			report,
			places: places(),
		});
		expect(report).toHaveBeenCalledWith(failed);
		signals.emit("SIGINT");
		await run.stopped;
	});

	it("tells systemd from its own unit, never from the jobs cgroup a conversation's spawns go to", async () => {
		// systemd credits a notify to the unit whose cgroup its sender is in,
		// and a hosted conversation's priority-workflow writes every child the
		// process spawns into jobs.service: on 11 November the background
		// host's ready went to jobs.service, and systemd stopped the host at
		// its start timeout.
		const bin = join(dir, "bin");
		const told = join(dir, "told");
		await mkdir(bin, { recursive: true });
		const notify = join(bin, "systemd-notify");
		await writeFile(notify, `#!/bin/sh\necho "$$ $*" >> '${told}'\n`);
		await chmod(notify, 0o755);
		const placed: number[] = [];
		const undo = placeChildren("/jobs", (_path, pid) => {
			placed.push(pid);
		});
		const signals = new EventEmitter();
		try {
			const run = await runHost({
				argv: ["background"],
				env: {
					...env(),
					NOTIFY_SOCKET: join(dir, "notify"),
					PATH: `${bin}:${process.env.PATH ?? ""}`,
				},
				engine,
				signals,
				// Not the test runner's own unit, whatever it runs in.
				unit: null,
				say: () => {},
				report: (error) => {
					throw error;
				},
				places: places(),
			});
			signals.emit("SIGTERM");
			await run.stopped;
		} finally {
			undo();
		}

		const notifies = (await readFile(told, "utf8"))
			.trim()
			.split("\n")
			.map((line) => line.split(" "));
		expect(
			notifies.map((words) => words.slice(1).join(" ")),
			"what the host told systemd",
		).toEqual([
			expect.stringContaining("STATUS=building the engine"),
			"--ready STATUS=ready: loaded 0, parked 0, dropped 0",
			"STATUS=stopping, parking no conversations",
		]);
		const senders = notifies.map((words) => Number(words.at(0)));
		expect(
			placed.filter((pid) => senders.includes(pid)),
			"notifies written into jobs",
		).toEqual([]);
	});

	it("pings systemd's watchdog from its own unit too", async () => {
		const bin = join(dir, "bin");
		const told = join(dir, "told");
		await mkdir(bin, { recursive: true });
		const notify = join(bin, "systemd-notify");
		await writeFile(notify, `#!/bin/sh\necho "$$ $*" >> '${told}'\n`);
		await chmod(notify, 0o755);
		const placed: number[] = [];
		const undo = placeChildren("/jobs", (_path, pid) => {
			placed.push(pid);
		});
		const said = async () => readFile(told, "utf8").catch(() => "");
		const signals = new EventEmitter();
		try {
			const run = await runHost({
				argv: ["background"],
				env: {
					...env(),
					...WATCHED,
					NOTIFY_SOCKET: join(dir, "notify"),
					PATH: `${bin}:${process.env.PATH ?? ""}`,
				},
				engine,
				signals,
				// Not the test runner's own unit, whatever it runs in.
				unit: null,
				say: () => {},
				report: (error) => {
					throw error;
				},
				places: places(),
			});
			try {
				await vi.waitFor(
					async () => {
						expect(await said(), "a watchdog ping").toContain("WATCHDOG=1");
					},
					{ timeout: 2 * TIMEOUT_MS },
				);
			} finally {
				signals.emit("SIGTERM");
				await run.stopped;
			}
		} finally {
			undo();
		}

		const pings = (await said())
			.trim()
			.split("\n")
			.map((line) => line.split(" "))
			.filter((words) => words.at(1) === "WATCHDOG=1");
		const senders = pings.map((words) => Number(words.at(0)));
		expect(senders.length, "pings heard").toBeGreaterThan(0);
		expect(
			placed.filter((pid) => senders.includes(pid)),
			"pings written into jobs",
		).toEqual([]);
	});

	describe("a ready systemd didn't take", () => {
		// At 02:09:51 on 19 November the background host said ready, its
		// systemd-notify landed in jobs.service, which systemd refused, and
		// the unit sat activating until its start timeout killed the host.
		// Whatever moves the notifier, the host reads the unit's state after
		// a ready and says it again until systemd has it.
		const UNIT = "pi-host-work-background.service";

		/** The unit's state for each look: activating `missed` times, then `then`. */
		const missedThen = (missed: number, then = "active") => [
			...new Array<string>(missed).fill("activating"),
			then,
		];

		/**
		 * A systemd-notify that records what it's told, hanging for `hangs`
		 * seconds when given on the first telling that opens with `on` (the
		 * ready by default), and a systemctl whose unit reads each of
		 * `states` in turn, the last one ever after, or that fails each look
		 * when `states` is "fails".
		 */
		const fakeSystemd = async (
			states: readonly string[] | "fails",
			hangs?: number,
			on = "--ready",
		) => {
			const bin = join(dir, "bin");
			const told = join(dir, "told");
			const looked = join(dir, "looked");
			const plays = join(dir, "states");
			await mkdir(bin, { recursive: true });
			const hang =
				hangs === undefined
					? ""
					: `case "$*" in ${on}*) [ "$(grep -c '^${on}' '${told}')" -eq 1 ] && exec sleep ${hangs};; esac\ntrue\n`;
			await writeFile(
				join(bin, "systemd-notify"),
				`#!/bin/sh\necho "$*" >> '${told}'\n${hang}`,
				{ mode: 0o755 },
			);
			if (states !== "fails") await writeFile(plays, `${states.join("\n")}\n`);
			const answer =
				states === "fails"
					? "echo 'Failed to connect to bus' >&2; exit 1"
					: `n=$(wc -l < '${looked}'); s=$(sed -n "\${n}p" '${plays}'); [ -n "$s" ] || s=$(tail -n 1 '${plays}'); echo "$s"`;
			await writeFile(
				join(bin, "systemctl"),
				`#!/bin/sh\necho "$*" >> '${looked}'\n${answer}\n`,
				{ mode: 0o755 },
			);
			const lines = async (file: string) =>
				(await readFile(file, "utf8").catch(() => ""))
					.split("\n")
					.filter(Boolean);
			return {
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				readies: async () =>
					(await lines(told)).filter((line) => line.startsWith("--ready")),
				looks: () => lines(looked),
			};
		};

		const LOOK = `--user show --property=ActiveState --value -- ${UNIT}`;
		const READY = "--ready STATUS=ready: loaded 0, parked 0, dropped 0";
		// A ready told again asks for the start's time again, so ten tellings
		// that each hang can't outlast what the last step was given.
		const RETOLD = `${READY} EXTEND_TIMEOUT_USEC=${STEP_ALLOWANCE_MS * 1000}`;

		/** What the host journalled of its ready, without its start's lines. */
		const ofReady = (said: readonly string[]) =>
			said.filter((line) => /ready/.test(line) && !/^\d/.test(line));

		const start = async (
			PATH: string,
			said: string[],
			options: {
				unit?: string | null;
				heard?: (line: string, signals: EventEmitter) => void;
				toldWithin?: number;
				progress?: boolean;
			} = {},
		) => {
			const signals = new EventEmitter();
			const report = vi.fn();
			const run = await runHost({
				argv: ["background"],
				env: { ...env(), NOTIFY_SOCKET: join(dir, "notify"), PATH },
				engine,
				signals,
				unit: "unit" in options ? options.unit : UNIT,
				readyTaken: 50,
				...(options.toldWithin === undefined
					? {}
					: { toldWithin: options.toldWithin }),
				// The start's steps tell systemd only where a case asks.
				...(options.progress ? {} : { progress: async () => {} }),
				say: (line) => {
					said.push(line);
					options.heard?.(line, signals);
				},
				report,
				places: places(),
			});
			signals.emit("SIGTERM");
			await run.stopped;
			return report;
		};

		it("says it again until the unit reads active, and journals each miss", async () => {
			const systemd = await fakeSystemd(missedThen(2));
			const said: string[] = [];
			const report = await start(systemd.PATH, said);
			expect(await systemd.readies(), "readies told").toEqual([
				READY,
				RETOLD,
				RETOLD,
			]);
			expect(await systemd.looks(), "the unit's state read").toEqual(
				new Array(3).fill(LOOK),
			);
			expect(ofReady(said), "each miss said").toEqual([
				`systemd didn't take the host's ready: ${UNIT} still reads activating, so telling it again (2 of 10)`,
				`systemd didn't take the host's ready: ${UNIT} still reads activating, so telling it again (3 of 10)`,
				`systemd took the host's ready on its 3rd telling`,
			]);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it("says it once when systemd takes it the first time", async () => {
			const systemd = await fakeSystemd(missedThen(0));
			const said: string[] = [];
			const report = await start(systemd.PATH, said);
			expect(await systemd.readies(), "readies told").toEqual([READY]);
			expect(await systemd.looks(), "the unit's state read").toEqual([LOOK]);
			expect(ofReady(said), "nothing said of it").toEqual([]);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it.each(["reloading", "refreshing"])(
			"counts a unit %s as having taken it",
			async (state) => {
				const systemd = await fakeSystemd([state]);
				const said: string[] = [];
				await start(systemd.PATH, said);
				expect(await systemd.readies(), "readies told").toEqual([READY]);
				expect(ofReady(said), "nothing said of it").toEqual([]);
			},
		);

		it("stops telling when the unit reads nothing", async () => {
			const systemd = await fakeSystemd([""]);
			const said: string[] = [];
			const report = await start(systemd.PATH, said);
			expect(await systemd.readies(), "readies told").toEqual([READY]);
			expect(ofReady(said)).toEqual([
				`systemd didn't take the host's ready: ${UNIT} reads nothing, so the host stops telling it`,
			]);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it("reports at once when systemd-notify can't run", async () => {
			// Nothing on PATH: every telling would fail the same way.
			const none = join(dir, "none");
			await mkdir(none, { recursive: true });
			const said: string[] = [];
			const report = await start(none, said);
			expect(ofReady(said), "no telling again").toEqual([]);
			// The status and stop notices fail too; only the ready's is counted.
			const ofTheReady = report.mock.calls.filter(([error]) =>
				String(error?.message).includes("host is ready"),
			);
			expect(ofTheReady, "the ready reported once").toEqual([
				[
					expect.objectContaining({
						message: expect.stringMatching(
							/^telling systemd the host is ready couldn't run systemd-notify: /,
						),
					}),
				],
			]);
		});

		it.each(["failed", "inactive", "deactivating"])(
			"stops telling, without saying it took, when the unit reads %s",
			async (state) => {
				const systemd = await fakeSystemd(missedThen(1, state));
				const said: string[] = [];
				const report = await start(systemd.PATH, said);
				expect(await systemd.readies(), "readies told").toEqual([
					READY,
					RETOLD,
				]);
				expect(ofReady(said), "why it stopped").toEqual([
					`systemd didn't take the host's ready: ${UNIT} still reads activating, so telling it again (2 of 10)`,
					`systemd didn't take the host's ready: ${UNIT} reads ${state}, so the host stops telling it`,
				]);
				expect(report, "nothing failed").not.toHaveBeenCalled();
			},
		);

		it("gives up and reports when systemd never takes it", async () => {
			const systemd = await fakeSystemd(["activating"]);
			const said: string[] = [];
			const report = await start(systemd.PATH, said);
			expect(await systemd.readies(), "readies told").toEqual([
				READY,
				...new Array(9).fill(RETOLD),
			]);
			expect(await systemd.looks(), "the unit's state read").toEqual(
				new Array(10).fill(LOOK),
			);
			expect(ofReady(said), "each miss said, and no take").toEqual(
				Array.from(
					{ length: 9 },
					(_, i) =>
						`systemd didn't take the host's ready: ${UNIT} still reads activating, so telling it again (${i + 2} of 10)`,
				),
			);
			expect(report).toHaveBeenCalledTimes(1);
			expect(report).toHaveBeenCalledWith(
				expect.objectContaining({
					message: `systemd didn't take the host's ready in 10 tellings: ${UNIT} still reads activating`,
				}),
			);
		});

		it("stops telling once a stop arrives mid-telling", async () => {
			const systemd = await fakeSystemd(["activating"]);
			const said: string[] = [];
			const report = await start(systemd.PATH, said, {
				heard: (line, signals) => {
					if (line.includes("telling it again (2 of 10)"))
						signals.emit("SIGTERM");
				},
			});
			expect(
				(await systemd.readies()).length,
				"no telling past the stop's",
			).toBeLessThanOrEqual(2);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it("says it once, unconfirmed, when told there is no unit", async () => {
			const systemd = await fakeSystemd(["activating"]);
			const said: string[] = [];
			const report = await start(systemd.PATH, said, { unit: null });
			expect(await systemd.readies(), "readies told").toEqual([READY]);
			expect(await systemd.looks(), "the unit's state read").toEqual([]);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it("reports a telling that hangs when there is no unit", async () => {
			const systemd = await fakeSystemd(["activating"], 30);
			const report = await start(systemd.PATH, [], {
				unit: null,
				toldWithin: 500,
			});
			expect(await systemd.readies(), "readies told").toEqual([READY]);
			expect(report).toHaveBeenCalledWith(
				expect.objectContaining({
					message:
						"telling systemd the host is ready: systemd-notify hung, and the host killed it 500 ms on",
				}),
			);
		});

		it("goes on past a step's telling that hangs", async () => {
			const systemd = await fakeSystemd(
				missedThen(0),
				30,
				"EXTEND_TIMEOUT_USEC",
			);
			const report = await start(systemd.PATH, [], {
				toldWithin: 500,
				progress: true,
			});
			expect(await systemd.readies(), "the ready still told").toEqual([READY]);
			expect(report).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "systemd-notify hung, and the host killed it 500 ms on",
				}),
			);
		});

		it("counts a telling that hangs as a miss and tells again", async () => {
			const systemd = await fakeSystemd(missedThen(1), 30);
			const said: string[] = [];
			const report = await start(systemd.PATH, said, { toldWithin: 500 });
			expect(await systemd.readies(), "readies told").toEqual([READY, RETOLD]);
			expect(ofReady(said)).toEqual([
				"telling systemd the host is ready: systemd-notify hung, and the host killed it 500 ms on",
				`systemd didn't take the host's ready: ${UNIT} still reads activating, so telling it again (2 of 10)`,
				"systemd took the host's ready on its 2nd telling",
			]);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it("names the last failed telling when it gives up", async () => {
			const systemd = await fakeSystemd(["activating"]);
			// A notifier refused each time, as by a socket systemd won't hear.
			await writeFile(
				join(dir, "bin", "systemd-notify"),
				"#!/bin/sh\necho 'No such file or directory' >&2\nexit 1\n",
				{ mode: 0o755 },
			);
			const report = await start(systemd.PATH, []);
			expect(report).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringMatching(
						/^systemd didn't take the host's ready in 10 tellings: \S+ still reads activating; the last telling: systemd-notify ended with 1: No such file or directory$/,
					),
				}),
			);
		});

		it("trusts a ready whose unit it can't read, as before", async () => {
			const systemd = await fakeSystemd("fails");
			const said: string[] = [];
			const report = await start(systemd.PATH, said);
			expect(await systemd.readies(), "readies told").toHaveLength(1);
			expect(await systemd.looks(), "one look: trusted at once").toEqual([
				LOOK,
			]);
			expect(said, "why it couldn't check").toContain(
				`couldn't read whether systemd took the host's ready, so trusting it: systemctl ended with 1: Failed to connect to bus`,
			);
			expect(report, "nothing failed").not.toHaveBeenCalled();
		});

		it("trusts no failed telling whose unit it can't read", async () => {
			const systemd = await fakeSystemd("fails");
			await writeFile(
				join(dir, "bin", "systemd-notify"),
				"#!/bin/sh\necho 'No such file or directory' >&2\nexit 1\n",
				{ mode: 0o755 },
			);
			const said: string[] = [];
			const report = await start(systemd.PATH, said);
			expect(said.join("\n"), "nothing trusted").not.toMatch(/trusting/);
			expect(report).toHaveBeenCalledWith(
				expect.objectContaining({
					message:
						"telling systemd the host is ready failed, and its unit can't be read: systemd-notify ended with 1: No such file or directory; systemctl ended with 1: Failed to connect to bus",
				}),
			);
		});
	});
});
