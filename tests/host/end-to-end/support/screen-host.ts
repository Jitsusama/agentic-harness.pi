/**
 * A host with pi's own screens as its own process under a seal:
 * fixtures/screen-host.mts on a pi built with the host's patches, and the
 * control requests a test makes of it. Offline, so pi neither checks for
 * updates nor fetches its tools.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { controlRequest } from "../../../../host/service/client.ts";
import {
	type ControlRequest,
	parseListResult,
	parseOpenResult,
	type SessionIdentity,
} from "../../../../host/service/protocol.ts";
import { isRecord } from "../../../../lib/internal/record.ts";
import { until } from "../../../support/until.ts";
import type { Seal } from "./seal.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/screen-host.mts");

/** How long the host may take to load pi and listen. */
const LISTEN_MS = 60_000;
/** How often a wait asks the host how a conversation stands. */
const ASK_EVERY_MS = 50;
/** How long the host may take to collect its garbage and weigh itself. */
const WEIGH_MS = 10_000;
/**
 * How long an open may take: it loads every extension for the new
 * conversation, past the client's own 30 s on a loaded lender.
 */
const OPEN_MS = 120_000;

/** What the host weighs, as it says once it has collected its garbage. */
export interface Weight {
	/** Its resident set size, in kB. */
	readonly rss: number;
	/** Its proportional set size, in kB. */
	readonly pss: number;
	/** Its proportional share of swap, in kB. */
	readonly swapPss: number;
	/**
	 * The heap V8 still uses once its garbage is collected, in kB: what a
	 * conversation let go lowers, where PSS keeps any page V8 hasn't yet
	 * given back to the kernel.
	 */
	readonly heapKb: number;
	/**
	 * The heap V8 holds from the kernel, in kB: above heapKb by what it
	 * freed and keeps pooled until a memory-reducing collection.
	 */
	readonly heapTotalKb: number;
	/** What V8 keeps outside its heap for JavaScript objects, in kB. */
	readonly externalKb: number;
	/** The array buffers within externalKb, in kB. */
	readonly arrayBuffersKb: number;
	/** Its loop's 99th-percentile lateness since the last weighing, in ms. */
	readonly loopP99Ms: number;
	/** The most its loop ran late since the last weighing, in ms. */
	readonly loopMaxMs: number;
	/** The share of the time since the last weighing its loop was busy. */
	readonly loopBusy: number;
	/** The conversations whose sessions are still in its memory. */
	readonly sessions: readonly string[];
	/** Spike (worker per awake engine): how many workers run. */
	readonly workerCount?: number;
	/** Spike: the worst worker loop's 99th-percentile lateness, in ms. */
	readonly workerLoopP99MaxMs?: number;
	/** Spike: the most any worker loop ran late, in ms. */
	readonly workerLoopMaxMs?: number;
	/** Spike: each worker's own weighing, as it wrote it. */
	readonly workers?: readonly unknown[];
}

/** A running screen host and the control requests a test makes of it. */
export interface ScreenHost {
	/** Its control socket, which viewers attach through. */
	readonly path: string;
	/** Open a conversation in `cwd`, with first words when given. */
	open(cwd: string, first?: string): Promise<SessionIdentity>;
	/** The conversations it holds. */
	list(): Promise<SessionIdentity[]>;
	/** Close a conversation, as the launcher's Close does, naming itself as `by` when given. */
	close(sessionId: string, by?: string): Promise<void>;
	/** Release a conversation back to plain pi, as a cutover does, naming itself as `by` when given. */
	release(sessionId: string, by?: string): Promise<void>;
	/** Wait until the conversation is idle, or until `ms` pass. */
	idle(sessionId: string, ms: number): Promise<void>;
	/** Wait until it no longer holds the conversation, or until `ms` pass. */
	gone(sessionId: string, ms: number): Promise<void>;
	/** Wait until the conversation is held parked, or until `ms` pass. */
	parked(sessionId: string, ms: number): Promise<void>;
	/** Have it collect its garbage and say what it weighs. */
	weigh(): Promise<Weight>;
	/** Send it systemd's stop and wait for it to go. */
	stop(): Promise<number | null>;
	/**
	 * Stop it as systemd restarts it, telling each viewer a restart is
	 * coming, and wait for it to go. Start the next host on the same seal.
	 */
	restart(): Promise<number | null>;
	/** What it wrote to standard error so far. */
	errors(): string;
}

/**
 * Start a screen host under `seal` on the pi at `packageDir`, its
 * conversations loading the harness's extensions `also` names, by folder,
 * beside the fixture's own, and its agent folder adding what the JSON
 * file `agent` names, as the fixture's SCREEN_HOST_AGENT says.
 */
