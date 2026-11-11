/**
 * A host with pi's own screens as its own process under a seal:
 * fixtures/screen-host.mts on a pi built with the host's patches, and the
 * control requests a test makes of it. Offline, so pi neither checks for
 * updates nor fetches its tools.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { controlRequest } from "../../../../host/service/client.ts";
import {
	type ControlRequest,
	parseListResult,
	parseOpenResult,
	type SessionIdentity,
} from "../../../../host/service/protocol.ts";
import type { Seal } from "./seal.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/screen-host.mts");

/** How long the host may take to load pi and listen. */
const LISTEN_MS = 60_000;
/** How often a wait asks the host how a conversation stands. */
const ASK_EVERY_MS = 50;

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
	/** Wait until the conversation is idle, or until `ms` pass. */
	idle(sessionId: string, ms: number): Promise<void>;
	/** Wait until it no longer holds the conversation, or until `ms` pass. */
	gone(sessionId: string, ms: number): Promise<void>;
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

/** Start a screen host under `seal` on the pi at `packageDir`. */
export async function startScreenHost(
	seal: Seal,
	packageDir: string,
): Promise<ScreenHost> {
	const child = spawn(
		process.execPath,
		["--no-warnings", FIXTURE, packageDir],
		{
			env: { ...seal.env, PI_OFFLINE: "1" },
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
	const ask = async (request: ControlRequest) => {
		const reply = await controlRequest(path, request);
		if (!reply.ok) throw new Error(reply.error.message);
		return reply.result;
	};
	const id = () => `s${++asked}`;
	const list = async () =>
		parseListResult(await ask({ v: 1, id: id(), op: "list" })).sessions;
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
				await ask({
					v: 1,
					id: id(),
					op: "open",
					cwd,
					attended: true,
					...(first === undefined ? {} : { first }),
				}),
			),
		list,
		close: async (sessionId, by) => {
			// A request that ends a conversation names the host it was listed by.
			const { host } = parseListResult(
				await ask({ v: 1, id: id(), op: "list" }),
			);
			await ask({
				v: 1,
				id: id(),
				op: "close",
				sessionId,
				expectedHost: host,
				...(by === undefined ? {} : { by }),
			});
		},
		idle: (sessionId, ms) =>
			settles(sessionId, ms, "idle", (held) => held?.state === "idle"),
		gone: (sessionId, ms) =>
			settles(sessionId, ms, "gone", (held) => held === undefined),
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
