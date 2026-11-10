/**
 * Where a bash call's command runs: as written, or rewritten to build its
 * VM checks and run-subtests runs on the lent builder (there.ts). Decided
 * once per call and kept for the process, so every extension that reads
 * the command sees the one it will run. The remote check interceptor
 * applies it; the mesh reads it, since pi runs `tool_call` handlers in the
 * order extensions load, and the mesh's run first: on 29 October a hold on
 * optimus's VM work would have held back a check bound for the builder,
 * and its lease named a VM job here.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { loadPackageConfig } from "../config/loader.ts";
import { packageConfigPath } from "../paths.ts";
import { type Step, stepsOf } from "../shell/steps.ts";
import { kindOf, runsChangedChecks } from "./queue.ts";
import {
	builderReady,
	builderStands,
	type CheckBuild,
	checkBuildsOf,
	copyThere,
	flakeThere,
	githubRepoOf,
	HERE_ONLY,
	offloadTakes,
	parseRemoteChecks,
	REMOTE_CHECKS_SLUG,
	type Repository,
	repositoryAt,
	type SubtestsRun,
	sentThere,
	subtestRunsOf,
	type Takes,
} from "./there.ts";

/** How long what `nix-offload there` takes is trusted before asking again. */
const TAKES_MS = 60_000;

/** How long a call's answer is kept: past any call's own tool_call handlers. */
const DECIDED_MS = 10 * 60_000;

interface Kept {
	takes?: { readonly at: number; readonly takes: Promise<Takes> };
	/** What the last answer said, for a caller that can't wait for one. */
	known?: Takes;
	readonly decided: Map<
		string,
		{ readonly at: number; readonly sent: Promise<string | undefined> }
	>;
}

const KEPT_KEY = Symbol.for("agentic-harness.remote-check.kept");

/**
 * The process's one store, on `globalThis` so the extensions that ask,
 * each loaded as a module of its own, and a runtime a reload replaced,
 * share it.
 */
function kept(): Kept {
	const global = globalThis as { [KEPT_KEY]?: Kept };
	global[KEPT_KEY] ??= { decided: new Map() };
	return global[KEPT_KEY];
}

/**
 * The command a bash call runs instead of `command`, or nothing when it
 * runs as written, decided once for the call `callId` names.
 */
export function whereItRuns(
	callId: string,
	command: string,
	cwd: string,
	signal?: AbortSignal,
	now = Date.now(),
): Promise<string | undefined> {
	const { decided } = kept();
	for (const [id, one] of decided) {
		if (now - one.at >= DECIDED_MS) decided.delete(id);
	}
	const key = `${callId}\0${cwd}\0${command}`;
	const known = decided.get(key);
	if (known) return known.sent;
	const sent = sendingThere(command, cwd, signal).catch(() => undefined);
	decided.set(key, { at: now, sent });
	return sent;
}

/**
 * Why a bash call may not run here, or nothing when it may: a VM check or
 * VM test of a repository whose checks go to the builder, or a copy with
 * no origin where `there` takes folders, that `whereItRuns` couldn't
 * send as written (a loop, a `$(...)`, a flag it doesn't pass on), while
 * a builder stands or `there` asks for one itself. A VM here starves the
 * person's desktop: on 30 October ten of them took optimus to load 43,
 * and prompts waited a minute. Anything else runs as written, a World
 * tree's VM tests included, and a run-subtests run asking for a prompt
 * or kept machines, which only work here.
 */
export async function refusedHere(
	callId: string,
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!isVmWork(command)) return undefined;
	if ((await whereItRuns(callId, command, cwd, signal)) !== undefined) {
		return undefined;
	}
	const loaded = await loadPackageConfig(packageConfigPath());
	if (!loaded.ok) return undefined;
	const repos = parseRemoteChecks(loaded.config.sections[REMOTE_CHECKS_SLUG]);
	if (!repos.ok || repos.value.length === 0) return undefined;
	const takes = await takesNow();
	if (!takes.wants && !builderStands()) return undefined;
	const home = homedir();
	const vms = (stepsOf(command, cwd, home) ?? []).filter((step) =>
		isVmWork(step.text),
	);
	// changed-checks sends its own run, and builds here only what nowhere took.
	const held = vms.filter(
		(step) => !(takes.changed && runsChangedChecks(step.text)),
	);
	if (vms.length > 0 && held.length === 0) return undefined;
	const folders = new Set(held.map((step) => step.cwd ?? cwd));
	if (folders.size === 0) folders.add(cwd);
	for (const folder of folders) {
		const found = await repositoryAt(folder);
		const repo = found ? githubRepoOf(found.origin) : undefined;
		const named =
			repo !== undefined &&
			repos.value.some((one) => one.toLowerCase() === repo.toLowerCase());
		const copy = takes.folder && found !== undefined && found.origin === "";
		if (named || copy) return REFUSAL;
	}
	return undefined;
}

