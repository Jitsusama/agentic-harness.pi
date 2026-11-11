/**
 * The rollout gate: a host runs a second conversation only once every live
 * pi tells hosted conversations apart.
 *
 * Before 5b5b7260 a pi's mesh census kept one presence per process, the
 * newest, so a pi on an older harness takes every conversation in a host
 * but the newest as ended: it refuses to message them and frees their
 * leases. Each pi says which harness it loaded in `<package>/loaded/<pid>`
 * (lib/internal/reload/said.ts), so the host reads those, keeps the pids
 * that still run, and dates each root against that commit. One that can't
 * be read or dated counts as stale, since a refusal that names it can be
 * acted on and a guess can't be seen. One conversation per host is never
 * gated: it is what every older pi already understands.
 *
 * A pi too old to say what it loaded (before 29 October) is not seen;
 * none runs today, and reload-workflow's follower moves pis along. A file
 * a pi killed outright left behind is judged by its pid's process only
 * while that process started before the file was written, as every pi
 * writes its file after it starts: a later one wears a reused pid.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemFacts } from "../../lib/core/process/process.ts";
import { installOfVersion } from "../../lib/internal/reload/loaded.ts";
import { LOADED_FOLDER } from "../../lib/internal/reload/said.ts";
import { hostRefusal } from "./dispatch.ts";

/** The code a requester is refused under, with the gate's own words. */
export const ROLLOUT_REFUSED = "rollout_refused";

/** The commit whose census judges each hosted presence on its own (#1129). */
export const CENSUS_COMMIT = "5b5b7260c7b99f2aa7043826c27557a126b0c3ca";

/** How long one git call may take before the root counts as undated. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * How much later than its file a pid's process may seem to have started
 * and still be the pi that wrote it. A start is worked out from the boot
 * clock, which suspends and clock corrections move by seconds
 * (lib/internal/process-ticks.ts saw four after 100 suspends); a reused
 * pid comes far later than that.
 */
const REUSED_AFTER_MS = 60_000;

/** A pid file's name: the pid alone, never a `.<pid>.new` being written. */
const PID_NAME = /^\d+$/;

/** A live pi whose census would collapse this host's conversations. */
export interface StaleHarness {
	readonly pid: number;
	/** The root it said it loaded, when it said one. */
	readonly root?: string;
	/** Why it counts as stale, in a few words. */
	readonly why: string;
}

/** A live pi as the gate judged it. */
export interface HarnessVerdict extends StaleHarness {
	/** Whether it tells hosted conversations apart. */
	readonly current: boolean;
}

/** What a pi whose harness holds the change is said to have. */
const HAS_CHANGE = "has the census change";

/** What the gate asks of the machine; tests give their own. */
export interface RolloutFacts {
	/** Whether a process with this pid runs. */
	alive(pid: number): boolean;
	/** When the process wearing this pid started, or undefined when unknown. */
	startedAt(pid: number): Promise<number | undefined>;
	/**
	 * Whether `root`'s HEAD holds `commit`: true or false, or undefined
	 * when it can't be told (not a checkout, gone, or no such commit).
	 */
	holds(root: string, commit: string): Promise<boolean | undefined>;
}

/** The machine's answers: signal 0 for a pid, git for a root. */
export const rolloutFacts: RolloutFacts = {
	alive: (pid) => systemFacts.alive(pid),
	startedAt: (pid) => systemFacts.startedAt(pid),
	holds: (root, commit) =>
		new Promise((resolve) => {
			execFile(
				"git",
				["-C", root, "merge-base", "--is-ancestor", commit, "HEAD"],
				{ timeout: GIT_TIMEOUT_MS },
				(error) => {
					if (!error) return resolve(true);
					// 1 is git's "not an ancestor"; anything else (128 for a
					// missing repo or commit, a kill on timeout) can't be told.
					resolve(error.code === 1 ? false : undefined);
				},
			);
		}),
};

/**
 * The `loaded` folder of the install whose version `root` is, or nothing
 * for a root outside one, such as a tree.
 */
export function loadedFolderOf(root: string): string | undefined {
	const install = installOfVersion(root);
	return install === undefined ? undefined : join(install, LOADED_FOLDER);
}

/** The package root this host runs, resolved through any link. */
export function hostRoot(): string {
	const root = fileURLToPath(new URL("../..", import.meta.url));
	try {
		return realpathSync(root);
	} catch {
		// A root that won't resolve is dated as given; it then names no
		// install, and the gate refuses a second conversation saying so.
		return root;
	}
}

/**
 * The gate serveHost uses unless given one: over the `loaded` folder of
 * the install this host runs from. A host run from a tree has none, so
 * it keeps to one conversation and says where it looked.
 */
export function hostRolloutGate(root: string = hostRoot()): AdmitAnother {
	const loadedDir = loadedFolderOf(root);
	if (loadedDir !== undefined) return rolloutGate({ loadedDir });
	return () =>
		Promise.reject(
			hostRefusal(
				ROLLOUT_REFUSED,
				`This host keeps to one conversation: it runs from ${root}, outside an installed version, so it can't read which harness other pis run. Give serveHost a rollout gate over the install's ${LOADED_FOLDER} folder.`,
			),
		);
}

