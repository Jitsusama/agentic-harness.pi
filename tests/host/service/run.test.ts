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
		const reply = await controlRequest(run.serving.path, {
			v: 1,
			id: "o",
			op: "open",
			cwd: dir,
			attended: false,
		});
		if (!reply.ok) throw new Error(reply.error.message);
		await vi.waitFor(() => {
			expect(statuses.at(-1)).toBe("ready, serving 1 conversation");
		});

		signals.emit("SIGTERM");
		await run.stopped;
		const after = statuses.length;
		// Five checks' worth, to show none comes once the host has stopped.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(statuses, "said only as it changed").toEqual([
			"ready, serving no conversations",
			"ready, serving 1 conversation",
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
		expect(said[3]).toMatch(/^\d+\.\d s: ready, listening on /);
		second.emit("SIGTERM");
		await run.stopped;
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
		]);
		const senders = notifies.map((words) => Number(words.at(0)));
		expect(
			placed.filter((pid) => senders.includes(pid)),
			"notifies written into jobs",
		).toEqual([]);
	});
});
