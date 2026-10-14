/**
 * Which project a checkout is, for settings keyed by project.
 *
 * The project is named the way a review round names one, by the key
 * the review provider that serves the checkout gives it (for example
 * `github:Jitsusama/agentic-harness.pi`), so one key means the same
 * repository under `subagent.projects`, `review.ask.projects` and
 * `terminal.projects`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRepo } from "@jitsusama/agentic-harness.core/review";

const run = promisify(execFile);

/** Long enough for git on a cold disk; nothing asking waits on more. */
const GIT_TIMEOUT_MS = 2_000;

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
		// Not a checkout, no origin, or no git: a request from here has
		// no project, which only means that layer has nothing to say.
		return undefined;
	}
	if (!remote) return undefined;
	const resolved = resolveRepo({ repoRoot: cwd, remoteUrls: [remote] });
	return resolved.resolved ? resolved.repo.key : undefined;
}