/** Where to read which harness each pi runs, and what to ask the machine. */
export interface CensusOptions {
	loadedDir: string;
	self?: number;
	facts?: RolloutFacts;
	commit?: string;
	current?: Set<string>;
}

/**
 * Every live pi, other than `self`, whose harness is older than the census
 * change or can't be dated, read from `loadedDir`.
 */
export async function staleHarnesses(
	options: CensusOptions,
): Promise<StaleHarness[]> {
	return (await harnessVerdicts(options))
		.filter((one) => !one.current)
		.map(({ pid, root, why }) => (root ? { pid, root, why } : { pid, why }));
}

/**
 * Every live pi other than `self` in `loadedDir`, each with whether its
 * harness holds the census change and why, by pid. A file whose pid a
 * later process wears is a dead pi's, and left out. A folder that isn't
 * there says nothing about anyone, so it is refused rather than read as
 * nobody. Roots in `current` are taken as holding the change without
 * asking git, and each root found to hold it is added there: a root only
 * moves forward, so a yes stays true, while a no is asked again.
 */
export async function harnessVerdicts(
	options: CensusOptions,
): Promise<HarnessVerdict[]> {
	const current = options.current ?? new Set<string>();
	const facts = options.facts ?? rolloutFacts;
	const commit = options.commit ?? CENSUS_COMMIT;
	const self = options.self ?? process.pid;
	let names: string[];
	try {
		names = await readdir(options.loadedDir);
	} catch (error) {
		throw hostRefusal(
			ROLLOUT_REFUSED,
			`Cannot tell which harness each pi runs: ${options.loadedDir} is unreadable (${String(error)})`,
		);
	}
	const dated = new Map<string, Promise<boolean | undefined>>();
	const judged = await Promise.all(
		names
			.filter((name) => PID_NAME.test(name))
			.map(Number)
			.filter((pid) => pid !== self && facts.alive(pid))
			.map(async (pid): Promise<HarnessVerdict | undefined> => {
				const file = join(options.loadedDir, String(pid));
				if (await wornByLater(file, pid, facts)) return undefined;
				const root = await saidRoot(file);
				if (root === undefined)
					return { pid, current: false, why: "its file names no root" };
				if (current.has(root))
					return { pid, root, current: true, why: HAS_CHANGE };
				let holds = dated.get(root);
				if (!holds) {
					holds = facts.holds(root, commit);
					dated.set(root, holds);
				}
				const verdict = await holds;
				if (verdict === true) {
					current.add(root);
					return { pid, root, current: true, why: HAS_CHANGE };
				}
				return {
					pid,
					root,
					current: false,
					why:
						verdict === false
							? "before the census change"
							: "its root can't be dated",
				};
			}),
	);
	return judged
		.filter((one) => one !== undefined)
		.sort((a, b) => a.pid - b.pid);
}

/**
 * Whether the process wearing `pid` started after `file` was written, so
 * another pi wrote it. When either time can't be read, it is judged as
 * the pi's, which only refuses more.
 */
async function wornByLater(
	file: string,
	pid: number,
	facts: RolloutFacts,
): Promise<boolean> {
	const [written, started] = await Promise.all([
		stat(file).then(
			(info) => info.mtimeMs,
			() => undefined,
		),
		facts.startedAt(pid),
	]);
	return (
		written !== undefined &&
		started !== undefined &&
		started > written + REUSED_AFTER_MS
	);
}

async function saidRoot(file: string): Promise<string | undefined> {
	try {
		const said: unknown = JSON.parse(await readFile(file, "utf8"));
		if (typeof said !== "object" || said === null) return undefined;
		const root: unknown = Reflect.get(said, "root");
		return typeof root === "string" && root !== "" ? root : undefined;
	} catch {
		// A file gone since the listing, or half of one, names no root;
		// the caller counts that as stale rather than guessing.
		return undefined;
	}
}

/** What a refused second conversation is told: every stale pi, and what to do. */
export function refusalText(stale: readonly StaleHarness[]): string {
	const each = stale.map(
		({ pid, root, why }) => `pid ${pid}${root ? ` (${root})` : ""}: ${why}`,
	);
	return [
		`This host keeps to one conversation: ${stale.length} live pi${stale.length === 1 ? "" : "s"} would take its other conversations as ended, since their harness predates ${CENSUS_COMMIT.slice(0, 8)} (#1129) or can't be dated.`,
		...each,
		"Reload or end them, or open the conversation in a host of its own.",
	].join("\n");
}

/**
 * The check a host runs before a second conversation: resolves when every
 * live pi tells hosted conversations apart, and rejects naming each one
 * that doesn't.
 */
export type AdmitAnother = () => Promise<void>;

/**
 * The gate over a package's `loaded` folder, for serveHost. It remembers
 * the roots it has seen hold the change for as long as it lives, so a
 * host's opens ask git only about roots it hasn't cleared yet.
 */
export function rolloutGate(options: {
	loadedDir: string;
	self?: number;
	facts?: RolloutFacts;
}): AdmitAnother {
	const current = new Set<string>();
	return async () => {
		const stale = await staleHarnesses({ ...options, current });
		if (stale.length > 0)
			throw hostRefusal(ROLLOUT_REFUSED, refusalText(stale));
	};
}
