/**
 * Remote Check Interceptor Extension
 *
 * Sends a session's VM checks of a public repository to the lent
 * builder by commit: a step building `nix build --no-link` of a flake's
 * checks becomes `nix-offload there <flake> <checks>` in its own place,
 * the flake `github:<owner>/<repo>/<rev>` for a clean tree whose HEAD a
 * remote has, and the tree itself for any other where `there` takes
 * one, sending only the commits GitHub lacks. A `run-subtests` step
 * becomes `run-subtests --there` where `there` can build it. The builder
 * fetches the rest itself, so nothing built here is uploaded, and the
 * machine queue gives the step no turn here. Anything else runs as
 * written. Repositories are named in the package config's
 * `remote-checks.repos`; none are by default.
 */

import { homedir } from "node:os";

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { loadPackageConfig } from "../../lib/internal/config/loader.ts";
import { packageConfigPath } from "../../lib/internal/paths.ts";
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
} from "../../lib/internal/priority/there.ts";

/** How long what `nix-offload there` takes is trusted before asking again. */
const TAKES_MS = 60_000;

let takesAsked:
	| { readonly at: number; readonly takes: Promise<Takes> }
	| undefined;

/** What `nix-offload there` takes, asked at most once a minute. */
function takesNow(now = Date.now()): Promise<Takes> {
	if (takesAsked === undefined || now - takesAsked.at >= TAKES_MS) {
		takesAsked = { at: now, takes: offloadTakes() };
	}
	return takesAsked.takes;
}

import { stepsOf } from "../../lib/internal/shell/steps.ts";

export default function remoteCheckInterceptor(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const sent = await sendingThere(event.input.command, ctx.cwd, ctx.signal);
		if (sent !== undefined) {
			(event.input as { command: string }).command = sent;
		}
		return undefined;
	});
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
