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
 * gives anything but providers, is passed over whole. A provider that
 * took past fifteen minutes to judge a tree is told to stop, asked
 * nothing more that run, and left out of the stamp, as is one whose
 * judging or taking failed for every tree it tried, so the hosts go on
 * sweeping those trees. One that failed for only some keeps them and
 * stays in the stamp. Taking a tree has no clock, as in a host, since
 * the sweep hands a tree back to its sessions once a take fails, and
 * one cut off may still be removing it; the unit's own two hours end a
 * take that never settles, leaving the record the sweep's. Trees from
 * a provider loaded nowhere here are kept.
 *
 * It writes its sweep's line to the sweep's log, as a host's does, and a
 * line for any module it passed over, provider that failed, stamp it
 * couldn't write or reason it didn't sweep, both there and to its
 * unit's journal, and exits 1 after any of those or a sweep that failed
 * or left trees unjudged, so its unit shows it.
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
	listsFirstProcess,
	logSweep,
	type SweepEnd,
	seesEveryProcess,
	sweepAndLog,
	sweepLockPath,
} from "../extensions/work-integration/sweep.ts";
import type { TreeCallOptions, TreeProvider } from "../lib/core/work/broker.ts";
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
 * How long a provider may take to judge one tree before the run goes on
 * without it: past World's ten minutes for one dev command, and
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
	/** How long one provider may take to judge one tree. */
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
	const calls: ProviderCalls = {
		hung: new Set(),
		threw: new Map(),
		answered: new Map(),
	};
	const troubles = await loadProviders(
		env[PROVIDER_MODULES],
		loadWithinMs,
		callWithinMs,
		calls,
	);
	if (troubles.length > 0) logSweep({ passedOver: troubles });
	const refused = (why: string): SweptOutside => {
		logSweep({ ms: 0, failed: why });
		tell(`didn't sweep: ${why}`);
		return { end: "failed", troubles };
	};
	const untrusted = await whyUntrusted();
	if (untrusted !== undefined) return refused(untrusted);
	let questsRoot: string;
	try {
		questsRoot = await questsRootNow();
	} catch (error) {
		return refused(`the quests can't be found: ${said(error)}`);
	}
	// A quests root that isn't there claims nothing, as a wrong one would,
	// and one that can't be looked at may claim anything.
	const unseen = whyQuestsUnseen(questsRoot);
	if (unseen !== undefined) return refused(unseen);
	const end = await sweepAndLog({
		claimed: () => ({ held: [], untilSpent: liveQuestTrees(questsRoot) }),
		swept: (paths) => forgetTrees(questsRoot, paths),
		fencedGit: true,
		told: (why) => tell(`sweep ${why}`),
	});
	// Any call that failed shows in the unit's state. A tree whose call
	// threw is kept, and asked about again next run, so its provider is
	// stamped still where the same kind of call answered for another
	// tree: one bad tree mustn't keep every host sweeping on its thread.
	// One that hung, or whose judging or taking failed every time, as a
	// provider that can't reach its tools here would, leaves its trees
	// to the hosts.
	const failed = new Set([...calls.hung, ...calls.threw.keys()]);
	for (const id of failed) {
		const trouble = `${id} couldn't judge or take every tree`;
		troubles.push(trouble);
		tell(
			`${trouble}${unjudgedOf(calls, id) ? ", so the hosts sweep its trees" : ""}; sweep.log counts the commonest reasons kept and names each tree refused`,
		);
	}
	const unjudged = [...failed].filter((id) => unjudgedOf(calls, id));
	if (failed.size > 0) {
		logSweep({ failedCalls: [...failed], unjudgedBy: unjudged });
	}
	// A sweep that left trees unjudged stands no host down for them.
	if (end !== "ran") return { end, troubles };
	const judged = judgedProviders().filter((id) => !unjudged.includes(id));
	const unstamped = markSweptOutside(sweepLockPath(), Date.now(), judged);
	if (unstamped !== undefined) {
		logSweep({ unstamped });
		tell(`unstamped: ${unstamped}`);
		return { end, troubles: [...troubles, `unstamped: ${unstamped}`] };
	}
	return { end, troubles };
}

/**
 * Whether provider `id`'s trees went unjudged this run: it hung, or a
 * kind of call it threw for never answered for any tree.
 */
function unjudgedOf(calls: ProviderCalls, id: string): boolean {
	return (
		calls.hung.has(id) ||
		[...(calls.threw.get(id) ?? [])].some(
			(kind) => calls.answered.get(id)?.has(kind) !== true,
		)
	);
}

