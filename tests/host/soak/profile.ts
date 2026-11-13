/**
 * Where a process's time went, from the CPU profiles node writes under
 * --cpu-prof: each sample's time given to the function it landed in,
 * then summed by area (pi's screen, its engine, its provider code, each
 * harness extension, the host, node itself, garbage collection) and by
 * function, the busiest first. Time spent in node, native code or a
 * package's loader is also given to the nearest caller in pi's code or
 * the harness's, which is who to change. Several profiles, as plain pi
 * writes one a process, sum into one. One profile's time within a
 * stretch of wall time, such as a slow key's wait, sums the same way,
 * its own clock pinned to the wall's by when its process started and
 * ended.
 */
import { isRecord } from "../../../lib/internal/record.ts";

/** Time a profile spent in one place. */
export interface Spent {
	readonly name: string;
	readonly ms: number;
}

/** Where one or more profiles' time went. */
export interface TimeSpent {
	readonly profiles: number;
	/** Sampled time not spent waiting on the event loop. */
	readonly busyMs: number;
	readonly idleMs: number;
	/** The busiest areas, busiest first. */
	readonly areas: readonly Spent[];
	/** The busiest functions, each named with where it is, busiest first. */
	readonly functions: readonly Spent[];
	/** Time in node, native code and other packages, by the nearest caller of pi's or the harness's. */
	readonly calledFrom: readonly Spent[];
}

/** Addresses of pi's own code, installed or in its monorepo. */
const PI_CODE = /@earendil-works\/|\/pi-monorepo\/packages\//;
/** The harness's folders, outside any package and its tests. */
const HARNESS_CODE = /\/(?:extensions|host|lib)\//;
const NOT_HARNESS = /\/node_modules\/|\/tests\//;

/** How many areas and functions a summary names. */
const MOST_AREAS = 20;
const MOST_FUNCTIONS = 30;
const MICROSECONDS_PER_MS = 1000;

/** V8's names for time spent outside any script. */
const IDLE = "(idle)";
const OUTSIDE: Readonly<Record<string, string>> = {
	"(garbage collector)": "garbage collection",
	"(program)": "V8 itself",
	"(root)": "V8 itself",
};

/** How many of a script's last path parts name it. */
const PLACE_PARTS = 3;

/**
 * The area a script's address falls in, first match winning: pi's and
 * other packages by the last node_modules in the path, then the
 * harness's own folders.
 */
