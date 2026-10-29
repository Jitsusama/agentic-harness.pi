/**
 * Remote Check Interceptor Extension
 *
 * Sends a session's VM checks of a public repository to the lent
 * builder by commit: a lone `nix build --no-link` of `.#checks...`,
 * in a clean tree whose HEAD a remote has, becomes
 * `nix-offload there github:<owner>/<repo>/<rev> <checks>` while a
 * builder stands, waiting a few minutes while one is being lent. The
 * builder fetches the commit itself, so nothing built here is uploaded,
 * and the machine queue gives it no turn here. Anything else runs as
 * written. Repositories are named in the package config's
 * `remote-checks.repos`; none are by default.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { loadPackageConfig } from "../../lib/internal/config/loader.ts";
import { packageConfigPath } from "../../lib/internal/paths.ts";
import {
	builderReady,
	parseRemoteChecks,
	REMOTE_CHECKS_SLUG,
	repositoryAt,
	sentThere,
	vmChecksOf,
} from "../../lib/internal/priority/there.ts";

export default function remoteCheckInterceptor(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		const sent = await sendingThere(command, ctx.cwd, ctx.signal);
		if (sent !== undefined) {
			(event.input as { command: string }).command = sent;
		}
		return undefined;
	});
}

/**
 * What to run instead of `command`, saying first where it went, or
 * nothing to run it as written. Each question is asked only once the
 * cheaper ones before it allow the command to go.
 */
async function sendingThere(
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (!vmChecksOf(command)) return undefined;
	const loaded = await loadPackageConfig(packageConfigPath());
	if (!loaded.ok) return undefined;
	const repos = parseRemoteChecks(loaded.config.sections[REMOTE_CHECKS_SLUG]);
	if (!repos.ok || repos.value.length === 0) return undefined;
	const repository = await repositoryAt(cwd);
	if (!repository) return undefined;
	const there = sentThere(command, repository, repos.value);
	if (!there) return undefined;
	if (!(await builderReady(undefined, signal))) return undefined;
	const said = `remote-check: sent to the lent builder by commit ${repository.head.slice(0, 12)}, nothing uploaded`;
	return `printf '%s\\n' '${said}' >&2; ${there}`;
}
