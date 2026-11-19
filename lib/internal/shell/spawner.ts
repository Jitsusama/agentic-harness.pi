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
 * pi-spawner its pi started that runs nothing. Where there is no /proc, as
 * on a Mac, one listing of every process says the same, and the load
 * starts its own only once that listing is read, so its own is never
 * taken for one left behind. Until it was read there, pis on the Mac kept
 * an idle spawner beside their own (two of 49 at 03:20 on 16 November).
 *
 * The machine files a pi-spawner's whole tree of commands under the
 * quest its own environment names (core's jobs-sorter reads `PI_QUEST`
 * from the tree's root), so each is started naming the quest of the
 * first command it runs. A command for another quest retires it, and
 * the next is started naming that one. Before that, a host's spawners
 * carried the host's environment, which names no quest, and every
 * hosted session's work was filed as no quest's (VRZKID, 15 November).
 *
 * A load given its session tells the machine's mycelium node which
 * session each spawner it starts serves (spawner-register.ts), and its
 * first command waits for that, at most the two patiences there (about
 * four seconds), or until it's stopped, so the node can tell which of a
 * host's sessions asked it for a run. The node takes
 * the word only from the host itself, of its own pi-spawner child, so a
 * command that starts a spawner of its own, or runs as pi's own child
 * once a spawner is lost, is told no session. The node keeps that word
 * only while it runs, so each spawner is said again every 30 seconds
 * until it ends, and a node that restarted knows it again by then. Each
 * saying names the start read once as the spawner began, so a pid it
 * left to another process once it ended is never named.
 * A command waiting on that holds its spawner, so another quest's
 * command retiring it closes it only once this one has run.
 *
 * When pi goes, pi-spawner kills every command it still runs but one kept
 * on disk (shell-workflow's keeping.ts), which a shared host hands to the
 * next. A spawner from before that answers no `keeps`, so through it no
 * command is kept, and each holds a host's restart as before.
 *
 * Long because one link's life, from its start through its quest, its
 * registering, its retiring and its stop, is one state machine that
 * every command it starts reads, and split it would be read in pieces.
 */

import { execFile, spawn } from "node:child_process";
import {
	constants,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	type BashOperations,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../core/session/host.ts";
import { systemProgram } from "../sandbox/system-program.ts";
import { registerSpawner, type Spawned, startOf } from "./spawner-register.ts";
import {
	sayUnscoped,
	scopeFailed,
	settingHere,
	spawnerStart,
} from "./spawner-scope.ts";
import { spawnerWanted } from "./spawner-variable.ts";

/** The program's name, as core.nix puts it on the PATH. */
export const SPAWNER_PROGRAM = "pi-spawner";

/** What pi-spawner says, asked `keeps`, when it spares kept commands. */
const KEEPS_WORD = "keeps";

/** How long pi-spawner may take to say whether it keeps. */
const KEEPS_TIMEOUT_MS = 5000;

/** How much of a scoped spawner's error output is kept to say. */
const SAID_MOST = 1024;

/** How long pi waits for output past a command's exit, as pi does. */
const EXIT_STDIO_GRACE_MS = 100;

/** The longest time limit pi takes, which is setTimeout's. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The frames pi-spawner sends, by their first byte. */
const STARTED = "p".charCodeAt(0);
const OUTPUT = "o".charCodeAt(0);
const CLOSED = "c".charCodeAt(0);
const EXITED = "x".charCodeAt(0);
const FAILED = "e".charCodeAt(0);

/**
 * How often a spawner's session is said again while it runs, as the
 * node's protocol has a host say it (mycelium's PROTOCOL.md).
 */
export const RESAY_MS = 30_000;

/** The variable naming the quest a command's work is for. */
const QUEST_VARIABLE = "PI_QUEST";

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
	/** Its process, where it started as one. */
	pid?: number;
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
	/** Start the program, its environment naming `quest`, the work it runs. */
	start?: (program: string, quest?: string) => Started;
	/** The session whose load this is, which its spawners serve. */
	session?: string;
	/**
	 * Tell the machine's node the session a started spawner serves; by
	 * default on the node's socket (registerSpawner).
	 */
	register?: (spawned: Spawned, session: string) => Promise<void>;
	/**
	 * When a process started, in clock ticks since boot, read once as a
	 * spawner starts; by default from /proc (startOf).
	 */
	startOf?: (pid: number) => Promise<number | undefined>;
	/** How often a running spawner's session is said again (RESAY_MS). */
	resay?: number;
	/** Whether the program at a path spares kept commands when pi goes. */
	asksKeeps?: (program: string) => Promise<boolean>;
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
	reap?: () => void | Promise<void>;
}

/** pi's bash operations, and a way to retire the spawner behind them. */
export interface SpawnerOperations extends BashOperations {
	/**
	 * Take no more commands through pi-spawner, and close it once the
	 * commands it runs have ended. Later commands start as pi's own.
	 */
	retire(): void;
	/**
	 * Whether a kept command these start outlives this pi's going: always
	 * through pi's own spawn, and through pi-spawner when it says it
	 * keeps. Asked once and waited on without holding pi's loop.
	 */
	spares(): Promise<boolean>;
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
	/**
	 * Keep the program open, though retired, until what this returns is
	 * called: a command about to be sent holds it as one running does.
	 */
	hold(): () => void;
	/** Whether the program has stopped. */
	stopped(): boolean;
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
	const sweeping = (options.reap ?? stopIdleSpawners)();
	// A sweep that lists every process finishes before this load's own
	// spawner starts; one that fails stops nothing, and holds nothing up.
	const swept = sweeping ? sweeping.catch(() => undefined) : undefined;
	if (!spawnerWanted(env)) {
		return {
			exec: (command, cwd, settings) => fallback.exec(command, cwd, settings),
			retire: () => undefined,
			spares: async () => true,
		};
	}
	const kill = options.kill ?? killGroup;
	let link: Link | undefined;
	let linkQuest: string | undefined;
	// The node told the session the link's spawner serves, or given up on.
	let linkTold: Promise<void> | undefined;
	let lost = false;
	let shell: Shell | undefined = options.shell;
	let found: { program: string | undefined } | undefined;
	// Resolved once, so the program asked whether it keeps is the one that
	// runs, though a switch repoints the profile's link between the two.
	const programOf = (): string | undefined => {
		found ??= {
			program: resolved(
				options.program ?? (options.find ?? systemProgram)(SPAWNER_PROGRAM),
			),
		};
		return found.program;
	};
	let keeps: Promise<boolean> | undefined;
	const linked = (quest: string | undefined): Link | undefined => {
		if (lost) return undefined;
		if (link && linkQuest === quest) return link;
		// Another quest's work: the one running closes once its own commands
		// end, and the next is filed under this quest from its start.
		link?.retire();
		link = undefined;
		const program = programOf();
		if (program === undefined) {
			lost = true;
			return undefined;
		}
		try {
			let made: Link | undefined;
			let resaying: ReturnType<typeof setInterval> | undefined;
			let ended = false;
			const begun = (options.start ?? startProgram)(program, quest);
			made = connect(begun, kill, () => {
				ended = true;
				clearInterval(resaying);
				// One retired for another quest's ends with no loss to the next.
				if (link !== made) return;
				lost = true;
				link = undefined;
			});
			link = made;
			linkQuest = quest;
			const { pid } = begun;
			const { session } = options;
			const register = options.register ?? registerSpawner;
			linkTold = undefined;
			if (session !== undefined && pid !== undefined) {
				// Read at once, while the pid is still the spawner's, and said
				// each time: the node refuses a pid whose start differs.
				const began = Promise.resolve()
					.then(() => (options.startOf ?? startOf)(pid))
					.catch(() => undefined);
				// A telling that fails, at once or later, leaves the spawner
				// unnamed until the next says it; with no start, as with no
				// /proc, nothing is said.
				const tell = () =>
					began
						.then(async (started) => {
							if (started !== undefined) {
								await register({ pid, started }, session);
							}
						})
						.catch(() => undefined);
				linkTold = tell();
				// Said again while it runs, even once retired, since what it
				// still runs may ask the node; never holding pi open.
				if (!ended) {
					resaying = setInterval(() => {
						void tell();
					}, options.resay ?? RESAY_MS);
					resaying.unref();
				}
			}
		} catch {
			// A program that won't start leaves pi's own spawn to do it.
			lost = true;
		}
		return link;
	};
	return {
		exec: async (command, cwd, settings) => {
			if (swept) await swept;
			try {
				shell ??= getShellConfig(options.shellPath);
			} catch {
				// pi's own spawn says why the shell can't be found.
				return fallback.exec(command, cwd, settings);
			}
			const sharing =
				shell.commandTransport !== "stdin" && settings.env !== undefined;
			const quest = settings.env?.[QUEST_VARIABLE];
			const through = sharing ? linked(quest) : undefined;
			if (through === undefined) return fallback.exec(command, cwd, settings);
			// The telling of the spawner just taken, read before anything waits.
			const told = linkTold;
			// Refused before any wait, and counted from now, so the wait on
			// the telling is part of the command's time, as pi's own would be.
			const limit = timeLimit(settings.timeout);
			const asked = performance.now();
			// Held until it has run, so a command of another quest retiring
			// this spawner, or the load retiring, closes it only after.
			const release = through.hold();
			try {
				// Nothing it runs asks the node before the node knows whose it
				// is.
				const waited =
					told === undefined
						? "told"
						: await toldOrStopped(told, settings.signal, limit);
				// Stopped while it waited, it ends as stopped, wherever it
				// would have run.
				if (settings.signal?.aborted) throw new Error("aborted");
				const left =
					limit === undefined ? undefined : limit - (performance.now() - asked);
				if (waited === "expired" || (left !== undefined && left <= 0)) {
					throw new Error(`timeout:${settings.timeout}`);
				}
				// Only its own spawner stopping while it waited leaves it to
				// pi's own spawn, given what time is left; any other, the one
				// serving now included, may stop without moving it.
				if (through.stopped()) {
					if (left === undefined) {
						return await fallback.exec(command, cwd, settings);
					}
					try {
						return await fallback.exec(command, cwd, {
							...settings,
							timeout: left / 1000,
						});
					} catch (error) {
						// It ran out of the time asked for, not of what was left.
						if (
							error instanceof Error &&
							error.message.startsWith("timeout:")
						) {
							throw new Error(`timeout:${settings.timeout}`);
						}
						throw error;
					}
				}
				return await runThrough(
					through,
					shell,
					command,
					cwd,
					settings,
					left,
					kill,
				);
			} finally {
				release();
			}
		},
		retire: () => {
			lost = true;
			link?.retire();
			link = undefined;
		},
		spares: async () => {
			// Without the program, pi's own spawn starts what these run.
			const program = programOf();
			if (lost || program === undefined) return true;
			keeps ??= (options.asksKeeps ?? spawnerKeeps)(program);
			return await keeps;
		},
	};
}

/** The file `program` names, through any links, or `program` where none is there. */
function resolved(program: string | undefined): string | undefined {
	if (program === undefined) return undefined;
	try {
		return realpathSync(program);
	} catch {
		// Nothing there: starting it fails, and pi's own spawn takes over.
		return program;
	}
}

/**
 * Whether the pi-spawner at `program` spares kept commands when pi goes:
 * asked `keeps`, it says so. One from before refuses the word, or reads
 * its empty input as pi gone and says nothing.
 */
export function spawnerKeeps(program: string): Promise<boolean> {
	return new Promise((resolve) => {
		const asked = spawn(program, [KEEPS_WORD], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: KEEPS_TIMEOUT_MS,
		});
		let said = "";
		asked.stdout?.setEncoding("utf8");
		asked.stdout?.on("data", (chunk: string) => {
			said += chunk;
		});
		// One that can't start keeps nothing.
		asked.once("error", () => resolve(false));
		asked.once("close", (status) =>
			resolve(status === 0 && said.trim() === KEEPS_WORD),
		);
	});
}

/** The name a pi-spawner goes by in /proc, as its comm. */
const SPAWNER_COMM = SPAWNER_PROGRAM;

/** How long a listing of every process may take before it counts as none. */
const LISTING_TIMEOUT_MS = 10_000;

/**
 * Stop each pi-spawner `parent` started that runs no command, as an
 * earlier load of this extension left it. /proc says which processes a
 * process started; where it can't, a listing of every process does, and
 * the stop then ends once that listing is read.
 */
export function stopIdleSpawners(
	parent: number = process.pid,
	proc = "/proc",
	stop: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
	list: () => Promise<string> = listEveryProcess,
): void | Promise<void> {
	if (!existsSync(`${proc}/${parent}`)) {
		return list().then((listing) => {
			for (const idle of idleSpawnersListed(listing, parent))
				stopping(idle, stop);
		});
	}
	for (const child of childrenOf(parent, proc)) {
		if (commOf(child, proc) !== SPAWNER_COMM) continue;
		if (childrenOf(child, proc).length > 0) continue;
		stopping(child, stop);
	}
}

/** Stop `pid`, which may have ended since it was read. */
function stopping(pid: number, stop: (pid: number) => void): void {
	try {
		stop(pid);
	} catch {
		// One that ended since it was read needs no stopping.
	}
}

/**
 * The pi-spawners `parent` started that run nothing, from a listing of
 * every process as `ps -A -o pid=,ppid=,comm=` prints it; none from a
 * listing that can't be read.
 */
export function idleSpawnersListed(listing: string, parent: number): number[] {
	const rows = listing.split("\n").flatMap((line) => {
		const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		return row?.[1] && row[2] && row[3]
			? [{ pid: Number(row[1]), ppid: Number(row[2]), comm: row[3] }]
			: [];
	});
	const parents = new Set(rows.map((row) => row.ppid));
	return rows
		.filter(
			(row) =>
				row.ppid === parent &&
				basename(row.comm) === SPAWNER_COMM &&
				!parents.has(row.pid),
		)
		.map((row) => row.pid);
}

/** Every process, as `ps` lists it, or nothing where it can't. */
function listEveryProcess(): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-A", "-o", "pid=,ppid=,comm="],
			{ timeout: LISTING_TIMEOUT_MS },
			(error, out) => resolve(error ? "" : out),
		);
	});
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

