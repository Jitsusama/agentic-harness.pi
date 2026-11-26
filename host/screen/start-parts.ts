/**
 * Where a hosted screen's start goes: the steps of pi's InteractiveMode
 * init (waiting for the terminal's colours, binding the extensions,
 * drawing the conversation, counting providers) and the time each
 * extension's handlers take while it runs, said as one line. A wake's
 * "screen" phase is this start, and it is the largest part of a wake a
 * warm spare can't pay ahead, so this names what in it to cut. It wraps
 * pi's private methods only while the start runs, and puts them back
 * after, so nothing outlives it; a pi without one of them says that step
 * "untimed", its time falling in "rest". A step one of them calls (bind counts
 * the providers itself) is counted in the step that called it, so the
 * steps and "rest" sum to the whole; an extension's time is the part of
 * its step its handlers took.
 *
 * A handler's time runs to its promise's settling, so it counts waiting:
 * on the disk, a child, or the other conversations a host runs on the
 * same thread. Two readings tell waiting from work. How busy the thread
 * was over the start says whether it was starved; what each extension
 * held it, its handlers' synchronous runs, is the cost truly its own. That
 * is a floor: what a handler runs after its first await isn't seen.
 */

import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "../../lib/internal/record.ts";

/** How many of the extensions that held the thread most the line names. */
const HOLDING_MOST = 5;
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

/** An extension's time, and how much of it its handlers held the thread. */
export interface Held extends Part {
	readonly heldMs: number;
	/** A handler of it was still running when the start ended, so `ms` is its time so far. */
	readonly running?: true;
}

/** The thread's busy and idle time so far, as `performance.eventLoopUtilization` reads it. */
export interface Utilization {
	readonly active: number;
	readonly idle: number;
}

/** One of pi's start steps: its time, or undefined where this pi had no such step to time. */
export interface Step {
	readonly name: string;
	readonly ms: number | undefined;
}

/** What a screen's start took, whole and in parts. */
export interface StartParts {
	readonly ms: number;
	readonly steps: readonly Step[];
	/** Each extension whose handlers ran during the start, longest to settle first. */
	readonly extensions: readonly Held[];
	/** The share of the start the thread was busy, 0 to 1, or undefined where it couldn't be read. */
	readonly busy?: number | undefined;
}

/** A screen's start, timed while `start` runs; each wrap is put back once it settles. */
export async function timeStart(
	mode: object,
	runtime: unknown,
	start: () => Promise<void>,
	now: () => number = () => performance.now(),
	utilization: () => Utilization = () => performance.eventLoopUtilization(),
): Promise<StartParts> {
	const steps: Steps = { took: new Map(), running: 0 };
	const wrapped = new Set<string>();
	const extensions = new Map<string, Took>();
	const restores: (() => void)[] = [];
	const putBack = (): void => {
		for (const restore of restores.splice(0).reverse()) restore();
	};
	try {
		for (const [owner, method, name] of STEPS) {
			const target = owner === undefined ? mode : Reflect.get(mode, owner);
			if (!isRecord(target)) continue;
			const restore = timeMethod(target, method, name, steps, now);
			if (restore === undefined) continue;
			restores.push(restore);
			wrapped.add(name);
		}
		for (const extension of extensionsOf(runtime))
			restores.push(timeHandlers(extension, extensions, now));
	} catch {
		// Timing is only ever a reading: a pi it can't wrap starts untimed, as it would without it.
		putBack();
		wrapped.clear();
		extensions.clear();
	}
	const began = now();
	const before = readUtilization(utilization);
	try {
		await start();
	} finally {
		putBack();
	}
	return {
		ms: now() - began,
		busy: busyShare(before, readUtilization(utilization)),
		steps: STEPS.map(([, , name]) => ({
			name,
			ms: wrapped.has(name) ? (steps.took.get(name) ?? 0) : undefined,
		})),
		extensions: [...extensions]
			.map(([name, took]) => heldSoFar(name, took, now()))
			.sort((a, b) => b.ms - a.ms),
	};
}

/** An extension's time as the start ends, a handler still running counted up to `at`. */
function heldSoFar(name: string, took: Took, at: number): Held {
	const { ms, heldMs, running } = took;
	if (running.size === 0) return { name, ms, heldMs };
	const soFar = [...running.values()].reduce(
		(sum, began) => sum + at - began,
		0,
	);
	return { name, ms: ms + soFar, heldMs, running: true };
}

/** The thread's reading, or undefined where this Node can't give one. */
function readUtilization(
	utilization: () => Utilization,
): Utilization | undefined {
	try {
		return utilization();
	} catch {
		// Only ever a reading: a start it can't take says no share.
		return undefined;
	}
}

/** The share of the time between two readings the thread was busy. */
function busyShare(
	before: Utilization | undefined,
	after: Utilization | undefined,
): number | undefined {
	if (before === undefined || after === undefined) return undefined;
	const active = after.active - before.active;
	const whole = active + after.idle - before.idle;
	return whole > 0 ? active / whole : undefined;
}

