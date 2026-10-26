/**
 * Where a slow stretch of page activity actually went.
 *
 * A long task tells you three seconds disappeared. It does not
 * tell you whether that was a JSON parse of ten megabytes, a
 * regular expression over the whole document, or a hundred awaits
 * in a row, and those have nothing in common except the symptom.
 *
 * A sampling profile answers it. The engine interrupts itself
 * every so often and writes down which function it was in, so
 * counting samples per function is counting time per function.
 * That is an estimate by construction: a function that never
 * happens to be running at a sample is invisible, which is why
 * the sampled total is reported alongside the shares rather than
 * left for a reader to assume it covers everything.
 */

/** One function in a sampling profile, as the protocol sends it. */
export interface RawProfileNode {
	readonly id: number;
	readonly callFrame: {
		readonly functionName: string;
		readonly url: string;
		readonly lineNumber: number;
	};
	readonly children?: readonly number[];
}

/** A sampling profile as the protocol sends it. */
export interface RawProfile {
	readonly nodes: readonly RawProfileNode[];
	readonly startTime: number;
	readonly endTime: number;
	readonly samples?: readonly number[];
	readonly timeDeltas?: readonly number[];
}

/** One function and the time that landed in it. */
export interface Hotspot {
	readonly function: string;
	readonly url: string;
	readonly line: number;
	/** Milliseconds sampled inside this function itself. */
	readonly selfMs: number;
	/** Its share of the sampled time, from zero to one. */
	readonly share: number;
}

/** What the profile says about where the time went. */
export interface Hotspots {
	readonly hotspots: readonly Hotspot[];
	readonly sampledMs: number;
}

/** How many functions are worth naming before it is a data dump. */
const TOP = 20;

/**
 * A name for a function that has none.
 *
 * The url and line still identify it exactly, so the name only
 * has to be something a reader can recognise as "not missing,
 * genuinely anonymous".
 */
const ANONYMOUS = "(anonymous)";

/** Attribute the sampled time to the functions it landed in. */
export function foldProfile(profile: RawProfile): Hotspots {
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));

	// Microseconds, summed per node, then converted once at the end
	// so the rounding happens in one place.
	const spent = new Map<number, number>();
	let total = 0;
	for (let at = 0; at < samples.length; at += 1) {
		const id = samples[at];
		if (id === undefined) continue;
		// Each delta is the gap before its sample, and is charged to
		// that sample. Charging it to the previous one instead is the
		// other defensible reading, and over a run of samples the two
		// differ by a single interval; what is not defensible is
		// dropping the first, which loses real time and inflates every
		// share computed from the remainder.
		const micros = deltas[at] ?? 0;
		spent.set(id, (spent.get(id) ?? 0) + micros);
		total += micros;
	}

	const hotspots: Hotspot[] = [];
	for (const [id, micros] of spent) {
		const node = byId.get(id);
		if (node === undefined) continue;
		const named = node.callFrame.functionName;
		hotspots.push({
			function: named === "" ? ANONYMOUS : named,
			url: node.callFrame.url,
			line: node.callFrame.lineNumber,
			selfMs: micros / 1000,
			share: total === 0 ? 0 : micros / total,
		});
	}

	hotspots.sort((one, other) => other.selfMs - one.selfMs);
	return { hotspots: hotspots.slice(0, TOP), sampledMs: total / 1000 };
}

/** Say where the time went. */
export function renderHotspots(folded: Hotspots): string {
	if (folded.hotspots.length === 0 || folded.sampledMs === 0) {
		// An idle page profiles to nothing, and that is an answer.
		// Reporting it as an empty list would read as a failure to
		// measure rather than as nothing to measure.
		return (
			"No JavaScript ran while the profiler was on. Either nothing " +
			"was happening, or whatever you meant to profile finished " +
			"before it started."
		);
	}

	const lines = folded.hotspots.map((spot) => {
		const share = `${Math.round(spot.share * 100)}%`;
		const where =
			spot.url === "" ? "the engine" : `${spot.url}:${spot.line + 1}`;
		return `  ${spot.selfMs.toFixed(1)}ms (${share})  ${spot.function}  ${where}`;
	});

	return [
		// Not "of JavaScript": the engine reports idle time as a
		// function of its own, and a window that was mostly idle would
		// otherwise be announced as that many milliseconds of work.
		// Idle is left in rather than filtered, because knowing the
		// page was doing nothing for most of the window is the answer
		// when you profiled the wrong moment.
		`${folded.sampledMs.toFixed(0)}ms sampled, by function:`,
		...lines,
		"",
		// Saying what the numbers are worth, because a sampled figure
		// read as an exact one sends people optimising noise.
		"Sampled, so these are estimates: a function that was never " +
			"running at a sample does not appear at all.",
	].join("\n");
}
