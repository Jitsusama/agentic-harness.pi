/**
 * Sweep ended sessions' trees once, in a process of its own, as a user
 * timer does every hour: the sweep each pi host otherwise runs on its one
 * thread, whose git calls and folder listings held a host's thread for up
 * to 262 s on 19 November, freezing every conversation in it.
 *
 * Once a sweep has run to its end, judging every tree it was asked
 * about, it stamps that beside the sweep's lock, naming the providers
 * whose trees it judged, and while that stamp
 * is under two hours old a host whose providers it names stands its own
 * sweeps down. A run that fails, or finds another sweep running, leaves
 * the stamp as it was, so a timer that stops, or runs and can't sweep,
 * hands sweeping back to the hosts within two hours by itself. It takes
 * its turn at the same lock as every other sweep, but never rests after
 * one, as its timer already spaces its runs. The lock, the stamp and the
 * log are found by the same XDG folders as the hosts', so its timer sets
 * none of them.
 *
 * A quest's trees are read from the quests on disk, held until spent as a
 * host holds them, and a tree it takes is dropped from every live quest
 * that listed it. Its git holds to the fence's guard in every repository,
 * as a fenced session's does, since it runs in every session's trees with
 * no sandbox of its own. It fails before sweeping where a sweep's answers
 * couldn't be trusted: git that won't run, processes it can't all see, a
 * config it can't read or a quests folder that isn't there, either of
 * which would have it claim by the wrong quests.
 *
 * Providers other than git come from the modules PI_SWEEP_PROVIDERS
 * names, colon-separated and absolute, each one's default export a
 * function giving the providers to load. A module that won't load, or
 * gives anything but providers, is passed over whole, and a provider
 * that couldn't judge or take one of its trees, or took past fifteen
 * minutes to, is left out of the stamp, so the hosts go on sweeping
 * those trees. Trees from a provider loaded
 * nowhere here are kept.
 *
 * It writes its sweep's line to the sweep's log, as a host's does, and a
 * line for any module it passed over or a stamp it couldn't write, and
 * exits 1 after any of those or a sweep that failed or left trees
 * unjudged, so its unit shows it.
 *
 * Node runs it as it stands, stripping the types:
 *
 *   PI_SWEEP_PROVIDERS=/path/to/providers.ts node scripts/pi-sweep.ts
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
	forgetTrees,
	liveQuestTrees,
} from "../extensions/quest-workflow/claims.ts";
import { questsRootNow } from "../extensions/quest-workflow/config.ts";
import {
	judgedProviders,
	logSweep,
	type SweepEnd,
	seesEveryProcess,
	sweepAndLog,
	sweepLockPath,
} from "../extensions/work-integration/sweep.ts";
import type { TreeProvider } from "../lib/core/work/broker.ts";
import {
	isTreeProvider,
	registerTreeProvider,
} from "../lib/core/work/register.ts";
import { markSweptOutside } from "../lib/core/work/sweep-rest.ts";
import { unattendedExec } from "../lib/internal/sandbox/unattended-exec.ts";

/** The setting that names the modules giving providers other than git. */
const PROVIDER_MODULES = "PI_SWEEP_PROVIDERS";

/**
 * How long one provider module may take to load and give its providers:
 * a module that never settles would otherwise hold the run until its
 * unit's two hours ran out, and every hourly run after it with it.
 */
const LOAD_WITHIN_MS = 60 * 1000;

/**
 * How long a provider may take to judge or take one tree before the run
 * goes on without it: past World's ten minutes for one dev command, and
 * short of the unit's two hours, which one call that never settled
 * would otherwise spend with the lock held fresh, turning every host's
 * sweep away.
 */
const CALL_WITHIN_MS = 15 * 60 * 1000;

/** What one run outside every host was given. */
export interface SweepOutsideOptions {
	/** Where PI_SWEEP_PROVIDERS is read from. */
	env?: NodeJS.ProcessEnv;
	/** How long one provider module may take to load. */
	loadWithinMs?: number;
	/** How long one provider may take to judge or take one tree. */
	callWithinMs?: number;
}

/** How one run outside every host ended, and what went wrong beside. */
export interface SweptOutside {
	/** How its sweep ended. */
	end: SweepEnd;
	/** What else went wrong: a module passed over, a stamp unwritten. */
	troubles: string[];
}

/**
 * One sweep outside every host: providers loaded from the modules the
 * environment names, the machine checked, then the sweep, stamped for
 * the hosts only when it ran to its end, naming the providers that
 * judged every tree they were asked about.
 */
