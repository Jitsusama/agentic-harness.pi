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

import { homedir } from "node:os";
import { loadPackageConfig } from "../config/loader.ts";
import { packageConfigPath } from "../paths.ts";
import { stepsOf } from "../shell/steps.ts";
import {
	builderReady,
	type CheckBuild,
	checkBuildsOf,
	flakeThere,
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

/** What `nix-offload there` takes, asked at most once a minute. */
function takesNow(now = Date.now()): Promise<Takes> {
	const store = kept();
	if (store.takes === undefined || now - store.takes.at >= TAKES_MS) {
		store.takes = { at: now, takes: offloadTakes() };
	}
	return store.takes.takes;
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
			? await runsThere(asked, repos.value, gits)
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

/** Each run-subtests step whose tree is of a repository named to send. */
async function runsThere(
	runs: readonly SubtestsRun[],
	repos: readonly string[],
	gits: Map<string, Promise<Repository | undefined>>,
): Promise<SubtestsRun[]> {
	const going: SubtestsRun[] = [];
	for (const run of runs) {
		const found = await repositoryOnce(gits, run.flake, false);
		if (found && flakeThere(found, repos, run.flake)) going.push(run);
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
		const flake = found ? flakeThere(found, repos, tree) : undefined;
		if (flake) sends.push({ build, flake });
	}
	return sends;
}
