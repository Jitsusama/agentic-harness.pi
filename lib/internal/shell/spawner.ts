/**
 * The agent's commands, started by pi-spawner rather than by pi.
 *
 * Starting a process forks the one that starts it, and pi grows past a
 * gigabyte in a long session: a spawn took 36 ms at the median from a
 * 1.1 GB node against 4 ms from a 58 MB one (10 November 2026), on the
 * thread that reads the person's keys. pi-spawner (core.nix's
 * modules/pi/spawner) is a small program started once for each pi; it
 * starts each command and sends back what the command says, so pi only
 * writes a request and reads frames.
 *
 * A command behaves as pi's own would. It runs in a process group of its
 * own, which a stop or a time limit kills whole. It is done once both its
 * streams end after it exits, or 100 ms after its last output past its
 * exit. An end by a signal counts as 128 and the signal's number. Where
 * pi-spawner is turned off (PI_SPAWNER=off), isn't in the system's profile
 * or has stopped, pi's own spawn starts the command, as before.
 *
 * One pi-spawner serves one load of the extension. When the load ends, at
 * a reload or a new session, its spawner is retired: it takes no more
 * commands and is closed once the last it runs ends, so a background job
 * running across a reload isn't killed. A load from before retiring was
 * possible left its spawner running, idle, for good: on 11 November one pi
 * had two after one reload. So before a load starts its own, it stops each
 * pi-spawner its pi started that runs nothing.
 */