/** The line a screen's start says: its steps, what's left, and the extensions that held its thread most. */
export function startLine(parts: StartParts): string {
	const timed = parts.steps.reduce((sum, { ms }) => sum + (ms ?? 0), 0);
	const steps = [
		...parts.steps,
		{ name: "rest", ms: Math.max(0, parts.ms - timed) },
	].map(
		({ name, ms }) =>
			`${name} ${ms === undefined ? UNTIMED_SAID : seconds(ms)}`,
	);
	const handlers = parts.extensions.reduce((sum, { ms }) => sum + ms, 0);
	const held = parts.extensions.reduce((sum, { heldMs }) => sum + heldMs, 0);
	// What an extension held is its own cost; what it took to settle
	// counts the other conversations on the thread too, so it only breaks ties.
	const holding = [...parts.extensions]
		.sort((a, b) => b.heldMs - a.heldMs || b.ms - a.ms)
		.slice(0, HOLDING_MOST)
		.map(
			({ name, ms, heldMs, running }) =>
				`${name} ${seconds(ms)}${running ? " so far, still running" : ""} (held ${seconds(heldMs)})`,
		);
	const named =
		holding.length === 0
			? "no extension's handlers ran"
			: `extensions' handlers ${seconds(handlers)} (held ${seconds(held)}), holding most ${holding.join(", ")}`;
	const busy =
		parts.busy === undefined
			? ""
			: `; the thread busy ${Math.round(parts.busy * PERCENT)}% of it`;
	return `Screen started in ${seconds(parts.ms)} (${steps.join(", ")})${busy}; ${named}`;
}

const PERCENT = 100;

/** What the line says of a step this pi lacks, so it never reads as a fast one. */
const UNTIMED_SAID = "untimed";

function seconds(ms: number): string {
	return `${(ms / MS_PER_S).toFixed(1)} s`;
}

/** The steps' times so far, and how many are running, so a nested one counts in its caller. */
interface Steps {
	readonly took: Map<string, number>;
	running: number;
}

/** Wrap one of pi's methods on its own object; the wrap goes again with what this returns, or undefined where there is none. */
function timeMethod(
	target: Record<string, unknown>,
	method: string,
	name: string,
	steps: Steps,
	now: () => number,
): (() => void) | undefined {
	const original = target[method];
	if (typeof original !== "function") return undefined;
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
	into: Map<string, Took>,
	now: () => number,
): () => void {
	const wraps = new Map<unknown, unknown>();
	const lists: unknown[][] = [];
	// Only the wraps go back, wherever they now stand, so a handler an
	// extension added or took away while the screen started stays so.
	const restore = (): void => {
		for (const list of lists) {
			Reflect.deleteProperty(list, "indexOf");
			list.forEach((handler: unknown, at) => {
				if (wraps.has(handler)) list[at] = wraps.get(handler);
			});
		}
	};
	try {
		for (const list of extension.handlers.values())
			if (Array.isArray(list)) wrapList(list);
	} catch (error) {
		// What was wrapped before the throw goes back before the caller hears of it.
		restore();
		throw error;
	}
	return restore;

	function wrapList(list: unknown[]): void {
		// Each list keeps its own, so a handler in two finds its wrap in each.
		const wrapOf = new Map<unknown, unknown>();
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
				timedHandler(
					() => Reflect.apply(handler, undefined, args),
					tookBy(into, extension.name),
					now,
				);
			wraps.set(wrap, handler);
			wrapOf.set(handler, wrap);
			list[at] = wrap;
		});
	}
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

/** An extension's time so far, what of it its handlers held the thread, and when each still running began. */
interface Took {
	ms: number;
	heldMs: number;
	readonly running: Map<object, number>;
}

/** `name`'s time in `into`, made at nothing where it has none yet. */
function tookBy(into: Map<string, Took>, name: string): Took {
	const had = into.get(name);
	if (had !== undefined) return had;
	const took = { ms: 0, heldMs: 0, running: new Map<object, number>() };
	into.set(name, took);
	return took;
}

/** Run a handler, adding to `took` how long it held the thread, and how long it took to settle. */
function timedHandler(
	work: () => unknown,
	took: Took,
	now: () => number,
): unknown {
	const began = now();
	const add = (): void => {
		took.ms += now() - began;
	};
	let answer: unknown;
	try {
		answer = work();
	} catch (error) {
		took.heldMs += now() - began;
		add();
		throw error;
	}
	took.heldMs += now() - began;
	if (!(answer instanceof Promise)) {
		add();
		return answer;
	}
	// Two handlers can begin at the same instant, so each keeps a key of its own.
	const key = {};
	took.running.set(key, began);
	return answer.finally(() => {
		took.running.delete(key);
		add();
	});
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