/** Whether a command runs a VM here, as the queue would read it. */
function isVmWork(command: string): boolean {
	const kind = kindOf(command);
	if (kind !== "vm-check" && kind !== "vm-test") return false;
	return !command.split(/\s+/).some((word) => HERE_ONLY.has(word));
}

/** What a refused call is told: why, and how to send it instead. */
const REFUSAL = [
	"Remote check interceptor: this would run a VM on this machine, which slows the person's desktop, while the lent builder can take it.",
	"It couldn't be sent as written: a loop, a `$(...)` or a flag the interceptor doesn't pass on keeps it here.",
	"Send it yourself: `nix-offload there [-L] [--keep-going] <flake> checks.<system>.<name> ...`, with the flake as a tree's folder, `path:<folder>` or `github:<owner>/<repo>/<rev>`;",
	"or `run-subtests --there <check> <words>` for a subtests run.",
	"A run that needs this machine (`run-subtests -I` or `-K`) still runs here.",
].join(" ");

/** What `nix-offload there` takes, asked at most once a minute. */
export function takesNow(now = Date.now()): Promise<Takes> {
	const store = kept();
	if (store.takes === undefined || now - store.takes.at >= TAKES_MS) {
		const takes = offloadTakes();
		store.takes = { at: now, takes };
		void takes.then((answer) => {
			store.known = answer;
		});
	}
	return store.takes.takes;
}

/**
 * What `nix-offload there` took when it last answered, asking again when
 * that is stale, or nothing before its first answer: for a caller that
 * can't wait, as a spawn can't.
 */
export function takesKnown(now = Date.now()): Takes | undefined {
	void takesNow(now);
	return kept().known;
}

/** How long `git status` may take to say whether a tree is committed. */
const STATUS_MS = 2_000;

/**
 * Whether every heavy step of `command`, run from `cwd`, sends its whole
 * run to a builder: a changed-checks run that sends itself, or a
 * `nix-offload there --here-when-idle` that builds here only while this
 * machine is idle. Held as a build here, one such run waited 36 minutes
 * on memory on 10 November, and changed-checks runs waited behind it.
 */
export function sendsWholeRun(
	command: string,
	cwd: string,
	takes: Takes | undefined,
	isCommitted: (folder: string) => boolean = committedAt,
	home: string = homedir(),
): boolean {
	const heavy = (stepsOf(command, cwd, home) ?? []).filter(
		(step) => kindOf(step.text) !== undefined,
	);
	return (
		heavy.length > 0 &&
		heavy.every(
			(step) =>
				SENT_UNLESS_IDLE.test(step.text) ||
				changedChecksSent(step, takes, isCommitted),
		)
	);
}

/**
 * `nix-offload there --here-when-idle` with no `--here`: it builds here
 * only while this machine's CPU pressure has stayed under 10%, and never
 * a VM test, and otherwise sends the build as ever (core.nix's
 * nix-offload `there`). On a machine busy enough for the queue to hold
 * it back, it is sent.
 */
const SENT_UNLESS_IDLE =
	/\bnix-offload\s+there\b(?=[^\n]*\s--here-when-idle(?:\s|$))(?![^\n]*\s--here(?:\s|$))/;

/**
 * Whether a step is a changed-checks run that sends its whole run to the
 * builder, by the tests changed-checks makes itself (core.nix's
 * tools/changed-checks, `elsewhere`). nix-offload takes `changed`;
 * nothing asks for it here (`--here`, `CHANGED_CHECKS_HERE`); no
 * `--base` names a commit origin's main may not hold; and its tree has no
 * uncommitted change. Only the builder turning it away at that moment
 * keeps one of these here, which nothing can tell beforehand.
 */
function changedChecksSent(
	step: Step,
	takes: Takes | undefined,
	isCommitted: (folder: string) => boolean,
): boolean {
	return (
		takes?.changed === true &&
		process.env[CHANGED_CHECKS_HERE] === undefined &&
		runsChangedChecks(step.text) &&
		!asksForHere(step) &&
		step.cwd !== undefined &&
		isCommitted(step.cwd)
	);
}