import { spawn } from "node:child_process";
import { constants, readdirSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import {
	type BashOperations,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { systemProgram } from "../system-program.ts";
import { spawnerWanted } from "./spawner-variable.ts";

/** The program's name, as core.nix puts it on the PATH. */
export const SPAWNER_PROGRAM = "pi-spawner";

/** How long pi waits for output past a command's exit, as pi does. */
const EXIT_STDIO_GRACE_MS = 100;

/** The longest time limit pi takes, which is setTimeout's. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The frames pi-spawner sends, by their first byte. */
const STARTED = "p".charCodeAt(0);
const OUTPUT = "o".charCodeAt(0);
const CLOSED = "c".charCodeAt(0);
const EXITED = "x".charCodeAt(0);
const FAILED = "e".charCodeAt(0);

/** A frame's kind, id and length, ahead of its payload. */
const HEAD_BYTES = 9;

/** The streams a command writes to: its output and its errors. */
const STREAMS = 2;

/** The shell a command runs in, as pi resolves it. */
export interface Shell {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/** A running pi-spawner, as the client talks to it. */
export interface Started {
	input: Writable;
	output: Readable;
	/** Call back once, when the program has stopped or failed to start. */
	ended(listener: () => void): void;
}

/** What a test stands in for; each defaults to the real thing. */
export interface SpawnerOptions {
	env?: NodeJS.ProcessEnv;
	shellPath?: string;
	shell?: Shell;
	/**
	 * Where the program is, found in the system's own profile when left
	 * out, never on the PATH (system-program.ts).
	 */
	program?: string;
	/** How the program is found, when `program` doesn't say. */
	find?: (program: string) => string | undefined;
	start?: (program: string) => Started;
	/** Kill a command's process group, as pi's stop does. */
	kill?: (pid: number) => void;
	/**
	 * Stop what earlier loads left, as this one is made and before it
	 * starts its own; by default each idle pi-spawner this pi started
	 * (stopIdleSpawners). It runs whether or not pi-spawner is asked for:
	 * a pi that ran it under an earlier load and runs without it now
	 * would otherwise keep that one idle until it ends, as eight did on
	 * 11 November.
	 */
	reap?: () => void;
}

/** pi's bash operations, and a way to retire the spawner behind them. */
export interface SpawnerOperations extends BashOperations {
	/**
	 * Take no more commands through pi-spawner, and close it once the
	 * commands it runs have ended. Later commands start as pi's own.
	 */
	retire(): void;
}

/** How a command ended, as pi-spawner reports it. */
interface Ended {
	code: number;
	signal: number;
}

/** One command pi-spawner runs, from request to end. */
interface Run {
	started: Promise<number>;
	done: Promise<Ended>;
}

/** A link to one running pi-spawner. */
interface Link {
	run(
		program: string,
		args: readonly string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		onData: (data: Buffer) => void,
	): Run;
	/** Close the program once the commands it runs have ended. */
	retire(): void;
}

/**
 * pi's bash operations with each command started by pi-spawner, or
 * `fallback`'s where it isn't asked for.
 */
export function spawnedBy(
	fallback: BashOperations,
	options: SpawnerOptions = {},
): SpawnerOperations {
	const env = options.env ?? process.env;
	(options.reap ?? stopIdleSpawners)();
	if (!spawnerWanted(env)) {
		return {
			exec: (command, cwd, settings) => fallback.exec(command, cwd, settings),
			retire: () => undefined,
		};
	}
	const kill = options.kill ?? killGroup;
	let link: Link | undefined;
	let lost = false;
	let shell: Shell | undefined = options.shell;
	const linked = (): Link | undefined => {
		if (lost) return undefined;
		if (link) return link;
		const program =
			options.program ?? (options.find ?? systemProgram)(SPAWNER_PROGRAM);
		if (program === undefined) {
			lost = true;
			return undefined;
		}
		try {
			link = connect((options.start ?? startProgram)(program), kill, () => {
				lost = true;
				link = undefined;
			});
		} catch {
			// A program that won't start leaves pi's own spawn to do it.
			lost = true;
		}
		return link;
	};
	return {
		exec: async (command, cwd, settings) => {
			try {
				shell ??= getShellConfig(options.shellPath);
			} catch {
				// pi's own spawn says why the shell can't be found.
				return fallback.exec(command, cwd, settings);
			}
			const through =
				shell.commandTransport !== "stdin" && settings.env !== undefined
					? linked()
					: undefined;
			if (through === undefined) return fallback.exec(command, cwd, settings);
			return runThrough(through, shell, command, cwd, settings, kill);
		},
		retire: () => {
			lost = true;
			link?.retire();
			link = undefined;
		},
	};
}

/** The name a pi-spawner goes by in /proc, as its comm. */
const SPAWNER_COMM = SPAWNER_PROGRAM;

/**
 * Stop each pi-spawner `parent` started that runs no command, as an
 * earlier load of this extension left it; on Linux only, where /proc
 * says which processes a process started.
 */
export function stopIdleSpawners(
	parent: number = process.pid,
	proc = "/proc",
	stop: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): void {
	if (process.platform !== "linux" && proc === "/proc") return;
	for (const child of childrenOf(parent, proc)) {
		if (commOf(child, proc) !== SPAWNER_COMM) continue;
		if (childrenOf(child, proc).length > 0) continue;
		try {
			stop(child);
		} catch {
			// One that ended since it was read needs no stopping.
		}
	}
}

/** The processes `pid` started, from each of its threads. */
function childrenOf(pid: number, proc: string): number[] {
	try {
		return readdirSync(`${proc}/${pid}/task`).flatMap((task) =>
			readFileSync(`${proc}/${pid}/task/${task}/children`, "utf8")
				.split(/\s+/)
				.filter((word) => word !== "")
				.map(Number),
		);
	} catch {
		// A process that ended, or a kernel that doesn't say, started none.
		return [];
	}
}

/** The process's command name, or nothing once it has ended. */
function commOf(pid: number, proc: string): string | undefined {
	try {
		return readFileSync(`${proc}/${pid}/comm`, "utf8").trim();
	} catch {
		// It ended since its parent named it.
		return undefined;
	}
}

/** One command through pi-spawner, held to what pi's own spawn does. */
async function runThrough(
	link: Link,
	shell: Shell,
	command: string,
	cwd: string,
	settings: Parameters<BashOperations["exec"]>[2],
	kill: (pid: number) => void,
): Promise<{ exitCode: number }> {
	const { onData, signal, timeout, env = {} } = settings;
	const limit = timeLimit(timeout);
	if (signal?.aborted) throw new Error("aborted");
	try {
		await access(cwd, constants.F_OK);
	} catch {
		throw new Error(
			`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
		);
	}
	const run = link.run(shell.shell, [...shell.args, command], cwd, env, onData);
	const pid = await run.started;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => kill(pid);
	try {
		if (limit !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, limit);
		}
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
		const ended = await run.done;
		if (signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeout}`);
		return { exitCode: exitCodeOf(ended) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}

/** A time limit in milliseconds, refused as pi refuses it. */
function timeLimit(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const limit = timeout * 1000;
	if (limit > MAX_TIMEOUT_MS) {
		throw new Error(
			`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`,
		);
	}
	return limit;
}

/** The exit code pi reports: the code, or 128 and the signal's number. */
function exitCodeOf(ended: Ended): number {
	if (ended.code >= 0) return ended.code;
	return ended.signal > 0 ? 128 + ended.signal : 1;
}

/** Kill a command's process group, or the process alone, as pi does. */
function killGroup(pid: number): void {
	if (process.platform === "darwin") {
		try {
			process.kill(-pid, "SIGSTOP");
		} catch {
			// A group already gone has nothing left to stop.
		}
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Gone already.
		}
	}
}

/**
 * Start pi-spawner in a session of its own, so the terminal's signals
 * never reach it, and without holding pi open at its exit, when the end
 * of its input tells it to kill every command it still runs.
 */
function startProgram(program: string): Started {
	const child = spawn(program, [], {
		stdio: ["pipe", "pipe", "ignore"],
		detached: true,
	});
	child.unref();
	for (const stream of [child.stdin, child.stdout]) {
		if (stream && "unref" in stream && typeof stream.unref === "function") {
			stream.unref();
		}
	}
	if (!child.stdin || !child.stdout) throw new Error("pi-spawner has no pipes");
	return {
		input: child.stdin,
		output: child.stdout,
		ended: (listener) => {
			let told = false;
			const once = () => {
				if (told) return;
				told = true;
				listener();
			};
			child.once("exit", once);
			child.once("error", once);
		},
	};
}

/** A command's frames as they come, until it is done. */
interface Pending {
	frame(kind: number, payload: Buffer): void;
	lost(): void;
}

/** Talk to a started pi-spawner; `gone` is called once it stops. */
function connect(
	started: Started,
	kill: (pid: number) => void,
	gone: () => void,
): Link {
	const pending = new Map<number, Pending>();
	let next = 1;
	let held: Buffer = Buffer.alloc(0);
	let retiring = false;
	// The end of its input tells pi-spawner to stop; with nothing running,
	// it kills nothing.
	const closeOnceIdle = () => {
		if (retiring && pending.size === 0 && !started.input.writableEnded) {
			started.input.end();
		}
	};
	started.input.on("error", () => {
		// A program that stopped says so through ended, below.
	});
	started.output.on("data", (chunk: Buffer) => {
		held = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
		while (held.length >= HEAD_BYTES) {
			const length = held.readUInt32LE(5);
			if (held.length < HEAD_BYTES + length) break;
			const kind = held[0] ?? 0;
			const id = held.readUInt32LE(1);
			const payload = Buffer.from(
				held.subarray(HEAD_BYTES, HEAD_BYTES + length),
			);
			held = held.subarray(HEAD_BYTES + length);
			pending.get(id)?.frame(kind, payload);
		}
	});
	started.ended(() => {
		gone();
		for (const one of pending.values()) one.lost();
		pending.clear();
	});
	return {
		run(program, args, cwd, env, onData) {
			const id = next++;
			let pid: number | undefined;
			let exited: Ended | undefined;
			let closed = 0;
			let idle: ReturnType<typeof setTimeout> | undefined;
			let begin: { ok(pid: number): void; no(why: Error): void } | undefined;
			let end: { ok(ended: Ended): void; no(why: Error): void } | undefined;
			const startedRun = new Promise<number>((ok, no) => {
				begin = { ok, no };
			});
			const done = new Promise<Ended>((ok, no) => {
				end = { ok, no };
			});
			// A failure to start rejects started, never awaited past it.
			done.catch(() => undefined);
			const finish = () => {
				clearTimeout(idle);
				pending.delete(id);
				if (closed < STREAMS) send(started.input, ["drop", `${id}`]);
				if (exited) end?.ok(exited);
				closeOnceIdle();
			};
			const settleSoon = () => {
				clearTimeout(idle);
				idle = setTimeout(finish, EXIT_STDIO_GRACE_MS);
			};
			pending.set(id, {
				frame: (kind, payload) => {
					if (kind === STARTED) {
						pid = payload.readUInt32LE(0);
						begin?.ok(pid);
					} else if (kind === FAILED) {
						pending.delete(id);
						begin?.no(new Error(payload.toString("utf8")));
						closeOnceIdle();
					} else if (kind === OUTPUT) {
						onData(payload.subarray(1));
						if (exited) settleSoon();
					} else if (kind === CLOSED) {
						closed += 1;
						if (exited && closed >= STREAMS) finish();
					} else if (kind === EXITED) {
						exited = {
							code: payload.readInt32LE(0),
							signal: payload.readInt32LE(4),
						};
						if (closed >= STREAMS) finish();
						else settleSoon();
					}
				},
				lost: () => {
					clearTimeout(idle);
					if (pid === undefined) {
						begin?.no(
							new Error("pi-spawner stopped before the command started"),
						);
						return;
					}
					kill(pid);
					end?.no(new Error("pi-spawner stopped before the command ended"));
				},
			});
			const variables = Object.entries(env).flatMap(([name, value]) =>
				value === undefined || name.includes("=") ? [] : [`${name}=${value}`],
			);
			try {
				send(started.input, [
					"run",
					`${id}`,
					program,
					cwd,
					`${args.length}`,
					...args,
					`${variables.length}`,
					...variables,
				]);
			} catch (refused) {
				pending.delete(id);
				throw refused;
			}
			return { started: startedRun, done };
		},
		retire() {
			retiring = true;
			closeOnceIdle();
		},
	};
}

/**
 * Send one request: its length, then each field ended by a zero byte,
 * which no argument or variable can hold.
 */
function send(input: Writable, fields: readonly string[]): void {
	if (fields.some((field) => field.includes("\0"))) {
		throw new TypeError("A command's arguments can't hold a zero byte");
	}
	const body = Buffer.from(
		fields.map((field) => `${field}\0`).join(""),
		"utf8",
	);
	const length = Buffer.alloc(4);
	length.writeUInt32LE(body.length, 0);
	input.write(Buffer.concat([length, body]));
}
