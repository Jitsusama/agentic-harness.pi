/**
 * A plain pi in a terminal of its own, as every pi Joel runs is one: the
 * host's pi run interactively under script(1), which gives it a
 * pseudo-terminal, with what is typed written to that terminal and what
 * it shows drawn on xterm's headless one. Unlike pi over RPC, which ends
 * only once its client next asks it something, it ends the moment it is
 * told to while idle, so a session moving out of it goes as it would at
 * Joel's desk. Its session is read from the presence its harness
 * publishes, and its log from the sessions folder, once pi writes one.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionsDir } from "../../../../lib/internal/paths.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { type Drawn, drawn } from "./drawn.ts";
import { textOf, untilAnswered } from "./hosted-case.ts";
import type { Seal } from "./seal.ts";

/** The extension that registers the scripted model in a plain pi. */
export const SCRIPTED_PROVIDER = resolve(
	import.meta.dirname,
	"scripted-provider.ts",
);

/** The terminal's size. */
const ROWS = 40;
const COLUMNS = 120;

/** How long a plain pi may take to load the harness and say it's there. */
const START_MS = 120_000;

/** How long a plain pi may take to go once told to. */
const STOP_WAIT_MS = 20_000;

/** What pi reads as the Enter key. */
const ENTER = "\r";

/** A plain pi running in a terminal in the seal. */
export interface TerminalPi {
	/** Its process's id, which its presence names as its owner. */
	readonly pid: number;
	/** Its session's id, as its presence says. */
	readonly sessionId: string;
	/** Its session's log, once pi has written one. */
	file(): string | undefined;
	/** Type `message` and Enter, as the person would, waiting until its log holds it. */
	prompt(message: string): Promise<void>;
	/** Type `line` and Enter, as a slash command, which its log never holds. */
	type(line: string): void;
	/** Whether it has ended. */
	ended(): boolean;
	/** Stop it, waiting until it has gone. */
	stop(): Promise<void>;
	/** What its terminal shows and what script(1) wrote, for a failure. */
	errors(): string;
}

/** How a plain pi is started in its terminal. */
interface TerminalStart {
	seal: Seal;
	packageDir: string;
	file?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	bare?: boolean;
	/** Flags beside those, as the launcher's `--session-id` for a spawn. */
	args?: readonly string[];
}

/** A pi that ran in a terminal until it ended, as it left that terminal. */
export interface EndedTerminalPi {
	/** How it exited, or null when a signal ended it. */
	readonly code: number | null;
	/** Every line its terminal shows. */
	readonly screen: readonly string[];
	/** What its terminal shows and what script(1) wrote, for a failure. */
	readonly errors: string;
}

/**
 * Run a plain pi as {@link startTerminalPi} starts one, for a pi that
 * ends on its own, answering once it has, or failing after `withinMs`.
 */
export async function runTerminalPi(
	options: TerminalStart & { withinMs: number },
): Promise<EndedTerminalPi> {
	const run = inTerminal(options);
	const timer = setTimeout(() => run.child.kill("SIGKILL"), options.withinMs);
	const [code, signal] = (await run.exited) as [number | null, string | null];
	clearTimeout(timer);
	if (signal === "SIGKILL") {
		throw new Error(
			`pi didn't end within ${options.withinMs} ms\n${run.errors()}`,
		);
	}
	return { code, screen: run.drawing.screen(), errors: run.errors() };
}

/**
 * Start a plain pi under `seal` on the pi in `packageDir`, in `cwd`, in a
 * terminal: resuming the session `file`, or on a fresh session without
 * one, with `env` beside the seal's. Answers once its harness has said it
 * is there. A `bare` pi takes no flag, as a held pi a restart can start
 * again takes none it would lose (lib/internal/session/park.ts
 * flagsLost), so the seal's settings must load {@link SCRIPTED_PROVIDER}.
 */
