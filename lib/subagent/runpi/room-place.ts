/**
 * Which cloud machine a reviewer asked on the `cloud` room goes to,
 * asked of the node with `mycelium place` as the reviewer starts.
 *
 * Asked here, in the session asking the round, before the reviewer's
 * request is written, rather than in its supervisor: the request then
 * names the one machine its supervisor runs it on, as a named room's
 * does, and the supervisor, a plain script, keeps no reading of the
 * node's answers of its own. One ask a reviewer, since a placement
 * answers one machine and counts no places: asked once a round, every
 * reviewer of it would go where the first one went.
 */

import { execFile } from "node:child_process";
import { placedFrom } from "../../mesh/placement.ts";
import { shownEnds } from "../../mesh/shown-line.ts";
import { roomEnv } from "./room-env.ts";
import { placeWords, type RoomPlace } from "./room-launch.ts";

/**
 * How long the node has to place a reviewer. It answers a placement
 * from what it knows within a second even loaded, so a minute is a
 * node that is wedged or unreachable, and the reviewer fails rather
 * than holding its round's start.
 */
export const PLACE_PATIENCE_MS = 60_000;

/** The machine the node placed a reviewer on, or why it placed it on none. */
export type RoomPlaced =
	| { readonly machine: string }
	| { readonly stays: string };

/**
 * Asks the node at `place` which cloud machine a reviewer with `wallMs`
 * on its clock goes to, from the folder `cwd`, which is the reviewer's
 * own and never the tree under review.
 */
export function roomPlaced(
	place: RoomPlace,
	wallMs: number,
	cwd: string,
	patience: number = PLACE_PATIENCE_MS,
): Promise<RoomPlaced> {
	return new Promise((resolve) => {
		execFile(
			place.mycelium,
			placeWords(place, wallMs),
			{
				cwd,
				env: roomEnv(process.env, place.mycelium),
				timeout: patience,
				killSignal: "SIGKILL",
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				resolve(placedOrWhy(error, stdout, stderr, patience));
			},
		);
	});
}

/** The node's answer read, or why there is none to read. */
function placedOrWhy(
	error: (Error & { killed?: boolean }) | null,
	stdout: string,
	stderr: string,
	patience: number,
): RoomPlaced {
	if (error?.killed) {
		return {
			stays: `the node placed it nowhere within ${Math.round(patience / 1000)} s`,
		};
	}
	const line = stdout.trim().split("\n").at(-1) ?? "";
	if (line === "") {
		const said = shownEnds(stderr, 200);
		return {
			stays: `the node's place failed: ${said === "" ? (error?.message ?? "it said nothing") : said}`,
		};
	}
	const answer = placedFrom(line);
	return answer.ok
		? { machine: answer.machine }
		: { stays: `the node placed it on no machine: ${answer.reason}` };
}
