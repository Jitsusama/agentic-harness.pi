/**
 * Giving V8's pooled pages back once the host goes quiet. V8 keeps the
 * pages a collection frees and unmaps them only on a memory-reducing
 * collection, which may not come for hours, so a host that served a day
 * of turns holds gigabytes its heap no longer uses (K7's measure: Pss
 * 460 to 940 MB fell to 205 to 240 after one). Once no conversation has
 * started or ended a turn, or parked, for a quiet minute and none is
 * busy, the host runs one last-resort collection, a pause of about a
 * quarter second, and says what it gave back. It runs again only after
 * something stirs.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/** How long nothing may stir before the host collects: K7's quiet minute. */
export const QUIET_MS = 60_000;

/** What runs one collection that gives pooled pages back. */
export type Collect = () => void;

/** What gives the host's pages back once it has been quiet. */
export interface QuietCollection {
	/** A turn started or ended, or a conversation let go: the quiet starts over. */
	stirred(): void;
}

/**
 * Collect once `quietMs` pass with nothing stirring and nothing `busy`.
 * A busy conversation's own end stirs again, so a quiet missed while it
 * ran is waited for once it ends.
 */
export function quietCollection(options: {
	readonly busy: () => boolean;
	readonly collect?: Collect;
	readonly quietMs?: number;
	readonly report?: (said: string) => void;
}): QuietCollection {
	const quietMs = options.quietMs ?? QUIET_MS;
	const collect = options.collect ?? lastResortCollect();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const quiet = () => {
		timer = undefined;
		if (options.busy()) return;
		const before = process.memoryUsage.rss();
		const started = performance.now();
		collect();
		const took = Math.round(performance.now() - started);
		const gave = Math.round((before - process.memoryUsage.rss()) / MB);
		options.report?.(
			`Collected while quiet in ${took} ms, giving back ${gave} MB`,
		);
	};
	return {
		stirred() {
			if (timer) clearTimeout(timer);
			timer = setTimeout(quiet, quietMs);
			// A quiet host may still end: the wait never holds it up.
			timer.unref();
		},
	};
}

const MB = 1024 * 1024;

/**
 * V8's gc, exposed for this process alone, run as a last-resort major
 * collection: the one kind that unmaps its pooled pages.
 */
export function lastResortCollect(): Collect {
	setFlagsFromString("--expose-gc");
	const gc: unknown = runInNewContext("gc");
	if (typeof gc !== "function")
		throw new Error("V8 exposed no gc to collect with");
	return () =>
		gc({ type: "major", execution: "sync", flavor: "last-resort" });
}