const AREAS: readonly (readonly [
	RegExp,
	(found: RegExpExecArray) => string,
])[] = [
	[/\/pi-tui\/|\/packages\/tui\//, () => "screen: pi-tui"],
	[/coding-agent\/dist\/modes\/interactive\//, () => "screen: pi's UI"],
	[/\/@earendil-works\/([^/]+)\//, (found) => `pi: ${found[1]}`],
	[/\/pi-monorepo\/packages\/([^/]+)\//, (found) => `pi: ${found[1]}`],
	[
		/.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//,
		(found) => `package: ${found[1]}`,
	],
	[/\/tests\/host\//, () => "the test's fixture"],
	[/\/extensions\/([^/]+)\//, (found) => `extension: ${found[1]}`],
	[/\/host\/([^/]+)\//, (found) => `host: ${found[1]}`],
	[/\/lib\/(?:internal\/)?([^/.]+)/, (found) => `lib: ${found[1]}`],
	[/^node:/, () => "node"],
];

/** A stretch of wall time, in ms since the epoch, both ends in it. */
export interface Stretch {
	readonly from: number;
	readonly to: number;
}

/** When a profile's process started and ended by the wall clock, in ms since the epoch. */
export interface Pinned {
	readonly startedAt: number;
	readonly endedAt: number;
}

/** How many areas and functions a stretch's summary names. */
const MOST_WITHIN = 8;

/** Where the time went in `profiles`, each a parsed .cpuprofile. */
export function timeSpent(profiles: readonly unknown[]): TimeSpent {
	const read = profiles.flatMap((profile) => {
		const sampled = samplesOf(profile);
		return sampled === undefined ? [] : [sampled];
	});
	return summed(read, MOST_AREAS, MOST_FUNCTIONS);
}

/**
 * Where `profile`'s time went within `stretch` of wall time. V8 counts
 * a profile's time from a start of its own, so its start and end are
 * laid on when its process started and ended by the wall, and each
 * sample between them in proportion. A profile without both ends
 * counts as none read.
 */
export function timeSpentWithin(
	profile: unknown,
	pinned: Pinned,
	stretch: Stretch,
): TimeSpent {
	const sampled = samplesOf(profile);
	const span = spanOf(profile);
	if (sampled === undefined || span === undefined)
		return summed([], MOST_WITHIN, MOST_WITHIN);
	const scale =
		(pinned.endedAt - pinned.startedAt) / (span.endTime - span.startTime);
	const wallOf = (atUs: number) =>
		pinned.startedAt + (atUs - span.startTime) * scale;
	const inside = sampled.filter((one) => {
		const at = wallOf(one.atUs);
		return at >= stretch.from && at <= stretch.to;
	});
	return summed([inside], MOST_WITHIN, MOST_WITHIN);
}

/** The profile among `profiles` that ran longest, as a host's own does beside its children's. */
export function longestLived(profiles: readonly unknown[]): unknown {
	let longest: unknown;
	let most = -1;
	for (const profile of profiles) {
		const span = spanOf(profile);
		if (span === undefined) continue;
		const lasted = span.endTime - span.startTime;
		if (lasted <= most) continue;
		most = lasted;
		longest = profile;
	}
	return longest;
}

/** A profile's own start and end, in µs, when it says both and they differ. */
function spanOf(
	profile: unknown,
): { readonly startTime: number; readonly endTime: number } | undefined {
	if (!isRecord(profile)) return undefined;
	const { startTime, endTime } = profile;
	if (typeof startTime !== "number" || typeof endTime !== "number")
		return undefined;
	return endTime > startTime ? { startTime, endTime } : undefined;
}

/** The time in each list of samples, one list a profile read, summed into one summary. */
function summed(
	read: readonly (readonly Sample[])[],
	mostAreas: number,
	mostFunctions: number,
): TimeSpent {
	const areas = new Map<string, number>();
	const functions = new Map<string, number>();
	const callers = new Map<string, number>();
	let busy = 0;
	let idle = 0;
	for (const sampled of read) {
		for (const { frame, owner, ms } of sampled) {
			if (frame.functionName === IDLE) {
				idle += ms;
				continue;
			}
			busy += ms;
			const area = areaOf(frame);
			areas.set(area, (areas.get(area) ?? 0) + ms);
			const name = `${frame.functionName || "(anonymous)"} ${placeOf(frame)}`;
			functions.set(name, (functions.get(name) ?? 0) + ms);
			if (owner === undefined || owner === frame) continue;
			const caller = `${owner.functionName || "(anonymous)"} ${placeOf(owner)}`;
			callers.set(caller, (callers.get(caller) ?? 0) + ms);
		}
	}
	return {
		profiles: read.length,
		busyMs: Math.round(busy),
		idleMs: Math.round(idle),
		areas: busiest(areas, mostAreas),
		functions: busiest(functions, mostFunctions),
		calledFrom: busiest(callers, mostFunctions),
	};
}

/** A sampled script location. */
interface Frame {
	readonly functionName: string;
	readonly url: string;
	readonly lineNumber: number;
}

/** One sample: where it landed, its nearest owned frame, when, and its time. */
interface Sample {
	readonly frame: Frame;
	readonly owner?: Frame;
	/** When it was taken on the profile's own clock, in µs. */
	readonly atUs: number;
	readonly ms: number;
}

/**
 * Each of a profile's samples with the time it stands for: V8 gives
 * each sample the gap to the next, as DevTools reads it, and the last
 * the gap before it. A sample is taken its own gap after the one before,
 * the first after the profile's start.
 */
function samplesOf(profile: unknown): Sample[] | undefined {
	if (!isRecord(profile)) return undefined;
	const { nodes, samples, timeDeltas } = profile;
	if (!Array.isArray(nodes) || !Array.isArray(samples)) return undefined;
	if (!Array.isArray(timeDeltas)) return undefined;
	const frames = new Map<unknown, Frame>();
	const parents = new Map<unknown, unknown>();
	for (const node of nodes) {
		if (!isRecord(node) || !isRecord(node.callFrame)) continue;
		const { functionName, url, lineNumber } = node.callFrame;
		frames.set(node.id, {
			functionName: typeof functionName === "string" ? functionName : "",
			url: typeof url === "string" ? url : "",
			lineNumber: typeof lineNumber === "number" ? lineNumber : 0,
		});
		if (Array.isArray(node.children))
			for (const child of node.children) parents.set(child, node.id);
	}
	const owners = new Map<unknown, Frame | undefined>();
	const ownerOf = (id: unknown): Frame | undefined => {
		if (owners.has(id)) return owners.get(id);
		const frame = frames.get(id);
		const owner =
			frame !== undefined && owned(frame.url)
				? frame
				: parents.has(id)
					? ownerOf(parents.get(id))
					: undefined;
		owners.set(id, owner);
		return owner;
	};
	const found: Sample[] = [];
	let atUs = typeof profile.startTime === "number" ? profile.startTime : 0;
	for (const [at, id] of samples.entries()) {
		const since = timeDeltas[at];
		if (typeof since === "number") atUs += since;
		const frame = frames.get(id);
		const gap = timeDeltas[at + 1] ?? since;
		if (frame === undefined || typeof gap !== "number") continue;
		const ms = Math.max(0, gap) / MICROSECONDS_PER_MS;
		const owner = OUTSIDE[frame.functionName] ? undefined : ownerOf(id);
		found.push({ frame, atUs, ms, ...(owner ? { owner } : {}) });
	}
	return found;
}

/** Whether `url` is pi's code or the harness's, which a change can reach. */
function owned(url: string): boolean {
	if (PI_CODE.test(url)) return true;
	return HARNESS_CODE.test(url) && !NOT_HARNESS.test(url);
}

/** The area `frame` is in, by its script's address. */
function areaOf(frame: Frame): string {
	const outside = OUTSIDE[frame.functionName];
	if (frame.url === "" && outside !== undefined) return outside;
	for (const [pattern, name] of AREAS) {
		const found = pattern.exec(frame.url);
		if (found) return name(found);
	}
	return frame.url === "" ? "native" : "other";
}

/** A frame's script by its last few path parts, with its line. */
function placeOf(frame: Frame): string {
	const short = frame.url.split("/").slice(-PLACE_PARTS).join("/");
	return `${short}:${frame.lineNumber + 1}`;
}

/** The `most` largest of `spent`, largest first, in whole ms. */
function busiest(spent: ReadonlyMap<string, number>, most: number): Spent[] {
	return [...spent.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, most)
		.map(([name, ms]) => ({ name, ms: Math.round(ms) }));
}