/** Say `line` in the unit's journal, where its failure is read. */
function tell(line: string): void {
	process.stderr.write(`pi-sweep: ${line}\n`);
}

/** Why the quests at `root` can't be read for their claims, or nothing. */
function whyQuestsUnseen(root: string): string | undefined {
	try {
		if (statSync(root, { throwIfNoEntry: false })?.isDirectory() === true) {
			return undefined;
		}
		return `the quests aren't at ${root}`;
	} catch (error) {
		return `the quests at ${root} can't be looked at: ${said(error)}`;
	}
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
	// As the walk for who works in a tree checks: a /proc mounted to hide
	// other users' processes lists no first process, and a reading that
	// misses them keeps every claimed tree while the stamp still stands
	// the hosts down.
	if (!(await seesEveryProcess()) || !(await listsFirstProcess())) {
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
	calls: ProviderCalls,
): Promise<string[]> {
	const passedOver: string[] = [];
	for (const path of (modules ?? "").split(":")) {
		if (path === "") continue;
		try {
			for (const provider of await providersOf(path, withinMs)) {
				registerTreeProvider(watched(provider, calls, callWithinMs));
			}
		} catch (error) {
			passedOver.push(`${path}: ${said(error)}`);
			tell(`passed over ${path}: ${said(error)}`);
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

/**
 * Which providers' calls answered, threw or hung this run, by their ids.
 */
interface ProviderCalls {
	/** Took past their time, so are asked nothing more and left unstamped. */
	hung: Set<string>;
	/** The kinds of call each threw for at least one tree, which is kept. */
	threw: Map<string, Set<CallKind>>;
	/** The kinds of call each answered for at least one tree. */
	answered: Map<string, Set<CallKind>>;
}

/** A provider's two calls a sweep makes for each of its trees. */
type CallKind = "judge" | "take";

/** Notes in `seen` that provider `id` made a call of `kind`. */
function note(
	seen: Map<string, Set<CallKind>>,
	id: string,
	kind: CallKind,
): void {
	const kinds = seen.get(id) ?? new Set<CallKind>();
	kinds.add(kind);
	seen.set(id, kinds);
}

/**
 * `promise`, unless it takes longer than `ms` to settle, when `late` is
 * told first, so what it started can be stopped.
 */
async function within<T>(
	ms: number,
	promise: Promise<T>,
	late?: () => void,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const past = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			late?.();
			reject(new Error(`it gave nothing within ${ms / 1000} s`));
		}, ms);
	});
	try {
		return await Promise.race([promise, past]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `provider`, noting in `calls` which providers answered, threw or took
 * longer than `withinMs` to judge, so the stamp names only those that
 * judged their trees. A judgement past its time is told to stop, and the rest of
 * the run asks that provider nothing more, so one that hangs costs one
 * wait rather than one for every tree. One that threw is still asked
 * about its other trees, since a single bad tree says nothing of them.
 */
function watched(
	provider: TreeProvider,
	calls: ProviderCalls,
	withinMs: number,
): TreeProvider {
	const noted = async <T>(
		kind: CallKind,
		options: TreeCallOptions | undefined,
		call: (options: TreeCallOptions) => Promise<T>,
	): Promise<T> => {
		if (calls.hung.has(provider.id)) {
			throw new Error(`${provider.id} hung earlier in this sweep`);
		}
		const stop = new AbortController();
		const signal =
			options?.signal === undefined
				? stop.signal
				: AbortSignal.any([options.signal, stop.signal]);
		let late = false;
		try {
			const asked = call({ ...options, signal });
			// A take goes unclocked: once it fails the sweep hands the tree
			// back to its sessions, while one cut off may still be removing it.
			const answer = await (kind === "take"
				? asked
				: within(withinMs, asked, () => {
						late = true;
						stop.abort();
					}));
			note(calls.answered, provider.id, kind);
			return answer;
		} catch (error) {
			if (late) calls.hung.add(provider.id);
			else note(calls.threw, provider.id, kind);
			throw error;
		}
	};
	const { whyKept } = provider;
	return {
		id: provider.id,
		specificity: provider.specificity,
		appliesTo: (repo) => provider.appliesTo(repo),
		ensure: (request, options) => provider.ensure(request, options),
		release: (held, options) =>
			noted("take", options, (given) => provider.release(held, given)),
		...(typeof whyKept !== "function"
			? {}
			: {
					whyKept: (held, options) =>
						noted("judge", options, (given) =>
							whyKept.call(provider, held, given),
						),
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
