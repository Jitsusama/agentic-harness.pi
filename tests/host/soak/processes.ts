/**
 * What a child process a conversation would cost, measured on plain pi:
 * how long each took from its start to answering a state request, all
 * started at once, and what each weighed then and once its turns were
 * done, read from the kernel's rollup of its mappings. Item 7's
 * child-per-conversation design is judged on these.
 */
import { type Extent, extentOf } from "./report.ts";

/** A process's weight, from its rollup, in kB. */
export interface Weight {
	readonly pssKb: number;
	readonly rssKb: number;
}

/** One plain pi's start and weighings; a weighing it missed is left out. */
export interface PlainProcess {
	readonly readyMs: number;
	readonly ready?: Weight;
	readonly done?: Weight;
}

/** Every plain pi's start and weight, spread. */
export interface PlainProcesses {
	readonly started: number;
	readonly readyMs: Extent;
	readonly pssReadyKb: Extent;
	readonly rssReadyKb: Extent;
	readonly pssDoneKb: Extent;
	readonly rssDoneKb: Extent;
	/** Weighings that found no rollup, as when the process had gone. */
	readonly unread: number;
}

/** Reads `Pss` and `Rss` from `/proc/<pid>/smaps_rollup`'s text. */
export function rollupOf(text: string): Weight | undefined {
	const kb = (field: string): number | undefined => {
		const found = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(text);
		return found?.[1] === undefined ? undefined : Number(found[1]);
	};
	const pssKb = kb("Pss");
	const rssKb = kb("Rss");
	return pssKb === undefined || rssKb === undefined
		? undefined
		: { pssKb, rssKb };
}

/** Spreads each plain pi's start and weight, counting weighings unread. */
export function plainProcessesOf(
	processes: readonly PlainProcess[],
): PlainProcesses {
	const ready = processes.flatMap((p) => (p.ready ? [p.ready] : []));
	const done = processes.flatMap((p) => (p.done ? [p.done] : []));
	return {
		started: processes.length,
		readyMs: extentOf(processes.map((p) => p.readyMs)),
		pssReadyKb: extentOf(ready.map((w) => w.pssKb)),
		rssReadyKb: extentOf(ready.map((w) => w.rssKb)),
		pssDoneKb: extentOf(done.map((w) => w.pssKb)),
		rssDoneKb: extentOf(done.map((w) => w.rssKb)),
		unread: 2 * processes.length - ready.length - done.length,
	};
}
