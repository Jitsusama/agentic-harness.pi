/**
 * Priority Workflow Extension
 *
 * Keeps pi ahead of the work it starts. pi is something a person works
 * in, and a build, a test run or a subagent it starts should never make
 * it, or anything else the person is using, slow to answer. Where the
 * machine keeps an idle cgroup for work and names it in `JOBS_CGROUP`,
 * every process pi spawns is written into it as it is spawned; pi stays
 * where it was started. Without the setting, or off Linux, nothing
 * changes. A setting that names a cgroup that isn't there is said once.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jobsProcs, placeChildren } from "../../lib/internal/priority/place.ts";

function ownCgroup(): string | undefined {
	try {
		return readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return undefined;
	}
}

export default function priorityWorkflow(pi: ExtensionAPI) {
	if (process.platform !== "linux") return;
	const own = ownCgroup();
	const path = own ? jobsProcs(own, process.env.JOBS_CGROUP) : undefined;
	if (!path) return;
	if (existsSync(path)) {
		placeChildren(path);
		return;
	}
	let said = false;
	pi.on("session_start", async (_event, ctx) => {
		if (said || !ctx.hasUI) return;
		said = true;
		ctx.ui.notify(
			`JOBS_CGROUP names ${path}, which isn't there, so what pi starts runs at pi's own priority.`,
			"warning",
		);
	});
}