/** What changed-checks reads to stay on this machine, as `--here` does. */
const CHANGED_CHECKS_HERE = "CHANGED_CHECKS_HERE";

/** Words of a changed-checks step that keep it here, or may. */
const STAYS_HERE =
	/(?:^|\s)(?:--here|--base)(?:[\s=]|$)|\bCHANGED_CHECKS_HERE=/;

/** Whether a changed-checks step asks to run here, or may stay here. */
function asksForHere(step: Step): boolean {
	return step.vars.has(CHANGED_CHECKS_HERE) || STAYS_HERE.test(step.text);
}

/** Whether the tree at `folder` has no uncommitted change git tracks. */
function committedAt(folder: string): boolean {
	try {
		return (
			execFileSync(
				"git",
				["-C", folder, "status", "--porcelain", "--untracked-files=no"],
				{
					encoding: "utf8",
					timeout: STATUS_MS,
					stdio: ["ignore", "pipe", "ignore"],
				},
			) === ""
		);
	} catch {
		// Not a tree, or too slow to say: read as one that runs here.
		return false;
	}
}

/**
 * What to run instead of `command`, or nothing to run it as written.
 * Each question is asked only once the cheaper ones before it allow a
 * step to go.
 */
async function sendingThere(
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const home = homedir();
	const steps = stepsOf(command, cwd, home);
	if (!steps) return undefined;
	const builds = checkBuildsOf(steps, home);
	const asked = subtestRunsOf(steps, home);
	if (builds.length === 0 && asked.length === 0) return undefined;
	const loaded = await loadPackageConfig(packageConfigPath());
	if (!loaded.ok) return undefined;
	const repos = parseRemoteChecks(loaded.config.sections[REMOTE_CHECKS_SLUG]);
	if (!repos.ok || repos.value.length === 0) return undefined;
	const takes = await takesNow();
	const gits = new Map<string, Promise<Repository | undefined>>();
	const sends = await flakesThere(builds, repos.value, takes, gits);
	// run-subtests --there hands `there` its tree, whatever state it's in.
	const runs =
		takes.tree && takes.subtests
			? await runsThere(asked, repos.value, takes, gits)
			: [];
	if (sends.length === 0 && runs.length === 0) return undefined;
	// One that asks for a builder itself waits for it; else wait here.
	if (!takes.wants && !(await builderReady(undefined, signal))) {
		return undefined;
	}
	return sentThere(command, sends, runs);
}

/** The repository a flake's folder is in, asked of git once a command. */
function repositoryOnce(
	gits: Map<string, Promise<Repository | undefined>>,
	flake: string,
	whole: boolean,
	pin?: CheckBuild["pin"],
): Promise<Repository | undefined> {
	const pinned = pin ? `${pin.folder}\0${pin.ref}` : "";
	const key = `${flake}\0${whole}\0${pinned}`;
	const repository = gits.get(key) ?? repositoryAt(flake, { whole, pin });
	gits.set(key, repository);
	return repository;
}

/**
 * Each run-subtests step whose tree is of a repository named to send, or
 * a copy with no origin where `there` takes a folder.
 */
async function runsThere(
	runs: readonly SubtestsRun[],
	repos: readonly string[],
	takes: Takes,
	gits: Map<string, Promise<Repository | undefined>>,
): Promise<SubtestsRun[]> {
	const going: SubtestsRun[] = [];
	for (const run of runs) {
		const found = await repositoryOnce(gits, run.flake, false);
		const goes =
			(found && flakeThere(found, repos, run.flake)) ??
			copyThere(found, run.flake, false, takes);
		if (goes) going.push(run);
	}
	return going;
}

/** Each build that may go, with the flake the builder fetches for it. */
async function flakesThere(
	builds: readonly CheckBuild[],
	repos: readonly string[],
	takes: Takes,
	gits: Map<string, Promise<Repository | undefined>>,
): Promise<{ build: CheckBuild; flake: string }[]> {
	const sends: { build: CheckBuild; flake: string }[] = [];
	for (const build of builds) {
		const found = await repositoryOnce(
			gits,
			build.flake,
			build.whole,
			build.pin,
		);
		// A pinned build is of its commit, which only GitHub can give.
		const tree = takes.tree && !build.pin ? build.flake : undefined;
		const copy = build.pin
			? undefined
			: copyThere(found, build.flake, build.whole, takes);
		const flake = (found && flakeThere(found, repos, tree)) ?? copy;
		if (flake) sends.push({ build, flake });
	}
	return sends;
}
