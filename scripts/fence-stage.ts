/**
 * Name sessions for the agent fence's first stage by hand, or take them
 * off it, from outside the fence (inside, pi's state is read-only). A
 * listed session's pi is fenced from its next start unless it sets
 * PI_SANDBOX=off; one taken off runs as before from its next start.
 *
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/fence-stage.ts list <session-id> <why>
 *   node scripts/fence-stage.ts unlist <session-id>
 *   node scripts/fence-stage.ts show
 */

import {
	listForStage,
	stagedSessions,
	unlistForStage,
} from "../lib/internal/fence-stage.ts";

const USAGE =
	"usage: fence-stage.ts list <session-id> <why> | unlist <session-id> | show";

function main(args: readonly string[]): number {
	const [verb, session, ...why] = args;
	if (verb === "show" && session === undefined) {
		for (const one of stagedSessions()) console.log(one);
		return 0;
	}
	if (verb === "list" && session && why.length > 0) {
		listForStage(session, why.join(" "));
		console.log(`listed ${session}: fenced from its next start`);
		return 0;
	}
	if (verb === "unlist" && session && why.length === 0) {
		const was = unlistForStage(session);
		console.log(
			was
				? `unlisted ${session}: runs as before from its next start`
				: `${session} wasn't listed`,
		);
		return 0;
	}
	console.error(USAGE);
	return 2;
}

process.exitCode = main(process.argv.slice(2));
