/**
 * How a host's stop ends: how long it may park, within the stop limit its
 * unit names, and what it notes when that time runs out with conversations
 * still unparked, so the journal names them and the next start says so
 * beside each one's resume.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { type HostKind, hostKey } from "./address.ts";

const MICROSECONDS_PER_MS = 1000;

/**
 * How long a stop may take before the host ends anyway, naming what hadn't
 * parked, when its unit names no stop limit: inside systemd's default 60 s
 * stop timeout, so the next host starts from what parked rather than from a
 * kill. A park awaits each conversation's work ending, and on 14 November
 * one awaited a model request for more than the minute, so systemd killed
 * the host with every conversation unparked.
 */
const STOP_WITHIN_MS = 45_000;

/**
 * The share of its unit's stop limit a stop may park for. The rest is the
 * margin a busy loop needs to notice its own limit came and write down what
 * it left: at 03:30 on 17 November a loop busy 35 s of the first 50 came
 * to its 45 s too late, and systemd's 60 s killed it first.
 */
const STOP_SHARE = 3 / 4;

/**
 * The longest a Node timer waits: past it setTimeout fires at once, so a
 * limit of systemd's infinity would end a stop with nothing parked.
 */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** The file, in a host's own state folder, naming what its stop left unparked. */
const UNPARKED = "not-parked.json";

/**
 * How long, in ms, a stop may park before the host ends: three quarters of
 * the stop limit its unit names in PI_HOST_STOP_USEC, so the host ends and
 * says what it left before systemd kills it, else STOP_WITHIN_MS. It is
 * whole milliseconds, and never longer than a timer can wait.
 */
export function stopWithin(env: NodeJS.ProcessEnv): number {
	const limit = Number(env.PI_HOST_STOP_USEC);
	if (!env.PI_HOST_STOP_USEC || !Number.isFinite(limit) || limit <= 0)
		return STOP_WITHIN_MS;
	return Math.min(
		Math.floor((limit / MICROSECONDS_PER_MS) * STOP_SHARE),
		LONGEST_TIMER_MS,
	);
}

/** How long, in ms, a stop's backstop waits before ending the host. */
export function stopBackstop(_env: NodeJS.ProcessEnv): number {
	return 0;
}

/**
 * Settle as `work` does, or once `ms` have passed, telling `late` how long
 * that really took, since a busy loop comes to its bound late; a failure
 * of `work` past then is the stop's own and is let go.
 */
export function endWithin(
	work: Promise<void>,
	ms: number,
	late: (waited: number) => void,
): Promise<void> {
	const began = performance.now();
	let timer: NodeJS.Timeout | undefined;
	const bound = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			late(Math.round(performance.now() - began));
			resolve();
		}, ms);
		timer.unref();
	});
	// Past the bound the host ends anyway; what the stop says then is moot.
	work.catch(() => {});
	return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

/**
 * Say that a stop bound to `bound` ms ends after `waited` with the
 * conversations still `held` unparked, by id, so a late loop shows and the
 * next host's resume of each can be laid beside it.
 */
export function unparkedLine(
	bound: number,
	waited: number,
	held: readonly { readonly id: string }[],
): string {
	const ids = held.map(({ id }) => id).join(", ");
	return `stopping after ${waited} ms, past its ${bound} ms bound, ${held.length} not parked: ${ids}`;
}

/** The conversations a stop ended with unparked, and when. */
export interface UnparkedMark {
	readonly at: number;
	readonly ids: readonly string[];
}

/**
 * Where a host notes which conversations its stop left unparked, so its
 * next start says so beside each one's resume: a slow resume after a
 * cut-off turn then reads apart from one slow for its own reasons.
 */
export function unparkedMarks(
	realm: string,
	kind: HostKind,
	report: (error: unknown) => void,
): {
	read(): UnparkedMark | undefined;
	write(ids: readonly string[]): void;
	clear(): void;
} {
	const file = join(stateDir("host-service"), hostKey(realm, kind), UNPARKED);
	return {
		read() {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				// No mark: the last stop parked everything, or there was none.
				return undefined;
			}
			try {
				const mark: unknown = JSON.parse(text);
				if (
					isRecord(mark) &&
					typeof mark.at === "number" &&
					Array.isArray(mark.ids)
				)
					return {
						at: mark.at,
						ids: mark.ids.filter((id) => typeof id === "string"),
					};
			} catch (error) {
				report(error);
			}
			return undefined;
		},
		write(ids) {
			try {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, JSON.stringify({ at: Date.now(), ids }));
			} catch (error) {
				// The journal's line already names them; only the next start's
				// note is lost.
				report(error);
			}
		},
		clear() {
			try {
				rmSync(file, { force: true });
			} catch (error) {
				report(error);
			}
		},
	};
}
