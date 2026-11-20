/**
 * mesh_sprout: new work fed in from inside pi, started by the node as a
 * cell of its own and tied to this one, as the launcher's Start New
 * Work and `mycelium sprout` start it.
 */

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
): Promise<Answer> {
	const sprouting: Sprouting = {
		words: params.words,
		...(params.folder !== undefined ? { folder: params.folder } : {}),
		...(params.machine !== undefined ? { on: params.machine } : {}),
		...(address ? { from: address } : {}),
	};
	const answered = await sprout(sprouting, cwd, run);
	if (!answered.ok) {
		return answer(
			`⊘ Nothing was sprouted: ${answered.reason}`,
			answered.mayLand ? { mayLand: true } : {},
		);
	}
	const { machine, folder, attach } = answered.started;
	const tied = address
		? ` Its quest is tied to this cell, ${address}, on the map.`
		: "";
	return answer(
		`Sprouted on ${machine} in ${folder}: a session of its own makes its quest and starts on the work.${tied} It runs in no window; Go To on it in the launcher's Agents opens it, or join it from a terminal with: ${attach.join(" ")}`,
		{ started: answered.started },
	);
}