export async function startTerminalPi(
	options: TerminalStart,
): Promise<TerminalPi> {
	const started = inTerminal(options);
	const { child, errors } = started;
	let gone = false;
	const exited = started.exited.then(() => {
		gone = true;
	});
	const fail = (error: unknown): never => {
		throw new Error(`${String(error)}\n${errors()}`);
	};

	let pid = 0;
	await untilAnswered(
		"pi starts in its terminal",
		async () => {
			pid = childOf(child.pid ?? 0) ?? 0;
			return pid !== 0 || gone;
		},
		START_MS,
	).catch(fail);
	const presences = createPresences(
		join(
			options.seal.env.XDG_STATE_HOME ?? "",
			"pi",
			"agentic-harness.pi",
			"mesh-workflow",
			"presence",
		),
	);
	let sessionId = "";
	await untilAnswered(
		"pi's harness says it is there",
		async () => {
			sessionId =
				presences.all().find((one) => one.owner?.pid === pid)?.session ?? "";
			return sessionId !== "" || gone;
		},
		START_MS,
	).catch(fail);
	if (gone) fail(new Error("pi ended as it started"));

	const sessions = sessionsDir(options.seal.home);
	let found = options.file;
	const file = () => {
		found ??= logOf(sessions, sessionId);
		return found;
	};
	return {
		pid,
		sessionId,
		file,
		async prompt(message) {
			child.stdin.write(message);
			child.stdin.write(ENTER);
			await untilAnswered(`pi takes "${message}" from its terminal`, async () =>
				textOf(file()).includes(JSON.stringify(message).slice(1, -1)),
			).catch(fail);
		},
		type(line) {
			child.stdin.write(line);
			child.stdin.write(ENTER);
		},
		ended: () => gone,
		async stop() {
			if (gone) return;
			child.kill("SIGHUP");
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				if (pid !== 0) killQuietly(pid);
			}, STOP_WAIT_MS);
			await exited;
			clearTimeout(timer);
		},
		errors,
	};
}

/** Pi started in a terminal of its own, drawn as it draws. */
function inTerminal(options: TerminalStart) {
	const words = [
		process.execPath,
		join(options.packageDir, "dist/bundle/cli.js"),
		...(options.file ? ["--session", options.file] : []),
		...(options.bare ? [] : ["--extension", SCRIPTED_PROVIDER]),
		...(options.args ?? []),
	].map(quoted);
	// script(1) reads no window from a pipe, so the terminal is told its
	// size before pi starts in it; exec keeps the pid pi runs as.
	const child = spawn(
		"script",
		[
			"-qfec",
			`stty rows ${ROWS} cols ${COLUMNS}; exec ${words.join(" ")}`,
			"/dev/null",
		],
		{
			cwd: options.cwd,
			env: {
				...options.seal.env,
				...options.env,
				TERM: "xterm-256color",
				PI_HOST_PACKAGE_DIR: options.packageDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const drawing: Drawn = drawn(ROWS, COLUMNS);
	child.stdout.on("data", (chunk) => drawing.draw(String(chunk)));
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	// Listened for at once, so an exit before anyone waits isn't missed.
	const exited = once(child, "exit");
	const errors = () =>
		[`Its terminal shows:\n${drawing.screen().join("\n")}`, stderr].join("\n");
	return { child, drawing, errors, exited };
}

/** `word` quoted for sh. */
function quoted(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The one process `parent` started, once it has. */
function childOf(parent: number): number | undefined {
	try {
		const children = readFileSync(
			`/proc/${parent}/task/${parent}/children`,
			"utf8",
		)
			.trim()
			.split(/\s+/)
			.filter((one) => one !== "");
		return children.length > 0 ? Number(children[0]) : undefined;
	} catch {
		// script(1) hasn't forked yet, or has ended: the poll asks again.
		return undefined;
	}
}

/** The log of `session` under the sessions folder, once pi has written one. */
function logOf(sessions: string, session: string): string | undefined {
	let folders: string[];
	try {
		folders = readdirSync(sessions);
	} catch {
		// No session has been written yet.
		return undefined;
	}
	for (const folder of folders) {
		let names: string[];
		try {
			names = readdirSync(join(sessions, folder));
		} catch {
			// Not a folder, or gone since the listing.
			continue;
		}
		const name = names.find((one) => one.endsWith(`_${session}.jsonl`));
		if (name) return join(sessions, folder, name);
	}
	return undefined;
}

/** Kill `pid`, which may already have gone. */
function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// It went on its own.
	}
}
