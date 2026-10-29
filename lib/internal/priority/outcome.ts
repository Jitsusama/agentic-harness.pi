/**
 * How the machine's heavy work ended, kept where a reboot leaves it, so
 * the queue's limits can follow what happened rather than an estimate.
 *
 * A job's shell says its exit status in `<id>.end` as it exits; the
 * session keeping the queue notes, in each running job, the most that
 * ran beside it; and when the job ends, one line goes to
 * `outcomes.jsonl` in the priority workflow's state directory. The file
 * holds about a month of work at a few hundred jobs a day: past
 * {@link MOST_OUTCOME_BYTES} it keeps its newer half.
 */

import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	CAPPED_NIX,
	CLASS_OF,
	type Class,
	FEWER_VMS,
	isVm,
	type Job,
	type Kind,
	MOST_VMS,
} from "./queue.ts";

/** What ran beside a job, the most at once while it ran. */
export interface Beside {
	/** VMs on the machine, its own included. */
	readonly vms: number;
	/** Other builds the queue ran. */
	readonly builds: number;
	/** Of those, the ones capped beside a VM check. */
	readonly cappedBuilds: number;
	/** CPU pressure, avg10, in percent. */
	readonly cpuPressure: number;
}

/** How one job ended. */
export interface Outcome {
	readonly v: 1;
	readonly id: string;
	readonly kind: Job["kind"];
	readonly class: Class;
	readonly what: string;
	readonly session: string;
	/** When it asked for its turn. */
	readonly asked: string;
	/** When it was given its turn, if it was. */
	readonly started?: string;
	readonly ended: string;
	readonly waitedS: number;
	/** How long it ran, or nothing when it gave up waiting. */
	readonly ranS?: number;
	/**
	 * Its shell's exit status, or nothing when the shell ended without
	 * saying: killed, or the work set an EXIT trap of its own.
	 */
	readonly exit?: number;
	readonly capped: boolean;
	readonly beside: Beside;
	/** A Nix build it asked for ran a VM or another check with deadlines. */
	readonly ranTimed?: true;
	/** Up to how much memory its Nix builds held at once, in bytes. */
	readonly buildsPeakBytes?: number;
	/** The most memory its own commands held, in bytes, from its scope. */
	readonly ownPeakBytes?: number;
	/** What its plan made it before its turn (plan.ts), when it had one. */
	readonly planned?: "vm-check" | "build" | "failed";
	/** Why its plan said nothing, when it didn't. */
	readonly planFailed?: string;
}

/** How large the outcome file grows before it keeps its newer half. */
export const MOST_OUTCOME_BYTES = 2 * 1024 * 1024;

/** How far back a VM failing beside a capped build lowers the cap. */
export const FAILURES_COUNT_FOR_MS = 24 * 60 * 60 * 1000;

/** The cores a capped build gets once a VM failed beside one. */
export const CAPPED_CORES_AFTER_FAILURE = 2;

/** Nothing beside it yet. */
export const NOTHING_BESIDE: Beside = {
	vms: 0,
	builds: 0,
	cappedBuilds: 0,
	cpuPressure: 0,
};

/** What runs beside `job` now, among the `running` jobs. */
export function besideNow(
	job: Job,
	running: readonly Job[],
	machine: { readonly vms: number; readonly cpuPressure: number },
): Beside {
	const builds = running.filter(
		(other) => other.id !== job.id && other.kind === "build",
	);
	return {
		vms: machine.vms,
		builds: builds.length,
		cappedBuilds: builds.filter((other) => other.capped).length,
		cpuPressure: machine.cpuPressure,
	};
}

/** The most of each, between what was seen and what is seen now. */
export function mostBeside(seen: Beside, now: Beside): Beside {
	return {
		vms: Math.max(seen.vms, now.vms),
		builds: Math.max(seen.builds, now.builds),
		cappedBuilds: Math.max(seen.cappedBuilds, now.cappedBuilds),
		cpuPressure: Math.max(seen.cpuPressure, now.cpuPressure),
	};
}

/** How `job` ended at `ended`, its shell having said `exit`. */
export function outcomeOf(
	job: Job,
	ended: number,
	exit: number | undefined,
): Outcome {
	const asked = Date.parse(job.since);
	const started =
		job.started !== undefined ? Date.parse(job.started) : undefined;
	const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));
	return {
		v: 1,
		id: job.id,
		kind: job.kind,
		class: CLASS_OF[job.kind],
		what: job.what,
		session: job.owner.session,
		asked: job.since,
		...(job.started !== undefined ? { started: job.started } : {}),
		ended: new Date(ended).toISOString(),
		waitedS: seconds((started ?? ended) - asked),
		...(started !== undefined ? { ranS: seconds(ended - started) } : {}),
		...(exit !== undefined ? { exit } : {}),
		capped: job.capped === true,
		beside: job.beside ?? NOTHING_BESIDE,
		...(job.ranTimed ? { ranTimed: true as const } : {}),
		...(job.buildsPeakBytes !== undefined
			? { buildsPeakBytes: job.buildsPeakBytes }
			: {}),
		...(job.ownPeakBytes !== undefined
			? { ownPeakBytes: job.ownPeakBytes }
			: {}),
		...(job.planned !== undefined ? { planned: job.planned } : {}),
		...(job.planFailed !== undefined ? { planFailed: job.planFailed } : {}),
	};
}