export async function startScreenHost(
	seal: Seal,
	packageDir: string,
	also: readonly string[] = [],
	agent?: string,
): Promise<ScreenHost> {
	const child = spawn(
		process.execPath,
		// Exposed so it can collect its garbage before it weighs itself.
		["--no-warnings", "--expose-gc", FIXTURE, packageDir],
		{
			env: {
				...seal.env,
				PI_OFFLINE: "1",
				...(process.env.PI_HOST_WORKERS
					? { PI_HOST_WORKERS: process.env.PI_HOST_WORKERS }
					: {}),
				...(also.length > 0 ? { SCREEN_HOST_ALSO: also.join(",") } : {}),
				...(agent === undefined ? {} : { SCREEN_HOST_AGENT: agent }),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let errors = "";
	child.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const exited = new Promise<number | null>((done) =>
		child.once("exit", (code) => done(code)),
	);
	const path = await listening(child, exited, () => errors);
	let asked = 0;
	const ask = async (request: ControlRequest, ms?: number) => {
		const reply = await controlRequest(path, request, ms);
		if (!reply.ok) throw new Error(reply.error.message);
		return reply.result;
	};
	const id = () => `s${++asked}`;
	const list = async () =>
		parseListResult(await ask({ v: 1, id: id(), op: "list" })).sessions;
	const end = async (
		op: "close" | "release",
		sessionId: string,
		by: string | undefined,
	) => {
		// A request that ends a conversation names the host it was listed by.
		const { host } = parseListResult(await ask({ v: 1, id: id(), op: "list" }));
		await ask({
			v: 1,
			id: id(),
			op,
			sessionId,
			expectedHost: host,
			...(by === undefined ? {} : { by }),
		});
	};
	const settles = async (
		sessionId: string,
		ms: number,
		wanted: string,
		settled: (held: SessionIdentity | undefined) => boolean,
	) => {
		const until = Date.now() + ms;
		for (;;) {
			const held = (await list()).find((s) => s.sessionId === sessionId);
			if (settled(held)) return;
			if (Date.now() > until)
				throw new Error(
					`${sessionId} is ${held?.state ?? "gone"}, not ${wanted}, after ${ms} ms: ${errors}`,
				);
			// The host says how a conversation stands only when asked, so this
			// waits between asks rather than flooding its socket.
			await new Promise((done) => setTimeout(done, ASK_EVERY_MS));
		}
	};
	return {
		path,
		open: async (cwd, first) =>
			parseOpenResult(
				await ask(
					{
						v: 1,
						id: id(),
						op: "open",
						cwd,
						attended: true,
						...(first === undefined ? {} : { first }),
					},
					OPEN_MS,
				),
			),
		list,
		close: (sessionId, by) => end("close", sessionId, by),
		release: (sessionId, by) => end("release", sessionId, by),
		idle: (sessionId, ms) =>
			settles(sessionId, ms, "idle", (held) => held?.state === "idle"),
		gone: (sessionId, ms) =>
			settles(sessionId, ms, "gone", (held) => held === undefined),
		parked: (sessionId, ms) =>
			settles(sessionId, ms, "parked", (held) => held?.state === "parked"),
		weigh: async () => {
			const weighed = join(seal.home, "weighed.json");
			rmSync(weighed, { force: true });
			child.kill("SIGHUP");
			await until(
				"the host to weigh itself",
				() => existsSync(weighed),
				WEIGH_MS,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}; the host said: ${errors}`);
			});
			return weight(JSON.parse(readFileSync(weighed, "utf8")));
		},
		stop: () => {
			child.kill("SIGTERM");
			return exited;
		},
		restart: () => {
			child.kill("SIGUSR2");
			return exited;
		},
		errors: () => errors,
	};
}

/** A weighing as the host wrote it, or why it isn't one. */
function weight(said: unknown): Weight {
	if (
		!isRecord(said) ||
		typeof said.rss !== "number" ||
		typeof said.pss !== "number" ||
		typeof said.swapPss !== "number" ||
		typeof said.heapKb !== "number" ||
		typeof said.heapTotalKb !== "number" ||
		typeof said.externalKb !== "number" ||
		typeof said.arrayBuffersKb !== "number" ||
		typeof said.loopP99Ms !== "number" ||
		typeof said.loopMaxMs !== "number" ||
		typeof said.loopBusy !== "number" ||
		!Array.isArray(said.sessions)
	)
		throw new Error(`the host weighed itself as ${JSON.stringify(said)}`);
	const sessions = said.sessions.filter(
		(id): id is string => typeof id === "string",
	);
	return {
		rss: said.rss,
		pss: said.pss,
		swapPss: said.swapPss,
		heapKb: said.heapKb,
		heapTotalKb: said.heapTotalKb,
		externalKb: said.externalKb,
		arrayBuffersKb: said.arrayBuffersKb,
		loopP99Ms: said.loopP99Ms,
		loopMaxMs: said.loopMaxMs,
		loopBusy: said.loopBusy,
		sessions,
		...(typeof said.workerCount === "number"
			? { workerCount: said.workerCount }
			: {}),
		...(typeof said.workerLoopP99MaxMs === "number"
			? { workerLoopP99MaxMs: said.workerLoopP99MaxMs }
			: {}),
		...(typeof said.workerLoopMaxMs === "number"
			? { workerLoopMaxMs: said.workerLoopMaxMs }
			: {}),
		...(Array.isArray(said.workers) ? { workers: said.workers } : {}),
	};
}

/** The socket the host prints once it listens, or why it never did. */
function listening(
	child: ChildProcess,
	exited: Promise<number | null>,
	errors: () => string,
): Promise<string> {
	return new Promise((done, fail) => {
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(new Error(`the host didn't listen in ${LISTEN_MS} ms: ${errors()}`));
		}, LISTEN_MS);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
			const line = out.split("\n")[0];
			if (!out.includes("\n") || line === undefined) return;
			clearTimeout(timer);
			const said: unknown = JSON.parse(line);
			const path: unknown =
				typeof said === "object" && said !== null
					? Reflect.get(said, "path")
					: undefined;
			if (typeof path === "string") done(path);
			else fail(new Error(`the host said ${line}, naming no socket`));
		});
		exited.then((code) => {
			clearTimeout(timer);
			fail(new Error(`the host exited ${code} before listening: ${errors()}`));
		});
	});
}
