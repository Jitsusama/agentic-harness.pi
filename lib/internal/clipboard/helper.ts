/**
 * A small shell a session forks once, while it is young, to run the
 * clipboard reads its pastes need, so the session itself never forks
 * at a keypress.
 *
 * Forking copies the whole process's page tables, and node waits for
 * it: on 10 November a node holding 1.2 GB took 42 to 114 ms to fork
 * and once 1055 ms, and pi's paste forks twice. The shell is a few
 * megabytes, so what it forks costs it almost nothing. It keeps
 * nothing between reads: it reads the clipboard only when asked.
 */

import { spawn } from "node:child_process";

/** Runs a command and answers with its output. */
export type Read = (
	argv: readonly string[],
	timeoutMs: number,
) => Promise<Buffer | undefined>;

/** The shell, answering reads in the order they were asked. */
export interface Helper {
	/**
	 * What `argv` printed, empty when it printed nothing or failed, or
	 * `undefined` when the shell couldn't answer, so the caller can run
	 * the command another way.
	 */
	readonly read: Read;
	/** Whether the shell is still there to answer. */
	readonly alive: () => boolean;
	/** Ends the shell; any read waiting answers `undefined`. */
	readonly stop: () => void;
}

/**
 * How long past a command's own limit the shell may take to say what
 * it printed, before it counts as stuck and is ended.
 */
const SHELL_SPARE_MS = 2_000;

interface Waiting {
	readonly answer: (output: Buffer | undefined) => void;
	readonly timer: NodeJS.Timeout;
}

/** Forks the shell, which then waits for reads. */
export function startHelper(shell = "sh"): Helper {
	const child = spawn(shell, [], {
		stdio: ["pipe", "pipe", "ignore"],
		cwd: "/",
		detached: true,
	});
	const waiting: Waiting[] = [];
	let alive = true;
	let buffered = "";

	const end = (): void => {
		if (!alive) return;
		alive = false;
		for (const one of waiting.splice(0)) {
			clearTimeout(one.timer);
			one.answer(undefined);
		}
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// The shell's group is already gone, which is what ending it wants.
		}
	};

	child.on("error", end);
	child.on("exit", end);
	child.stdin.on("error", end);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffered += chunk;
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			const head = waiting.shift();
			if (head) {
				clearTimeout(head.timer);
				head.answer(Buffer.from(line, "base64"));
			}
			newline = buffered.indexOf("\n");
		}
	});
	child.unref();
	unrefStream(child.stdout);
	unrefStream(child.stdin);

	const read: Read = (argv, timeoutMs) =>
		new Promise((answer) => {
			if (!alive) {
				answer(undefined);
				return;
			}
			const timer = setTimeout(end, timeoutMs + SHELL_SPARE_MS);
			waiting.push({ answer, timer });
			child.stdin.write(readLine(argv, timeoutMs));
		});

	return { read, alive: () => alive, stop: end };
}

/**
 * The shell line that runs `argv` under `timeout` and prints its
 * output as one base64 line, which holds any bytes an image has and
 * never holds a newline of its own.
 */
function readLine(argv: readonly string[], timeoutMs: number): string {
	const seconds = (timeoutMs / 1000).toString();
	const command = argv.map(quoted).join(" ");
	return `printf '%s\\n' "$(timeout ${seconds} ${command} 2>/dev/null </dev/null | base64 -w0)"\n`;
}

function quoted(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Lets node exit while the shell still waits for a read. */
function unrefStream(stream: object): void {
	const unref: unknown = Reflect.get(stream, "unref");
	if (typeof unref === "function") unref.call(stream);
}

/**
 * Runs `argv` from this process, as pi itself does, for when the
 * shell can't: what it printed, or `undefined` when it failed or ran
 * past `timeoutMs`.
 */
export function readDirectly(
	argv: readonly string[],
	timeoutMs: number,
): Promise<Buffer | undefined> {
	const [command, ...args] = argv;
	if (command === undefined) return Promise.resolve(undefined);
	return new Promise((answer) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "ignore"],
			cwd: "/",
			detached: true,
		});
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// It ended as the limit passed; its close answers.
			}
			answer(undefined);
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => {
			clearTimeout(timer);
			answer(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			answer(code === 0 ? Buffer.concat(chunks) : undefined);
		});
	});
}