/**
 * The kind work asked for as `kind` waits as, by how earlier runs went:
 * a build whose Nix builds ran a VM or another check with deadlines
 * waits as a VM check, since its name need not say so, as `nix flake
 * check`'s does not. The same work's latest run that had its turn says,
 * known again by {@link workKey}; once its checks come from the cache,
 * it is a build again. Work never run waits as a VM check when it asks
 * for a check that ran one built alone ({@link checksRunningVms}).
 *
 * On 28 October the integration net built VM checks whose names don't
 * say so as a build, and seven VMs ran with no VM turn while twenty VM
 * tests waited from 23:04 to past 00:48.
 */
export function kindAfter(
	kind: Kind,
	what: string,
	outcomes: readonly Outcome[],
): Kind {
	if (kind !== "build") return kind;
	const key = workKey(what);
	for (let at = outcomes.length - 1; at >= 0; at -= 1) {
		const outcome = outcomes[at];
		if (outcome.started === undefined || workKey(outcome.what) !== key) {
			continue;
		}
		return outcome.ranTimed ? "vm-check" : kind;
	}
	const running = checksRunningVms(outcomes);
	return checksAsked(what).some((check) => running.has(check))
		? "vm-check"
		: kind;
}

/**
 * The checks known to run a VM or another check with deadlines: each
 * check whose latest run that had its turn, asking for it alone, ran
 * one. A run of several that ran one says nothing of which, and a check
 * whose latest run came from the cache is known as no VM until it runs
 * again.
 */
export function checksRunningVms(outcomes: readonly Outcome[]): Set<string> {
	const decided = new Map<string, boolean>();
	for (let at = outcomes.length - 1; at >= 0; at -= 1) {
		const outcome = outcomes[at];
		if (outcome.started === undefined || isCut(outcome.what)) continue;
		const asked = checksAsked(outcome.what);
		const [only] = asked;
		if (asked.length !== 1 || only === undefined || decided.has(only)) {
			continue;
		}
		decided.set(only, outcome.ranTimed === true);
	}
	return new Set(
		[...decided].filter(([, timed]) => timed).map(([check]) => check),
	);
}

/** Seconds a build's last run took, under which its next counts as quick. */
export const QUICK_S = 60;

/** A flake check named in full, as `.#checks.x86_64-linux.formatting`. */
const CHECK_NAMED = /#checks\.[\w-]+\.([\w-]+)/g;

/**
 * A redirection and what it names, as `> $TMPDIR/cc.log`, `2>&1` and
 * `2>>err`: where output goes, which each run names afresh.
 */
const REDIRECTION = /\s*(?:\d|&)?>>?\s*(?:&\d|\S+)/g;

/**
 * What work is, so it is known again whatever flake reference, wrapper
 * or log it came with: the checks it names, or else its command past
 * `timeout` and `direnv exec`, without its redirections. The same checks
 * were asked for as `.#checks...`, `path:$T#checks...` and
 * `git+file://$PWD?rev=$rev#checks...`, and 2,650 of the 4,298 runs
 * recorded by 26 October sent their output to a log named for that run,
 * so the same command was never known again.
 */