export async function sweepOutside({
	env = process.env,
	loadWithinMs = LOAD_WITHIN_MS,
	callWithinMs = CALL_WITHIN_MS,
}: SweepOutsideOptions = {}): Promise<SweptOutside> {
	const failing = new Set<string>();
	const troubles = await loadProviders(
		env[PROVIDER_MODULES],
		loadWithinMs,
		callWithinMs,
		failing,
	);
	if (troubles.length > 0) logSweep({ passedOver: troubles });
	const untrusted = await whyUntrusted();
	if (untrusted !== undefined) {
		logSweep({ ms: 0, failed: untrusted });
		return { end: "failed", troubles };
	}
	let questsRoot: string;
	try {
		questsRoot = await questsRootNow();
	} catch (error) {
		logSweep({ ms: 0, failed: `the quests can't be found: ${said(error)}` });
		return { end: "failed", troubles };
	}
	// A quests root that isn't there claims nothing, as a wrong one would.
	if (statSync(questsRoot, { throwIfNoEntry: false })?.isDirectory() !== true) {
		logSweep({ ms: 0, failed: `the quests aren't at ${questsRoot}` });
		return { end: "failed", troubles };
	}
	const end = await sweepAndLog({
		claimed: () => ({ held: [], untilSpent: liveQuestTrees(questsRoot) }),
		swept: (paths) => forgetTrees(questsRoot, paths),
		fencedGit: true,
	});
	// A sweep that left trees unjudged stands no host down for them.
	if (end !== "ran") return { end, troubles };
	const judged = judgedProviders().filter((id) => !failing.has(id));
	const unstamped = markSweptOutside(sweepLockPath(), Date.now(), judged);
	if (unstamped !== undefined) {
		logSweep({ unstamped });
		return { end, troubles: [...troubles, `unstamped: ${unstamped}`] };
	}
	return { end, troubles };
}

/**
 * Why this machine's sweep couldn't be trusted here, or nothing: git
 * that won't run would keep every tree as unreadable, and processes it
 * can't all see would keep every tree as perhaps in use, each stamped as
 * though judged.
 */
async function whyUntrusted(): Promise<string | undefined> {
	const git = await unattendedExec()("git", ["--version"]);
	if (git.code !== 0) {
		return `git won't run: ${git.stderr.trim() || `exit ${git.code}`}`;
	}
	if (!(await seesEveryProcess())) {
		return "it can't see every process on the machine";
	}
	return undefined;
}

/**
 * Register the providers each module in `modules`, colon-separated,
 * gives, each watched for a judgement that fails, and say each module
 * passed over and why.
 */
async function loadProviders(
	modules: string | undefined,
	withinMs: number,
	callWithinMs: number,
	failing: Set<string>,
): Promise<string[]> {
	const passedOver: string[] = [];
	for (const path of (modules ?? "").split(":")) {
		if (path === "") continue;
		try {
			for (const provider of await providersOf(path, withinMs)) {
				registerTreeProvider(watched(provider, failing, callWithinMs));
			}
		} catch (error) {
			passedOver.push(`${path}: ${said(error)}`);
			process.stderr.write(`pi-sweep: passed over ${path}: ${said(error)}\n`);
		}
	}
	return passedOver;
}

/** The providers the module at `path` gives, all of them or none. */
async function providersOf(
	path: string,
	withinMs: number,
): Promise<TreeProvider[]> {
	// The unit's working folder is no setting of the machine's.
	if (!isAbsolute(path)) throw new Error("it isn't an absolute path");
	const loaded: unknown = await within(
		withinMs,
		import(pathToFileURL(path).href),
	);
	const give = (loaded as { default?: unknown }).default;
	if (typeof give !== "function") {
		throw new Error("its default export gives no providers");
	}
	const given: unknown = await within(withinMs, Promise.resolve(give()));
	if (!Array.isArray(given)) {
		throw new Error("its default export gave no list of providers");
	}
	const providers: TreeProvider[] = [];
	for (const provider of given) {
		if (!isTreeProvider(provider)) {
			throw new Error("it gave something that is no tree provider");
		}
		providers.push(provider);
	}
	return providers;
}

/** `promise`, unless it takes longer than `ms` to settle. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`it gave nothing within ${ms / 1000} s`)),
			ms,
		);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `provider`, noting in `failing` when it couldn't judge or take one of
 * its trees, or took longer than `withinMs` to, so the stamp doesn't
 * name it as having judged them.
 */
function watched(
	provider: TreeProvider,
	failing: Set<string>,
	withinMs: number,
): TreeProvider {
	const noted = async <T>(call: () => Promise<T>): Promise<T> => {
		try {
			return await within(withinMs, call());
		} catch (error) {
			failing.add(provider.id);
			throw error;
		}
	};
	const { whyKept } = provider;
	return {
		id: provider.id,
		specificity: provider.specificity,
		appliesTo: (repo) => provider.appliesTo(repo),
		ensure: (request, options) => provider.ensure(request, options),
		release: (held, options) => noted(() => provider.release(held, options)),
		// One that gives null for its judgement has none, as one giving none.
		...(typeof whyKept !== "function"
			? {}
			: {
					whyKept: (held, options) =>
						noted(() => whyKept.call(provider, held, options)),
				}),
	};
}

/** What an error says, whatever was thrown. */
function said(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The code a run exits with: 1 after a sweep that failed or left trees
 * unjudged, or any trouble beside it, so its unit shows it, and 0
 * otherwise. Another sweep holding the lock is no failure, since a
 * host's sweep ran.
 */
export function exitCodeOf({ end, troubles }: SweptOutside): number {
	const whole = end === "ran" || end === "skipped" || end === "rested";
	return whole && troubles.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	// Exits outright, so a handle a provider module left open can't keep
	// the run going until its unit's clock stops it.
	process.exit(exitCodeOf(await sweepOutside()));
}
