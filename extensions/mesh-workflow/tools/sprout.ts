/**
 * mesh_sprout: new work fed in from inside pi, started by the node as a
 * cell of its own and tied to this one, as the launcher's Start New
 * Work and `mycelium sprout` start it.
 */

import { asSentence, laterTry, shownAttach } from "../../../lib/mesh/node.ts";
import {
	type RunProgram,
	runProgram,
	type Sprouting,
	sprout,
} from "../../../lib/mesh/sprout.ts";
import { type Answer, answer } from "./local.ts";

/** What mesh_sprout is called with. */
export interface SproutParams {
	readonly words: string;
	readonly folder?: string;
	readonly machine?: string;
}

/**
 * Sprouts what `params` asks from `cwd`, tied to the cell at `address`
 * when this session is on the mesh, answering where it started and how
 * to reach it, or why nothing started.
 */
export async function sproutFrom(
	params: SproutParams,
	cwd: string,
	address: string | undefined,
	run: RunProgram = runProgram,
	signal?: AbortSignal,
): Promise<Answer> {
	const sprouting: Sprouting = {
		words: params.words,
		...(params.folder !== undefined ? { folder: params.folder } : {}),
		...(params.machine !== undefined ? { on: params.machine } : {}),
		...(address ? { from: address } : {}),
	};
	const answered = await sprout(sprouting, cwd, run, signal);
	if (!answered.ok) {
		if (answered.mayLand) {
			return answer(`The sprout may have started; ${answered.reason}.`, {
				mayLand: true,
			});
		}
		const later = laterTry(answered.reason);
		const reason = later
			? `${asSentence(answered.reason)}${later}`
			: answered.reason;
		return answer(`⊘ Nothing was sprouted: ${reason}`, {});
	}
	// The node's own words, as they show (node.ts's startedFrom), the
	// folder and the words that join it quoted, since another node wrote
	// them.
	const { machine, folder, attach } = answered.started;
	const where = folder ? `in "${folder}"` : "in its home";
	const tied = address
		? ` A quest it makes, it asks to tie to this cell, ${address}, on the map as it starts; one it joins, this start doesn't tie. Until the map shows the tie, it isn't there.`
		: "";
	return answer(
		`Sprouted on ${machine} ${where}: a session of its own makes its quest, or joins a live one already holding the work, and starts on it.${tied} It runs in no window; Go To on it in the launcher's Agents opens it, or join it from a terminal with: "${shownAttach(attach.join(" "))}"`,
		{ started: answered.started },
	);
}
