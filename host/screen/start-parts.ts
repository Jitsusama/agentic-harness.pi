/**
 * Where a hosted screen's start goes: the steps of pi's InteractiveMode
 * init (waiting for the terminal's colours, binding the extensions,
 * drawing the conversation, counting providers) and the time each
 * extension's handlers take while it runs, said as one line. A wake's
 * "screen" phase is this start, and it is the largest part of a wake a
 * warm spare can't pay ahead, so this names what in it to cut. It wraps
 * pi's private methods only while the start runs, and puts them back
 * after, so nothing outlives it; a pi without one of them goes untimed
 * there, its time falling in "rest". A step one of them calls (bind counts
 * the providers itself) is counted in the step that called it, so the
 * steps and "rest" sum to the whole; an extension's time is the part of
 * its step its handlers took.
 */

import { basename, dirname } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";

/** How many of the slowest extensions the line names. */
const SLOWEST = 5;
const MS_PER_S = 1000;

/** pi's InteractiveMode's start steps the line times, by the name it says them. */
const STEPS = [
	["themeController", "waitForTerminalColors", "colours"],
	[undefined, "rebindCurrentSession", "bind"],
	[undefined, "renderInitialMessages", "draw"],
	[undefined, "updateAvailableProviderCount", "providers"],
] as const;

/** One step's or one extension's time, in milliseconds. */
export interface Part {
	readonly name: string;
	readonly ms: number;
}

/** What a screen's start took, whole and in parts. */
export interface StartParts {
	readonly ms: number;
	readonly steps: readonly Part[];
	/** Each extension whose handlers ran during the start, slowest first. */
	readonly extensions: readonly Part[];
}

/** A screen's start, timed while `start` runs; each wrap is put back once it settles. */
export async function timeStart(
	mode: object,
	runtime: unknown,
	start: () => Promise<void>,
	now: () => number = () => performance.now(),
): Promise<StartParts> {
	const steps: Steps = { took: new Map(), running: 0 };
	const extensions = new Map<string, number>();
	const restores: (() => void)[] = [];
	for (const [owner, method, name] of STEPS) {
		const target = owner === undefined ? mode : Reflect.get(mode, owner);
		if (isRecord(target))
			restores.push(timeMethod(target, method, name, steps, now));
	}
	for (const extension of extensionsOf(runtime))
		restores.push(timeHandlers(extension, extensions, now));
	const began = now();
	try {
		await start();
	} finally {
		for (const restore of restores.reverse()) restore();
	}
	return {
		ms: now() - began,
		steps: STEPS.map(([, , name]) => ({
			name,
			ms: steps.took.get(name) ?? 0,
		})),
		extensions: [...extensions]
			.map(([name, ms]) => ({ name, ms }))
			.sort((a, b) => b.ms - a.ms),
	};
}

/** The line a screen's start says: its steps, what's left, and its slowest extensions. */
export function startLine(parts: StartParts): string {
	const timed = parts.steps.reduce((sum, { ms }) => sum + ms, 0);
	const steps = [
		...parts.steps,
		{ name: "rest", ms: Math.max(0, parts.ms - timed) },
	].map(({ name, ms }) => `${name} ${seconds(ms)}`);
	const handlers = parts.extensions.reduce((sum, { ms }) => sum + ms, 0);
	const slowest = parts.extensions
		.slice(0, SLOWEST)
		.map(({ name, ms }) => `${name} ${seconds(ms)}`);
	const named =
		slowest.length === 0
			? "no extension's handlers ran"
			: `extensions' handlers ${seconds(handlers)}, slowest ${slowest.join(", ")}`;
	return `Screen started in ${seconds(parts.ms)} (${steps.join(", ")}); ${named}`;
}

function seconds(ms: number): string {
	return `${(ms / MS_PER_S).toFixed(1)} s`;
}

/** The steps' times so far, and how many are running, so a nested one counts in its caller. */
interface Steps {
	readonly took: Map<string, number>;
	running: number;
}

