/**
 * Review rounds said in their run records, the mesh's `runs/` files the
 * launcher reads through the node, under the session that asked.
 *
 * A round opens with every participant it will ask, so its record
 * starts there, each one queued, and ends once each has been asked and
 * has answered. A round that asks without opening, as a retry does,
 * is said from its first ask. A detached round ends its record once its
 * reviewers are started, and the record goes on saying them until each
 * has ended, since nobody waits on them.
 */

import type {
	AskRound,
	AskRun,
	ChangeRef,
} from "../../lib/core/review/index.ts";
import {
	type MemberAsked,
	type RunWatch,
	watchRun,
} from "../../lib/subagent/run-record.ts";
import { runArtifactDir, sessionKey } from "./engine.ts";

/** A round being said, and who in it is yet to answer. */
interface Held {
	readonly watch: RunWatch;
	readonly waiting: Set<string>;
}

const held = new Map<string, Held>();

/** Say a round from when it opens, with everyone it will ask. */
export function roundOpened(change: ChangeRef, run: AskRun): void {
	const one = holding(change, run.round, run.id, run.participants);
	for (const participant of run.participants) one.waiting.add(participant.id);
}

/**
 * Ask one participant, said in its round's record; the record ends once
 * nobody in the round is left to answer.
 */
export async function askedInRound<T>(
	change: ChangeRef,
	round: AskRound,
	runId: string,
	participant: MemberAsked,
	ask: () => Promise<T>,
): Promise<T> {
	const one = holding(change, round, runId, [participant]);
	one.waiting.add(participant.id);
	try {
		return await ask();
	} finally {
		one.waiting.delete(participant.id);
		if (one.waiting.size === 0 && held.get(runId) === one) {
			held.delete(runId);
			await one.watch.end();
		}
	}
}

/** A detached round's reviewers are started: say how each ends. */
export async function roundDispatched(runId: string): Promise<void> {
	const one = held.get(runId);
	held.delete(runId);
	await one?.watch.end();
}

function holding(
	change: ChangeRef,
	round: AskRound,
	runId: string,
	members: readonly MemberAsked[],
): Held {
	const known = held.get(runId);
	if (known !== undefined) {
		for (const member of members) known.watch.note(asMember(member));
		return known;
	}
	const made: Held = {
		watch: watchRun(
			{
				store: "review",
				artifacts: runArtifactDir(),
				runId,
				kind: round,
				parent: sessionKey(),
				about: change.label,
				since: new Date(),
			},
			members.map(asMember),
		),
		waiting: new Set(),
	};
	held.set(runId, made);
	return made;
}

/** Only what the record says of a member, from a fuller participant. */
function asMember(member: MemberAsked): MemberAsked {
	return {
		id: member.id,
		...(member.model === undefined ? {} : { model: member.model }),
		...(member.persona === undefined ? {} : { persona: member.persona }),
	};
}
