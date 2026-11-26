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
 * while it samples, so it profiles one start at a time, at most one in
 * each window of `every`, and samples for at most `most`. A child host
 * runs one conversation in a process of its own, so a window is claimed
 * by a file the realm's hosts share, made only if it is missing: the
 * first start to make it is profiled, and every other start in that
 * window, in any of their processes, is not. The newest few profiles
 * are kept for a closer look in a browser's profiler.
 *
 * Only the sampling is the start's: the claim waits at most CLAIM_MS
 * before it, and the stopping, keeping and saying come after it, so the
 * start, and a wake, never wait on the disk or the profile.
 */

import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** How long each window is, in which one start may be profiled, in ms. */
const EVERY_MS = 10 * 60_000;

/** The longest a profile samples, in ms, however long the start takes. */
const MOST_SAMPLED_MS = 60_000;

/** How long a start waits for its window's claim before going unprofiled, in ms. */
const CLAIM_MS = 100;

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
const BYTES_PER_KB = 1024;

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
	/** The folder profiles and claims are kept in, made if it is missing. */
	readonly folder: string;
	/** How long each window is, in ms, in which one start may be profiled; EVERY_MS by default. */
	readonly every?: number;
	/** The longest a profile samples, in ms; MOST_SAMPLED_MS by default. */
	readonly most?: number;
	readonly now?: () => number;
}

/**
 * Runs a start, profiled when no other is and its window is unclaimed,
 * settling as the start does: its own failure thrown as it was. The
 * profile's line, or why there is none when the profiler failed, goes
 * to `said` once the start has settled; `done` settles once it has been,
 * or at once when there is none. `said` is told nothing about the start
 * itself, so a fault in it is the caller's to report.
 */
export type StartProfiler = (
	start: () => Promise<void>,
	said: (line: string) => void,
) => Promise<{ readonly done: Promise<void> }>;

const NONE = { done: Promise.resolve() } as const;

/** A profiler for screens' starts, keeping what it takes under `folder`. */
export function startProfiler(options: StartProfilerOptions): StartProfiler {
	const every = options.every ?? EVERY_MS;
	const most = options.most ?? MOST_SAMPLED_MS;
	const now = options.now ?? (() => Date.now());
	let tried: number | undefined;
	let running = false;
	return async (start, said) => {
		const window = Math.floor(now() / every);
		// The window this process tried is never asked of the disk again.
		if (running || tried === window) {
			await start();
			return NONE;
		}
		tried = window;
		running = true;
		const claim = await claimed(options.folder, window);
		if (claim !== true) {
			running = false;
			await start();
			if (claim === false) return NONE;
			return { done: later(() => said(claim.line)) };
		}
		return profiled(start, said, {
			folder: options.folder,
			window,
			most,
			ended: () => {
				running = false;
			},
		});
	};
}

/**
 * Claim a window for this start: true when it made the window's file,
 * false when another start had, or why it couldn't tell, in at most
 * CLAIM_MS. A claim answered late still stands, keeping the window.
 */
async function claimed(
	folder: string,
	window: number,
): Promise<boolean | { line: string }> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<{ line: string }>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					line: `Screen start not profiled: its folder didn't answer in ${CLAIM_MS} ms`,
				}),
			CLAIM_MS,
		);
	});
	const made = madeClaim(folder, window).catch((error: unknown) => ({
		line: `Screen start not profiled: couldn't claim its folder: ${failure(error)}`,
	}));
	try {
		return await Promise.race([made, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Make the window's claim file: true when this made it, false when another start had. */
async function madeClaim(folder: string, window: number): Promise<boolean> {
	await mkdir(folder, { recursive: true, mode: 0o700 });
	try {
		const file = await open(join(folder, claimOf(window)), "wx", 0o600);
		await file.close();
		return true;
	} catch (error) {
		// Only the claim's own EEXIST is another start's; the folder's is a fault.
		if (isCode(error, "EEXIST")) return false;
		throw error;
	}
}

function claimOf(window: number): string {
	return `claim-${window}`;
}

/** What a profiled start needs beyond the start itself. */
interface Profiling {
	readonly folder: string;
	readonly window: number;
	readonly most: number;
	/** Told once the profile is stopped and kept, or given up. */
	readonly ended: () => void;
}

/** Run `start` with the thread sampled, saying what the samples say once it settles. */
async function profiled(
	start: () => Promise<void>,
	said: (line: string) => void,
	profiling: Profiling,
): Promise<{ readonly done: Promise<void> }> {
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
		profiling.ended();
		await start();
		return {
			done: later(() => said(`Screen start not profiled: ${failure(error)}`)),
		};
	}
	let finishing: Promise<string> | undefined;
	const finish = (cut: boolean): Promise<string> => {
		finishing ??= stopped(session, profiling, cut)
			.catch((error: unknown) => `Screen start not profiled: ${failure(error)}`)
			.finally(() => {
				session.disconnect();
				profiling.ended();
			});
		return finishing;
	};
	const cap = setTimeout(() => {
		finish(true).catch(() => {
			// finish answers every failure as its line, so nothing reaches here.
		});
	}, profiling.most);
	cap.unref();
	const settled = async () => {
		clearTimeout(cap);
		said(await finish(false));
	};
	try {
		await start();
	} catch (error) {
		// The start's own failure is thrown as it was, its profile said too.
		later(settled).catch(() => {
			// later never rejects; this only keeps a rejection off the process.
		});
		throw error;
	}
	return { done: later(settled) };
}

/**
 * Run `then` after what is waiting on the thread now, so a start that
 * settled is answered, and a woken screen runs, before it does.
 */
function later(then: () => void | Promise<void>): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve))
		.then(then)
		.catch(() => {
			// What throws here is `said`, the caller's, which reports its own
			// faults: a profile's line is only ever a reading.
		});
}

