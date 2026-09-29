/**
 * `/jobs`: the person's view of what is running in the background, and
 * the way to stop one.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { JobEntry, Jobs } from "./jobs.ts";

const STOP = "Stop it";
const LEAVE = "Leave it running";

/** How one job reads in the list. */
function describe(entry: JobEntry): string {
	const state =
		entry.state === "running" ? "running" : "finished, waiting to be said";
	return `${entry.spec.kind}: ${entry.spec.label} (${state})`;
}

/** List the jobs, and stop the one the person picks if they confirm. */
export async function showJobs(
	jobs: Jobs | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const entries = jobs?.list() ?? [];
	if (!jobs || entries.length === 0) {
		ctx.ui.notify("No background jobs.", "info");
		return;
	}
	const options = entries.map(describe);
	const picked = await ctx.ui.select("Background jobs", options);
	const entry =
		picked === undefined ? undefined : entries[options.indexOf(picked)];
	if (!entry) return;
	if (entry.state !== "running") {
		ctx.ui.notify(
			`${entry.spec.label} has finished; its result is on its way.`,
			"info",
		);
		return;
	}
	const answer = await ctx.ui.select(`Stop ${entry.spec.label}?`, [
		STOP,
		LEAVE,
	]);
	if (answer === STOP) jobs.stop(entry.id);
}