/** Wrap one of pi's methods on its own object; the wrap goes again with what this returns. */
function timeMethod(
	target: Record<string, unknown>,
	method: string,
	name: string,
	steps: Steps,
	now: () => number,
): () => void {
	const original = target[method];
	if (typeof original !== "function")
		return () => {
			// Nothing was wrapped, so nothing to put back.
		};
	const own = Object.hasOwn(target, method);
	target[method] = (...args: unknown[]) => {
		const call = (): unknown => Reflect.apply(original, target, args);
		if (steps.running > 0) return call();
		steps.running += 1;
		const done = (): void => {
			steps.running -= 1;
		};
		return settled(() => timed(call, name, steps.took, now), done);
	};
	return () => {
		if (own) target[method] = original;
		else delete target[method];
	};
}

/** Wrap each of an extension's handlers, for every event, keeping the lists they're in. */
function timeHandlers(
	extension: Extension,
	into: Map<string, number>,
	now: () => number,
): () => void {
	const wraps = new Map<unknown, unknown>();
	const wrapOf = new Map<unknown, unknown>();
	const lists: unknown[][] = [];
	for (const list of extension.handlers.values()) {
		if (!Array.isArray(list)) continue;
		lists.push(list);
		// pi's unsubscribe finds its handler by indexOf, so it finds the wrap.
		Object.defineProperty(list, "indexOf", {
			configurable: true,
			writable: true,
			value: (handler: unknown, from?: number) =>
				Array.prototype.indexOf.call(
					list,
					wrapOf.get(handler) ?? handler,
					from,
				),
		});
		list.forEach((handler: unknown, at) => {
			if (typeof handler !== "function") return;
			const wrap = (...args: unknown[]): unknown =>
				timed(
					() => Reflect.apply(handler, undefined, args),
					extension.name,
					into,
					now,
				);
			wraps.set(wrap, handler);
			wrapOf.set(handler, wrap);
			list[at] = wrap;
		});
	}
	// Only the wraps go back, wherever they now stand, so a handler an
	// extension added or took away while the screen started stays so.
	return () => {
		for (const list of lists) {
			Reflect.deleteProperty(list, "indexOf");
			list.forEach((handler: unknown, at) => {
				if (wraps.has(handler)) list[at] = wraps.get(handler);
			});
		}
	};
}

/** Run `work`, adding how long it took, to its settling when it answers a promise, to `name`. */
function timed(
	work: () => unknown,
	name: string,
	into: Map<string, number>,
	now: () => number,
): unknown {
	const began = now();
	const add = (): void => {
		into.set(name, (into.get(name) ?? 0) + now() - began);
	};
	let answer: unknown;
	try {
		answer = work();
	} catch (error) {
		add();
		throw error;
	}
	if (answer instanceof Promise) return answer.finally(add);
	add();
	return answer;
}

/** Run `work`, then `done` once it settles, whether it answers a promise or not. */
function settled(work: () => unknown, done: () => void): unknown {
	let answer: unknown;
	try {
		answer = work();
	} catch (error) {
		done();
		throw error;
	}
	if (answer instanceof Promise) return answer.finally(done);
	done();
	return answer;
}

/** An extension as pi's runner holds it: where it loaded from and its handlers by event. */
interface Extension {
	readonly name: string;
	readonly handlers: Map<unknown, unknown>;
}

/** The extensions pi's runner holds for a runtime's session, named by their folder. */
function extensionsOf(runtime: unknown): Extension[] {
	if (!isRecord(runtime)) return [];
	const session = runtime.session;
	if (!isRecord(session)) return [];
	const runner = session.extensionRunner;
	if (!isRecord(runner) || !Array.isArray(runner.extensions)) return [];
	return runner.extensions.flatMap((extension: unknown) => {
		if (!isRecord(extension)) return [];
		const { path, handlers } = extension;
		if (typeof path !== "string" || !(handlers instanceof Map)) return [];
		return [{ name: nameOf(path), handlers }];
	});
}

/** An extension's name: its folder for an index file, else its file's name. */
function nameOf(path: string): string {
	const file = basename(path);
	return /^index\.[cm]?[jt]s$/.test(file) ? basename(dirname(path)) : file;
}
