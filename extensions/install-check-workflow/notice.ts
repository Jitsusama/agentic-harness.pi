/**
 * What the install check says, in words a person can act on.
 */

import type { HeadMove } from "../../lib/internal/install/head.ts";

/** Characters of a commit id worth showing. */
const SHORT_ID = 8;

const short = (id: string) => id.slice(0, SHORT_ID);

/** Installed dependencies that are not the ones the code asks for. */
export function driftNotice(drift: string, command: string): string {
	return `agentic-harness.pi: installed dependencies do not match package.json: ${drift}. Run \`${command}\` in the package, then /reload.`;
}

/** The checkout moved under the running code. */
export function moveNotice(move: HeadMove): string {
	return `agentic-harness.pi: the checkout moved from ${short(move.loaded)} to ${short(move.now)} since this code loaded. /reload to run it.`;
}

/** The checkout is behind its upstream as of the last fetch. */
export function behindNotice(behind: number): string {
	const commits = behind === 1 ? "1 commit" : `${behind} commits`;
	return `agentic-harness.pi: the checkout is ${commits} behind its upstream as of the last fetch. Pull, then /reload.`;
}
