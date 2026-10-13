/**
 * Where a fleet is asked from, for choosing what its jobs run on.
 *
 * The project is named the way a review round names one, by the key
 * the review provider that serves the checkout gives it (for example
 * `github:Jitsusama/agentic-harness.pi`), so one key means the same
 * repository under `subagent.projects` and `review.ask.projects`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRepo } from "@jitsusama/agentic-harness.core/review";
import { questLoadedIn } from "../../lib/internal/quest/loaded.ts";
import type { FleetPlace, JobSettings } from "./sizing.ts";

const run = promisify(execFile);

/** Long enough for git on a cold disk; a fleet does not wait on more. */
const GIT_TIMEOUT_MS = 2_000;

/** Where this fleet is being asked from. */
export async function fleetPlace(
	ctx: ExtensionContext,
	runDefaults: JobSettings | undefined,
): Promise<FleetPlace> {
	// A context built outside a session (a script, a test) may hold none
	// of these, and a layer with nothing to go on simply says nothing.
	const sessionId = ctx.sessionManager?.getSessionId();
	const [quest, project] = await Promise.all([
		sessionId === undefined ? undefined : questLoadedIn(sessionId),
		ctx.cwd === undefined ? undefined : projectOf(ctx.cwd),
	]);
	return {
		...(runDefaults === undefined ? {} : { run: runDefaults }),
		...(quest === undefined ? {} : { quest }),
		...(project === undefined ? {} : { project }),
		...(ctx.model === undefined
			? {}
			: { sessionModel: `${ctx.model.provider}/${ctx.model.id}` }),
	};
}

/** The repository key for a checkout, when a review provider serves it. */
export async function projectOf(cwd: string): Promise<string | undefined> {
	let remote: string;
	try {
		const answered = await run(
			"git",
			["-C", cwd, "remote", "get-url", "origin"],
			{
				timeout: GIT_TIMEOUT_MS,
			},
		);
		remote = answered.stdout.trim();
	} catch {
		// Not a checkout, no origin, or no git: a fleet asked from here has
		// no project, which only means that layer has nothing to say.
		return undefined;
	}
	if (!remote) return undefined;
	const resolved = resolveRepo({ repoRoot: cwd, remoteUrls: [remote] });
	return resolved.resolved ? resolved.repo.key : undefined;
}