/** Why a wait on the node's telling ended. */
type Waited = "told" | "stopped" | "expired";

/**
 * Once `told` settles, or sooner if `signal` stops the command or its
 * `limit`, in milliseconds, runs out; saying which came first.
 */
function toldOrStopped(
	told: Promise<void>,
	signal: AbortSignal | undefined,
	limit: number | undefined,
): Promise<Waited> {
	if (signal?.aborted) return Promise.resolve("stopped");
	return new Promise((settle) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopped = () => done("stopped");
		const done = (why: Waited) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stopped);
			settle(why);
		};
		if (limit !== undefined) timer = setTimeout(() => done("expired"), limit);
		signal?.addEventListener("abort", stopped, { once: true });
		void told.then(() => done("told"));
	});
}

/** One command through pi-spawner, held to what pi's own spawn does. */
async function runThrough(
	link: Link,
	shell: Shell,
	command: string,
	cwd: string,
	settings: Parameters<BashOperations["exec"]>[2],
	limit: number | undefined,
	kill: (pid: number) => void,
): Promise<{ exitCode: number }> {
	const { onData, signal, timeout, env = {} } = settings;
	if (signal?.aborted) throw new Error("aborted");
	try {
		await access(cwd, constants.F_OK);
	} catch {
		throw new Error(
			`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
		);
	}
	const run = link.run(shell.shell, [...shell.args, command], cwd, env, onData);
	// The limit and a stop count from the ask, not from STARTED, so a
	// spawner slow to start the command can't stretch either.
	let pid: number | undefined;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let gaveUp: ((why: "expired" | "aborted") => void) | undefined;
	const givenUp = new Promise<"expired" | "aborted">((settle) => {
		gaveUp = settle;
	});
	const stop = () => {
		if (pid !== undefined) kill(pid);
		gaveUp?.("aborted");
	};
	try {
		if (limit !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				if (pid !== undefined) kill(pid);
				gaveUp?.("expired");
			}, limit);
		}
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
		const first = await Promise.race([run.started, givenUp]);
		if (typeof first !== "number") {
			// It ended before the spawner said it started: kill it once it has.
			run.started.then(kill, () => undefined);
			run.done.catch(() => undefined);
			throw new Error(first === "aborted" ? "aborted" : `timeout:${timeout}`);
		}
		pid = first;
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
 * of its input tells it to kill every command it still runs. A host's
 * runs in a systemd scope of its own where it can, so what it starts
 * outlives the host's stop (spawner-scope.ts). A scoped one's error
 * output is read, the first of it kept, so a scope that couldn't be made
 * is said and the spawners after it run unscoped.
 */
function startProgram(program: string, quest?: string): Started {
	const start = spawnerStart(program, settingHere(hosted() !== undefined));
	if (start.unscoped !== undefined) sayUnscoped(start.unscoped);
	const scoped = start.args.length > 0;
	const child = spawn(start.command, [...start.args], {
		stdio: ["pipe", "pipe", scoped ? "pipe" : "ignore"],
		detached: true,
		env: quest ? { ...process.env, [QUEST_VARIABLE]: quest } : process.env,
	});
	child.unref();
	if (scoped) {
		let said = "";
		// Read to its end, so a spawner that says much never fills the pipe.
		child.stderr?.on("data", (chunk: Buffer) => {
			if (said.length < SAID_MOST) said += chunk.toString("utf8");
		});
		child.once("exit", (code) => {
			if (code !== null && code !== 0) scopeFailed(code, said);
		});
	}
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		if (stream && "unref" in stream && typeof stream.unref === "function") {
			stream.unref();
		}
	}
	if (!child.stdin || !child.stdout) throw new Error("pi-spawner has no pipes");
	return {
		input: child.stdin,
		output: child.stdout,
		...(child.pid !== undefined ? { pid: child.pid } : {}),
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
	// Commands about to be sent, which keep it open as running ones do.
	let holding = 0;
	// The end of its input tells pi-spawner to stop; with nothing running,
	// it kills nothing.
	const closeOnceIdle = () => {
		if (
			retiring &&
			pending.size === 0 &&
			holding === 0 &&
			!started.input.writableEnded
		) {
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
	let over = false;
	started.ended(() => {
		over = true;
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
			// One that stopped, or was told to close, hears nothing more.
			if (over || started.input.writableEnded) {
				begin?.no(new Error("pi-spawner stopped before the command started"));
				return { started: startedRun, done };
			}
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
		hold() {
			holding += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				holding -= 1;
				closeOnceIdle();
			};
		},
		stopped: () => over,
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
