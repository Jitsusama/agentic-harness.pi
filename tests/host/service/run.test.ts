/** A host process: kind from argv, realm from env, ready once listening, parked on a stop signal. */
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
import { parseOpenResult } from "../../../host/service/protocol.ts";
import {
	describeStep,
	hostKind,
	readyStatus,
	runHost,
	stoppingStatus,
	watchdogEvery,
} from "../../../host/service/run.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";
import { placeChildren } from "../../../lib/internal/priority/place.ts";

// The net is process-wide; serve.test.ts checks a host sets it.
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: () => {},
}));

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-run-"));
});
afterEach(async () => {
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

describe("describeStep", () => {
	it("names the engine, and which conversation of how many", () => {
		expect(describeStep({ step: "engine" })).toBe("building the engine");
		expect(
			describeStep({ step: "resume", number: 2, of: 5, sessionId: "s" }),
		).toBe("resuming 2 of 5: s");
	});
});

describe("readyStatus", () => {
	it("says how many conversations it serves, and any held but not resumed", () => {
		expect(readyStatus(0, 0)).toBe("ready, serving no conversations");
		expect(readyStatus(1, 0)).toBe("ready, serving 1 conversation");
		expect(readyStatus(3, 2)).toBe(
			"ready, serving 3 conversations, 2 held but not resumed",
		);
		expect(stoppingStatus(2)).toBe("stopping, parking 2 conversations");
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
					"ready, serving 1 conversation",
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
			"ready, serving no conversations",
			"ready, serving 1 conversation",
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
		expect(heard).toEqual([
			"building the engine",
			`resuming 1 of 1: ${sessionId}`,
			"ready",
		]);
		expect(said).toHaveLength(4);
		expect(said[0]).toMatch(/^\d+\.\d s: building the engine$/);
		expect(said[1]).toMatch(/^\d+\.\d s: resuming 1 of 1: /);
		expect(said[2]).toMatch(/^\d+\.\d s: resumed 1 of 1 in \d+\.\d s$/);
		// This engine's resume registers nothing, so the host serves none.
		expect(said[3]).toMatch(
			/^\d+\.\d s: ready, serving no conversations, listening on /,
		);
		second.emit("SIGTERM");
		await run.stopped;
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
			"--ready STATUS=ready, serving no conversations",
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
