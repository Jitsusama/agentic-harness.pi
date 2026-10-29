/**
 * Remote Check Interceptor Extension
 *
 * Sends a session's VM checks of a public repository to the lent
 * builder by commit: a step building `nix build --no-link` of a flake's
 * checks, in a clean tree whose HEAD a remote has, becomes
 * `nix-offload there github:<owner>/<repo>/<rev> <checks>` in its own
 * place while a builder stands, waiting a few minutes while one is being
 * lent. The builder fetches the commit itself, so nothing built here is
 * uploaded, and the machine queue gives the step no turn here. Anything
 * else runs as written. Repositories are named in the package config's
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
	parseRemoteChecks,
	REMOTE_CHECKS_SLUG,
	type Repository,
	repositoryAt,
	sentThere,
} from "../../lib/internal/priority/there.ts";
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
	const builds = steps ? checkBuildsOf(steps, home) : [];
	if (builds.length === 0) return undefined;
	const loaded = await loadPackageConfig(packageConfigPath());
	if (!loaded.ok) return undefined;
	const repos = parseRemoteChecks(loaded.config.sections[REMOTE_CHECKS_SLUG]);
	if (!repos.ok || repos.value.length === 0) return undefined;
	const sends = await flakesThere(builds, repos.value);
	if (sends.length === 0) return undefined;
	if (!(await builderReady(undefined, signal))) return undefined;
	return sentThere(command, sends);
}

/** Each build that may go, with the flake the builder fetches for it. */
async function flakesThere(
	builds: readonly CheckBuild[],
	repos: readonly string[],
): Promise<{ build: CheckBuild; flake: string }[]> {
	const asked = new Map<string, Promise<Repository | undefined>>();
	const sends: { build: CheckBuild; flake: string }[] = [];
	for (const build of builds) {
		const pin = build.pin ? `${build.pin.folder}\0${build.pin.ref}` : "";
		const key = `${build.flake}\0${build.whole}\0${pin}`;
		const repository =
			asked.get(key) ??
			repositoryAt(build.flake, { whole: build.whole, pin: build.pin });
		asked.set(key, repository);
		const found = await repository;
		const flake = found ? flakeThere(found, repos) : undefined;
		if (flake) sends.push({ build, flake });
	}
	return sends;
}