/** Stop sampling, keep the profile, and say whose code the samples fell in. */
async function stopped(
	session: Session,
	profiling: Profiling,
	cut: boolean,
): Promise<string> {
	const { profile } = await session.post("Profiler.stop");
	await session.post("Profiler.disable");
	const of = cut
		? `, sampling only its first ${seconds(profiling.most * US_PER_MS)} as it ran on`
		: "";
	const said = `Screen start profiled: the thread's time went to ${ownersLine(profile)}${of}`;
	try {
		return `${said}; kept in ${await kept(profile, profiling)}`;
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
		// A sample's delta is the time since the one before it, the first's
		// since sampling began, so each counts the time up to its sample.
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

/**
 * Whose code a frame runs, read from its file. `root` is the harness's
 * top folder, this one's by default; under an install's `versions`, the
 * install's `current` and its other versions are the harness's too,
 * since pi loads the extensions through `current`, which a later
 * install moves on while the host runs.
 */
export function ownerOf(frame: Frame, root: string = HARNESS): string {
	const pseudo = PSEUDO[frame.functionName];
	if (frame.url === "") return pseudo ?? "native code";
	if (frame.url.startsWith("node:")) return "node";
	const path = pathOf(frame.url);
	if (path === undefined) return "other";
	const inHarness = harnessPart(path, root);
	const within = inHarness ?? path;
	const modules = within.lastIndexOf(`node_modules${sep}`);
	if (modules >= 0 && (modules === 0 || within[modules - 1] === sep))
		return packageOf(within.slice(modules));
	if (inHarness === undefined) return "other";
	const [top, next] = inHarness.split(sep);
	if ((top === "extensions" || top === "packs") && next !== undefined)
		return next;
	return `the harness's ${top}`;
}

/** A frame's file, or undefined when its url names none this can read. */
function pathOf(url: string): string | undefined {
	if (!url.startsWith("file:")) return url;
	try {
		return fileURLToPath(url);
	} catch {
		// A file url naming a host or a bad escape is no file here: "other".
		return undefined;
	}
}

/** The part of a path below the harness's top, or undefined when it isn't the harness's. */
function harnessPart(path: string, root: string): string | undefined {
	if (path.startsWith(`${root}${sep}`)) return path.slice(root.length + 1);
	const versions = dirname(root);
	if (basename(versions) !== "versions") return undefined;
	const current = join(dirname(versions), "current");
	if (path.startsWith(`${current}${sep}`))
		return path.slice(current.length + 1);

	if (!path.startsWith(`${versions}${sep}`)) return undefined;
	const [, ...rest] = path.slice(versions.length + 1).split(sep);
	return rest.length > 0 ? rest.join(sep) : undefined;
}

/** The package a path from node_modules on is in, pi's own said as pi. */
function packageOf(fromModules: string): string {
	const [, scope, name] = fromModules.split(sep);
	const named = scope?.startsWith("@") ? `${scope}/${name}` : scope;
	if (named === undefined) return "other";
	return named === "pi-monorepo" || named.startsWith("@earendil-works/")
		? "pi"
		: named;
}

/** Keep a profile in the folder, the newest few and this window's claim, answering where. */
async function kept(profile: Profile, profiling: Profiling): Promise<string> {
	const { folder } = profiling;
	const text = JSON.stringify(profile);
	const bytes = Buffer.byteLength(text);
	if (bytes > MOST_BYTES)
		throw new Error(
			`at ${Math.round(bytes / BYTES_PER_KB)} KB it is too large`,
		);
	const name = `start-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`;
	const file = join(folder, name);
	await writeFile(file, text, { mode: 0o600, flag: "wx" });
	const names = await readdir(folder);
	const older = profilesIn(names)
		.reverse()
		.slice(KEPT)
		.filter((one) => one !== name);
	const claims = names.filter(
		(one) => one.startsWith("claim-") && one !== claimOf(profiling.window),
	);
	await Promise.all(
		[...older, ...claims].map((one) => rm(join(folder, one), { force: true })),
	);
	return file;
}

/** The profiles among a folder's names, oldest first, as their names sort. */
function profilesIn(names: readonly string[]): string[] {
	return names
		.filter((name) => name.startsWith("start-") && name.endsWith(".cpuprofile"))
		.sort();
}

function seconds(us: number): string {
	return `${(us / US_PER_MS / MS_PER_S).toFixed(1)} s`;
}

function isCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function failure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
