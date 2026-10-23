/**
 * Writes that would land behind pi's screen, caught before they do.
 *
 * pi draws its screen by keeping a picture of every row and writing
 * only what changed. Anything else written to the terminal lands
 * wherever the cursor is, usually the editor, and leaves that picture
 * wrong until something redraws it. In interactive mode pi guards
 * neither stream, and pi itself is one of the writers: its event bus
 * catches a `pi.events` handler that throws and `console.error`s the
 * whole stack. So every throwing handler, every library's warning and
 * every stray `console.log` became junk over the question bar, said
 * nowhere else, with nothing to say whose it was.
 *
 * The guard replaces the console's methods and standard error's write
 * once per process, and hands what they are given to whoever handles it
 * now. It acts only while pi's screen owns the terminal, which is
 * while its TUI holds standard input raw: pi stops the TUI before it
 * prints a crash, and an external editor stops it too, so those pass
 * through as written, as does everything in print and RPC mode.
 */

import { fileURLToPath } from "node:url";
import { format } from "node:util";

/** One write the guard kept off the screen. */
export interface StrayWrite {
	/** What wrote it: `console.error`, `stderr` and so on. */
	readonly kind: string;
	/** What it wrote, formatted the way the console would have. */
	readonly text: string;
	/** The stack that made the write, innermost frame first. */
	readonly stack: string;
}

/** Whoever takes the writes the guard catches. */
export type StrayHandler = (write: StrayWrite) => void;

/** Whether pi's screen owns the terminal at this moment. */
export type ScreenUp = () => boolean;

/** What the guard wraps: a console and a stream it writes to. */
export interface GuardTarget {
	readonly console: Console;
	readonly stderr: NodeJS.WriteStream | { write: NodeJS.WriteStream["write"] };
}

/**
 * The console methods a guard takes over. `table`, `dir` and the rest
 * write through these, or through standard error's write, so they are
 * caught either way.
 */
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** How many frames of the writer's stack are kept. */
const STACK_FRAMES = 12;

/** This module, whose frames sit on top of every stack it takes. */
const SELF = fileURLToPath(import.meta.url);

/**
 * Where a process keeps its guard: on the console it wraps, under a
 * key every copy of this module shares, so a reload hands the new code
 * the guard the old code installed instead of wrapping it again. The
 * key carries a version, and a change to what it holds takes a new one.
 */
const GUARD = Symbol.for("agentic-harness.stray-output.guard.v1");

interface Guard {
	handle: StrayHandler;
}

type Guarded = Console & { [GUARD]?: Guard };

/** pi's TUI holds standard input raw from its start until its stop. */
export const screenIsUp: ScreenUp = () =>
	process.stdin.isTTY === true && process.stdin.isRaw === true;

/**
 * Keep writes off pi's screen while it is up, handing each to `handle`.
 *
 * The first call wraps the target; each later one only changes who
 * handles what it catches, so it can be called on every load and every
 * session start.
 */
export function guardOutput(
	handle: StrayHandler,
	up: ScreenUp = screenIsUp,
	target: GuardTarget = { console, stderr: process.stderr },
): void {
	const held = target.console as Guarded;
	const guard = held[GUARD];
	if (guard) {
		guard.handle = handle;
		return;
	}
	const installed: Guard = { handle };
	held[GUARD] = installed;
	let handling = false;
	const hand = (kind: string, text: string): boolean => {
		if (!up()) return false;
		// Something the handler did wrote again. Writing it to the screen
		// is what the guard is for avoiding, and handing it back would
		// loop, so the inner write is dropped.
		if (handling) return true;
		handling = true;
		try {
			installed.handle({ kind, text, stack: callerStack() });
		} catch {
			// A handler that cannot keep a write must not turn a warning
			// into a crash; the write is lost either way.
		} finally {
			handling = false;
		}
		return true;
	};
	for (const method of METHODS) {
		const original = target.console[method];
		target.console[method] = (...args: unknown[]) => {
			if (!hand(`console.${method}`, format(...args))) {
				original.apply(target.console, args);
			}
		};
	}
	const stream = target.stderr;
	const write = stream.write;
	stream.write = function guardedWrite(
		this: unknown,
		chunk: unknown,
		...rest: unknown[]
	): boolean {
		const text =
			typeof chunk === "string"
				? chunk
				: chunk instanceof Uint8Array
					? Buffer.from(chunk).toString("utf8")
					: String(chunk);
		if (!hand("stderr", text)) {
			return Reflect.apply(write, stream, [chunk, ...rest]);
		}
		const done = rest.find((arg) => typeof arg === "function");
		if (typeof done === "function") queueMicrotask(() => done());
		return true;
	} as NodeJS.WriteStream["write"];
}

/** The frames above the guard's own: who made the write. */
function callerStack(): string {
	const frames = (new Error().stack ?? "").split("\n").slice(1);
	const outside = frames.filter((frame) => !frame.includes(SELF));
	return outside.slice(0, STACK_FRAMES).join("\n");
}
