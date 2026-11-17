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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import type { ConversationEngine } from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import type { BeatOptions } from "../../../host/service/hold-watch.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import {
	hostKind,
	runHost,
	watchdogEvery,
} from "../../../host/service/run.ts";
import { stopWithin } from "../../../host/service/stop.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";
import { placeChildren } from "../../../lib/internal/priority/place.ts";

// The net is process-wide; serve.test.ts checks a host sets it.
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: () => {},
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
	});
	const reply = await controlRequest(seeded.serving.path, {
		v: 1,
		id: "o",
		op: "open",
		cwd: dir,
		attended: false,
	});
	if (!reply.ok) throw new Error(reply.error.message);
	signals.emit("SIGTERM");
	await seeded.stopped;
	return parseOpenResult(reply.result).sessionId;
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

describe("watchdogEvery", () => {
	it("pings four times in each watchdog timeout, when systemd watches this process", () => {
		expect(watchdogEvery({ WATCHDOG_USEC: "120000000" }, 7)).toBe(30_000);
		expect(
			watchdogEvery({ WATCHDOG_USEC: "120000000", WATCHDOG_PID: "7" }, 7),
		).toBe(30_000);
	});

	it("doesn't ping without a watchdog, or for another process's", () => {
		for (const env of [
			{},
			{ WATCHDOG_USEC: "" },
			{ WATCHDOG_USEC: "0" },
			{ WATCHDOG_USEC: "soon" },
			{ WATCHDOG_USEC: "120000000", WATCHDOG_PID: "8" },
		])
			expect(watchdogEvery(env, 7), JSON.stringify(env)).toBeUndefined();
	});
});

// At 03:30 on 17 November a restart's park of 13 conversations was still
// under way when its 45 s ran out late on a busy loop, and systemd's 60 s
// stop killed it. The unit's stop limit is the one to fit inside, so the
// unit says it and the host parks within three quarters of it.
describe("stopWithin", () => {
	it("parks within three quarters of the stop limit its unit names", () => {
		expect(stopWithin({ PI_HOST_STOP_USEC: "150000000" })).toBe(112_500);
		expect(stopWithin({ PI_HOST_STOP_USEC: "60000000" })).toBe(45_000);
	});

	it("parks within 45 s when its unit names no stop limit it can read", () => {
		for (const env of [
			{},
			{ PI_HOST_STOP_USEC: "" },
			{ PI_HOST_STOP_USEC: "0" },
			{ PI_HOST_STOP_USEC: "soon" },
			{ PI_HOST_STOP_USEC: "-5" },
		])
			expect(stopWithin(env), JSON.stringify(env)).toBe(45_000);
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
			return { running, stopped: watches, beats };
		};
		const socket = { ...WATCHED, NOTIFY_SOCKET: "/run/systemd/notify" };
		const watched = await serve(socket);
		expect(
			watched.beats.map((beat) => beat?.every),
			"beats for a loop in the disk as often as the loop beats",
		).toEqual([TIMEOUT_MS / 4]);
		expect(
			watched.beats[0]?.env.NOTIFY_SOCKET,
			"in the environment naming systemd's socket",
		).toBe(socket.NOTIFY_SOCKET);
		expect(
			(await serve(WATCHED)).beats,
			"watched, but unbeaten, where systemd names no socket",
		).toEqual([undefined]);
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

		signals.emit("SIGTERM");
		await run.stopped;
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
			expect.stringContaining(
				`stopping after 200 ms, 1 not parked: ${sessionId}`,
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
			expect.stringContaining(
				`stopping after 300 ms, 1 not parked: ${sessionId}`,
			),
		]);
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
});
