/**
 * A host as its own process, run as systemd runs it: `runHost` with the
 * kind on its command line and only the seal's environment, so its
 * roster, registry, state and socket all land under the seal. The engine
 * is a module the process imports by path, exporting `engine`: the fake
 * one now, H1's createEngine once it lands.
 *
 * The host is given an open rollout gate, since it runs from a tree and
 * has no install to read one from; the gate has tests of its own. One
 * asked to admit a single conversation is given a gate that refuses
 * every other, as a gate over stale harnesses does, for a case that
 * needs a host to refuse an adopt (E22).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { HostKind } from "../../../../host/service/address.ts";
import { controlRequest } from "../../../../host/service/client.ts";
import {
	type ControlRequest,
	parseListResult,
	parseOpenResult,
	parseSessionResult,
	type SessionIdentity,
} from "../../../../host/service/protocol.ts";
import { gone } from "../../../support/processes.ts";
import type { Seal } from "./seal.ts";

const RUN = resolve(import.meta.dirname, "../../../../host/service/run.ts");
const DISPATCH = resolve(
	import.meta.dirname,
	"../../../../host/service/dispatch.ts",
);

/** How long a host may take to go once told to. */
const HOST_WAIT_MS = 20_000;

/**
 * How long a host may take to listen: a real engine loads pi first, and a
 * restarted host resumes every conversation it held before it listens.
 */
const LISTEN_WAIT_MS = 120_000;

/**
 * How long an open may take to answer: a real engine loads pi and every
 * extension of the harness for the conversation before it commits.
 */
const OPEN_WAIT_MS = 120_000;

/** A running host process and the control requests a test makes of it. */
export interface HostProcess {
	readonly pid: number;
	/** Its control socket. */
	readonly path: string;
	/** Open a conversation in `cwd`, on a model and with first words when given. */
	open(cwd: string, opening?: Opening): Promise<SessionIdentity>;
	/** The conversations it holds, as list reports them. */
	list(): Promise<SessionIdentity[]>;
	/** Close one conversation, ending it. */
	close(sessionId: string): Promise<void>;
	/** Kill it outright, as a crash would, and wait for it to go. */
	kill(): Promise<void>;
	/** Send it systemd's stop and answer its exit code. */
	stop(): Promise<number | null>;
	/** What it wrote to standard error so far. */
	errors(): string;
}

/** What an open may carry beyond its folder. */
export interface Opening {
	readonly model?: { readonly provider: string; readonly id: string };
	readonly first?: string;
	/** The quest it opens on, by id. */
	readonly quest?: string;
}

/**
 * Start a host process under `seal`, running the engine module given,
 * with `env` laid over the seal's: what the engine is told of, never the
 * person's own.
 */
export async function startHost(options: {
	seal: Seal;
	engine: string;
	kind?: HostKind;
	env?: Readonly<Record<string, string>>;
	/** Refuse every conversation but the first it holds. */
	admitsOne?: boolean;
}): Promise<HostProcess> {
	const rollout = options.admitsOne
		? `() => Promise.reject(hostRefusal("rollout_refused", "this host admits one conversation"))`
		: "() => Promise.resolve()";
	const source = `
const { runHost } = await import(${JSON.stringify(RUN)});
const { hostRefusal } = await import(${JSON.stringify(DISPATCH)});
const { engine } = await import(${JSON.stringify(options.engine)});
const run = await runHost({
	argv: [${JSON.stringify(options.kind ?? "attended")}],
	env: process.env,
	engine,
	ready: async () => {},
	places: { rollout: ${rollout} },
});
process.stdout.write(JSON.stringify({ path: run.serving.path }) + "\\n");
await run.stopped;
process.exit(0);`;
	const child = spawn(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", source],
		{
			env: { ...options.seal.env, ...options.env },
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
	const pid = child.pid;
	if (pid === undefined) throw new Error("the host never got a pid");
	const ask = async (request: ControlRequest, timeoutMs?: number) => {
		const reply = await controlRequest(path, request, timeoutMs);
		if (!reply.ok) throw new Error(reply.error.message);
		return reply.result;
	};
	let asked = 0;
	const id = () => `e${++asked}`;
	return {
		pid,
		path,
		open: async (cwd, opening = {}) =>
			parseOpenResult(
				await ask(
					{
						v: 1,
						id: id(),
						op: "open",
						cwd,
						attended: true,
						...opening,
					},
					OPEN_WAIT_MS,
				),
			),
		list: async () =>
			parseListResult(await ask({ v: 1, id: id(), op: "list" })).sessions,
		close: async (sessionId) => {
			// An ending names the host it means, as discovered by list, so it
			// can't end a conversation on a host that has since replaced it.
			const expectedHost = parseListResult(
				await ask({ v: 1, id: id(), op: "list" }),
			).host;
			parseSessionResult(
				await ask({ v: 1, id: id(), op: "close", sessionId, expectedHost }),
			);
		},
		kill: async () => {
			child.kill("SIGKILL");
			await gone(pid, HOST_WAIT_MS);
		},
		stop: () => {
			child.kill("SIGTERM");
			return exited;
		},
		errors: () => errors,
	};
}

/** The socket path the host prints once it listens, or why it never did. */
function listening(
	child: ChildProcess,
	exited: Promise<number | null>,
	errors: () => string,
): Promise<string> {
	return new Promise((done, fail) => {
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(
				new Error(
					`the host didn't listen in ${LISTEN_WAIT_MS} ms: ${errors()}`,
				),
			);
		}, LISTEN_WAIT_MS);
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
