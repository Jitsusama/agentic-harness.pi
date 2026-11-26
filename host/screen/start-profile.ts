/**
 * A CPU profile of a hosted screen's start, now and then, said as whose
 * code the host's thread ran while it went. The start line says how
 * busy the thread was and what each extension's handlers held it, but
 * that hold is a floor: on 25 November the handlers held 9% of the
 * starts' time while the thread was busy 89% of it, and nothing could
 * say whose the rest was. The thread's samples can: each falls in code
 * whose file names its owner, an extension of this package, the
 * harness's own library or host, pi, Node, or a package beside them.
 *
 * The thread is the host's, so its samples count every conversation on
 * it, not only the one starting: which is the question, since a start
 * is slow when the thread is busy. Profiling slows the thread a little
 * while it samples, so it profiles one start at a time, at most once in
 * `every`, and keeps the newest few profiles for a closer look in a
 * browser's profiler. A child host runs one conversation in a process of
 * its own, so the last profile is read from the folder its realm's hosts
 * share, not only from memory: otherwise every child's start would be.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** How long after one start's profile the next may be taken, in ms. */
const EVERY_MS = 10 * 60_000;

/** How often the profiler samples the thread, in microseconds. */
const SAMPLE_US = 1000;

/** How many owners the line names, busiest first. */
const OWNERS_SAID = 6;

/** How many profiles the folder keeps, the newest. */
const KEPT = 5;

/** The largest profile kept, in bytes. */
const MOST_BYTES = 16 * 1024 * 1024;

const MS_PER_S = 1000;
const US_PER_MS = 1000;

/** The harness's top folder, which this file sits two below. */
const HARNESS = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** What V8's profiler says a sample's frame is, as much as is read here. */
interface Frame {
	readonly functionName: string;
	readonly url: string;
}

/** A V8 CPU profile, as much of it as is read here. */
export interface Profile {
	readonly nodes: readonly { readonly id: number; readonly callFrame: Frame }[];
	readonly samples?: readonly number[];
	readonly timeDeltas?: readonly number[];
}

/** How a start profiler is told where and how often. */
export interface StartProfilerOptions {
	/** The folder profiles are kept in, made if it is missing. */
	readonly folder: string;
	/** How long after one profile the next may be taken, in ms; EVERY_MS by default. */
	readonly every?: number;
	readonly now?: () => number;
}

/**
 * Runs a start, profiled when no other is and the last was long enough
 * ago, answering the line to say of it, or undefined when it went
 * unprofiled. A profiler that fails says so in the line; the start's own
 * failure is the start's, thrown as it was.
 */
export type StartProfiler = (start: () => Promise<void>) => Promise<{
	readonly line: string | undefined;
}>;

/** A profiler for screens' starts, keeping what it takes under `folder`. */
export function startProfiler(options: StartProfilerOptions): StartProfiler {
	const every = options.every ?? EVERY_MS;
	const now = options.now ?? (() => Date.now());
	let last: number | undefined;
	let running = false;
	return async (start) => {
		const at = now();
		const recent = (when: number | undefined) =>
			when !== undefined && at - when < every;
		if (running || recent(last)) {
			await start();
			return { line: undefined };
		}
		running = true;
		try {
			const kept = await newest(options.folder).then(
				(when) => ({ when }),
				(error: unknown) => ({ error }),
			);
			if ("error" in kept) {
				// Not asked again until `every` has passed, so a folder it
				// can't read is said once in that time, not at every start.
				last = at;
				await start();
				return {
					line: `Screen start not profiled: couldn't read its folder: ${failure(kept.error)}`,
				};
			}
			if (recent(kept.when)) {
				last = kept.when;
				await start();
				return { line: undefined };
			}
			last = at;
			return await profiled(start, options.folder);
		} finally {
			running = false;
		}
	};
}

/** When the folder's newest profile was kept, in ms; undefined when it keeps none. */
async function newest(folder: string): Promise<number | undefined> {
	const names = await readdir(folder).catch((error: unknown) => {
		// A folder not made yet keeps no profile; anything else is a fault.
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	});
	const last = profilesIn(names).at(-1);
	if (last === undefined) return undefined;
	return (await stat(join(folder, last))).mtimeMs;
}

/** The profiles among a folder's names, oldest first, as their names sort. */
function profilesIn(names: readonly string[]): string[] {
	return names
		.filter((name) => name.startsWith("start-") && name.endsWith(".cpuprofile"))
		.sort();
}