export function workKey(what: string): string {
	const checks = isCut(what) ? [] : checksNamed(what);
	if (checks.length > 0) return `checks:${checks.join(",")}`;
	return what
		.replace(/^[\s(]*(?:timeout\s+\d+\s+)?(?:direnv\s+exec\s+\S+\s+)?/, "")
		.replace(REDIRECTION, "")
		.trim();
}

/** How long a failed run must have taken for its peak to count. */
export const TELLING_S = 10;

/** How many of work's latest runs its need is read from. */
export const RUNS_READ = 3;

/** What work is held to past the most its latest runs held. */
export const HEADROOM = 1.15;

const GIB = 1024 ** 3;

/**
 * The memory work needs by its latest runs, in GiB: the most any of
 * the last {@link RUNS_READ} held, its own commands' peak from its
 * shell's scope, with {@link HEADROOM}, rounded up. So the queue admits
 * work by what it took rather than by a guess for its kind. Nothing for
 * work never seen, or seen only failing within {@link TELLING_S}, which
 * says nothing of what it needs. Its Nix builds' memory is left out:
 * that counts each build's own peak whether or not they met, so it is a
 * ceiling rather than a measure.
 *
 * By 26 October's afternoon a `nix flake check` peaked at 25.4 GiB
 * against the 20 it was held to, a `nix develop -c cargo test` at 10.9
 * against a build's 4, and jobs at their memory limit stalled 22% of
 * the time (5FWIUS). Replayed over the 2,017 runs recorded with a peak
 * by 15:40 that day, the guesses fell over 2 GiB short 97 times and held
 * 14,132 GiB in all; this falls short 86 times and holds 12,123. The
 * last run alone fell short 133 times: one command's peaks vary.
 */
export function peakGibAfter(
	what: string,
	outcomes: readonly Outcome[],
): number | undefined {
	const key = workKey(what);
	const peaks: number[] = [];
	for (let at = outcomes.length - 1; at >= 0; at -= 1) {
		const outcome = outcomes[at];
		if (outcome.ownPeakBytes === undefined || outcome.ranS === undefined) {
			continue;
		}
		if (failed(outcome.exit) && outcome.ranS < TELLING_S) continue;
		if (workKey(outcome.what) !== key) continue;
		peaks.push(outcome.ownPeakBytes);
		if (peaks.length === RUNS_READ) break;
	}
	if (peaks.length === 0) return undefined;
	return Math.max(1, Math.ceil((Math.max(...peaks) * HEADROOM) / GIB));
}

/**
 * Whether the log cut a command short, as `whatOf` does past 120
 * characters. What it names past the cut is lost, so it is never read
 * as asking for only the checks it shows: a batch cut after its first
 * check would read as that check alone.
 */
function isCut(what: string): boolean {
	return what.endsWith("...");
}

/** The checks a command names in full, sorted, each once. */
function checksNamed(what: string): string[] {
	return [
		...new Set([...what.matchAll(CHECK_NAMED)].map((match) => match[1])),
	].sort();
}

/**
 * A check asked for as an attribute of a variable holding a flake's
 * checks, as `$c.formatting` is, the way the integration net asks.
 */
const CHECK_ASKED = /\$\{?\w+\}?\.([\w-]+)/g;

/**
 * The checks a command asks for, named in full or as an attribute of a
 * variable, sorted, each once. Only for knowing a check again: a check
 * asked for through a variable may be in any flake, so it never makes
 * work quick.
 */
function checksAsked(what: string): string[] {
	const asked = [...what.matchAll(CHECK_ASKED)].map((match) => match[1]);
	return [...new Set([...checksNamed(what), ...asked])].sort();
}

/**
 * Whether a build takes seconds, so it gets the queue's quick turn: its
 * last run that had its turn took under {@link QUICK_S}, or, with none,
 * it builds checks named in full and none is a VM test's. Of 458 builds
 * from 24 October this called quick, 367 were (80%) and 24 ran over five
 * minutes; a slow run makes the next one bulk again. It found 316 of the
 * 746 minutes the quick ones waited.
 */
export function quickAfter(
	kind: Kind,
	what: string,
	outcomes: readonly Outcome[],
): boolean {
	if (kind !== "build") return false;
	const key = workKey(what);
	for (let at = outcomes.length - 1; at >= 0; at -= 1) {
		const outcome = outcomes[at];
		if (outcome.ranS === undefined || workKey(outcome.what) !== key) continue;
		return outcome.ranS < QUICK_S && !outcome.ranTimed;
	}
	const checks = checksNamed(what);
	const running = checksRunningVms(outcomes);
	return (
		!isCut(what) &&
		checks.length > 0 &&
		!checks.some((name) => name.startsWith("vm-") || running.has(name))
	);
}

/**
 * How many seconds the same work took the last time it had its turn, or
 * nothing with no such run. Found by {@link workKey}, so a run that sent
 * its output somewhere else still counts, and a failure inside
 * {@link TELLING_S} is passed over, since it says nothing of how long
 * the work takes.
 */
export function ranSAfter(
	what: string,
	outcomes: readonly Outcome[],
): number | undefined {
	const key = workKey(what);
	for (let at = outcomes.length - 1; at >= 0; at -= 1) {
		const outcome = outcomes[at];
		if (outcome.ranS === undefined || workKey(outcome.what) !== key) continue;
		if (failed(outcome.exit) && outcome.ranS < TELLING_S) continue;
		return outcome.ranS;
	}
	return undefined;
}

/**
 * Whether an exit says the work failed, rather than that it was stopped
 * (128 and past, a signal) or never found (126, 127).
 */
export function failed(exit: number | undefined): boolean {
	return exit !== undefined && exit >= 1 && exit <= 125;
}

/**
 * The Nix settings a build beside a VM check gets: {@link CAPPED_NIX},
 * with its cores lowered to {@link CAPPED_CORES_AFTER_FAILURE} while, in
 * the last day, a VM failed beside a capped build that passed with none,
 * as P9R1KI asked for its estimate.
 *
 * A failure alone says too little: a break copy, a test with one feature
 * broken on purpose, fails every time, and WCJQSG runs a dozen back to
 * back. So only work, the same command as the queue names it, that has
 * passed with no capped build beside it counts when it fails beside one.
 */
export function capFor(
	outcomes: readonly Outcome[],
	now: number,
): { readonly maxJobs: number; readonly cores: number } {
	const since = now - FAILURES_COUNT_FOR_MS;
	const passedAlone = new Set(
		outcomes
			.filter(
				(outcome) =>
					isVm(outcome) &&
					outcome.exit === 0 &&
					outcome.beside.cappedBuilds === 0,
			)
			.map((outcome) => outcome.what),
	);
	const failedBesideCap = outcomes.some(
		(outcome) =>
			isVm(outcome) &&
			outcome.beside.cappedBuilds > 0 &&
			failed(outcome.exit) &&
			passedAlone.has(outcome.what) &&
			Date.parse(outcome.ended) >= since,
	);
	return failedBesideCap
		? { ...CAPPED_NIX, cores: CAPPED_CORES_AFTER_FAILURE }
		: CAPPED_NIX;
}

/** How many VMs must fail at the most in a day before it is lowered. */
export const FAILURES_TO_LOWER_VMS = 3;

/**
 * How many times as often VMs must fail at the most as with fewer before
 * the most is lowered.
 */
export const FAILING_TIMES_AS_OFTEN = 2;

/**
 * How many VMs run at once: {@link MOST_VMS}, or {@link FEWER_VMS}
 * while, in the last day, VMs failed at the most
 * {@link FAILING_TIMES_AS_OFTEN} times as often as with fewer, in at
 * least {@link FAILURES_TO_LOWER_VMS} runs. A failure counts only for
 * work that has passed with fewer, since a break copy fails however few
 * run beside it, as for {@link capFor}.
 *
 * One failure lowered it once, and said nothing: a check being written
 * failed an assertion in 86 s, and the limit stayed down a day while
 * ten checks waited. Over the 623 VM runs to then, a run failed no more
 * often with eight VMs beside it than with one. A rate is what a
 * crowded machine would change, and one failure is not a rate.
 */
export function vmsFor(outcomes: readonly Outcome[], now: number): number {
	const since = now - FAILURES_COUNT_FOR_MS;
	const recent = outcomes.filter(
		(outcome) =>
			isVm(outcome) &&
			(outcome.exit === 0 || failed(outcome.exit)) &&
			Date.parse(outcome.ended) >= since,
	);
	const passedWithFewer = new Set(
		outcomes
			.filter(
				(outcome) =>
					isVm(outcome) && outcome.exit === 0 && outcome.beside.vms < MOST_VMS,
			)
			.map((outcome) => outcome.what),
	);
	const atMost = recent.filter((outcome) => outcome.beside.vms >= MOST_VMS);
	const withFewer = recent.filter((outcome) => outcome.beside.vms < MOST_VMS);
	const failedAtMost = atMost.filter(
		(outcome) => failed(outcome.exit) && passedWithFewer.has(outcome.what),
	).length;
	if (failedAtMost < FAILURES_TO_LOWER_VMS) return MOST_VMS;
	// With fewer, a run or two either way is taken as given, so that no
	// failures in a handful of runs isn't read as never failing.
	const rateWithFewer =
		(withFewer.filter((outcome) => failed(outcome.exit)).length + 1) /
		(withFewer.length + 2);
	const rateAtMost = failedAtMost / atMost.length;
	return rateAtMost >= FAILING_TIMES_AS_OFTEN * rateWithFewer
		? FEWER_VMS
		: MOST_VMS;
}

/** Adds one outcome to the file, keeping its newer half once it is full. */
export function keepOutcome(file: string, outcome: Outcome): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(outcome)}\n`);
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		return;
	}
	if (size <= MOST_OUTCOME_BYTES) return;
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(
		temporary,
		`${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`,
	);
	renameSync(temporary, file);
}

/** The outcomes the file holds, leaving out any line it can't read. */
export function outcomesIn(file: string): Outcome[] {
	let content = "";
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	return content.split("\n").flatMap((line) => {
		if (!line) return [];
		try {
			const outcome = JSON.parse(line) as Outcome;
			return outcome?.v === 1 && outcome.beside ? [outcome] : [];
		} catch {
			return [];
		}
	});
}
