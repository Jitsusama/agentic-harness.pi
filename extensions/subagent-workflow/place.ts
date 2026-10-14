/**
 * Where a fleet is asked from, for choosing what its jobs run on.
 *
 * The project is named by `projectOf`, the same key `review.ask` and
 * `terminal` settings use, so one key means one repository everywhere.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectOf } from "../../lib/internal/project.ts";
import { questLoadedIn } from "../../lib/internal/quest/loaded.ts";
import type { FleetPlace, JobSettings } from "./sizing.ts";

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

export { projectOf };