/** Run `start` with the thread sampled, answering what the samples say. */
async function profiled(
	start: () => Promise<void>,
	folder: string,
): Promise<{ line: string | undefined }> {
	const session = new Session();
	try {
		session.connect();
		await session.post("Profiler.enable");
		await session.post("Profiler.setSamplingInterval", {
			interval: SAMPLE_US,
		});
		await session.post("Profiler.start");
	} catch (error) {
		// Only ever a reading: the start goes on unprofiled, and says why.
		session.disconnect();
		await start();
		return { line: `Screen start not profiled: ${failure(error)}` };
	}
	let line: string;
	try {
		await start();
	} finally {
		// The start's own outcome stands, whatever the profiler does.
		line = await stopped(session, folder).catch(
			(error: unknown) => `Screen start not profiled: ${failure(error)}`,
		);
		session.disconnect();
	}
	return { line };
}

/** Stop sampling, keep the profile, and say whose code the samples fell in. */
async function stopped(session: Session, folder: string): Promise<string> {
	const { profile } = await session.post("Profiler.stop");
	await session.post("Profiler.disable");
	const said = `Screen start profiled: the thread's time went to ${ownersLine(profile)}`;
	try {
		return `${said}; kept in ${await kept(profile, folder)}`;
	} catch (error) {
		return `${said}; not kept: ${failure(error)}`;
	}
}

/** Whose code the samples fell in, busiest first, each with its time. */
export function ownersLine(profile: Profile): string {
	const owned = ownersOf(profile);
	const total = [...owned.values()].reduce((sum, us) => sum + us, 0);
	if (total === 0) return "nothing, since no sample was taken";
	const said = [...owned]
		.sort((a, b) => b[1] - a[1])
		.slice(0, OWNERS_SAID)
		.map(([owner, us]) => `${owner} ${seconds(us)}`);
	return `${said.join(", ")}, of ${seconds(total)}`;
}

/** Each owner's share of the samples' time, in microseconds. */
function ownersOf(profile: Profile): Map<string, number> {
	const frames = new Map(
		profile.nodes.map((node) => [node.id, node.callFrame]),
	);
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	const owned = new Map<string, number>();
	samples.forEach((id, at) => {
		const frame = frames.get(id);
		if (frame === undefined) return;
		const owner = ownerOf(frame);
		// A sample's delta is the time since the one before it, so the
		// first sample's covers nothing of the start's own.
		owned.set(owner, (owned.get(owner) ?? 0) + Math.max(0, deltas[at] ?? 0));
	});
	return owned;
}

/** The pseudo frames V8 samples, by what the line calls them. */
const PSEUDO: Readonly<Record<string, string>> = {
	"(idle)": "idle",
	"(garbage collector)": "garbage collection",
	"(program)": "native code",
	"(root)": "native code",
};

/** Whose code a frame runs, read from its file. */
export function ownerOf(frame: Frame): string {
	const pseudo = PSEUDO[frame.functionName];
	if (frame.url === "") return pseudo ?? "native code";
	if (frame.url.startsWith("node:")) return "node";
	const path = frame.url.startsWith("file:")
		? fileURLToPath(frame.url)
		: frame.url;
	const modules = path.lastIndexOf(`${sep}node_modules${sep}`);
	if (modules >= 0) return packageOf(path.slice(modules));
	if (path.startsWith(`${HARNESS}${sep}`)) {
		const [top, next] = path.slice(HARNESS.length + 1).split(sep);
		if ((top === "extensions" || top === "packs") && next !== undefined)
			return next;
		return `the harness's ${top}`;
	}
	return "other";
}

/** The package a path under node_modules is in, pi's own said as pi. */
function packageOf(underModules: string): string {
	const [, , scope, name] = underModules.split(sep);
	const named = scope?.startsWith("@") ? `${scope}/${name}` : scope;
	if (named === undefined) return "other";
	return named === "pi-monorepo" || named.startsWith("@earendil-works/")
		? "pi"
		: named;
}

/** Keep a profile in the folder, the newest few, answering where. */
async function kept(profile: Profile, folder: string): Promise<string> {
	const text = JSON.stringify(profile);
	if (Buffer.byteLength(text) > MOST_BYTES)
		throw new Error(`at ${Math.round(text.length / 1024)} KB it is too large`);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	const name = `start-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`;
	const file = join(folder, name);
	await writeFile(file, text, { mode: 0o600, flag: "wx" });
	const older = profilesIn(await readdir(folder))
		.reverse()
		.slice(KEPT)
		.filter((one) => one !== name);
	await Promise.all(older.map((one) => rm(join(folder, one), { force: true })));
	return file;
}

function seconds(us: number): string {
	return `${(us / US_PER_MS / MS_PER_S).toFixed(1)} s`;
}

function failure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
