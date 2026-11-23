/**
 * A spawn whose host's child runs the session it asked for but gave no
 * answer in time, as it loads under a busy machine: opened or adopted
 * all the same, so the spawn attaches to it rather than open another.
 */

import type { HostKind } from "../../../host/service/address.ts";
import {
	attachWords,
	holdOf,
} from "../../../lib/internal/session/host-holds.ts";
import { ok, type QuestResult } from "./shared.ts";

/** What the answer says of the spawn it answers. */
interface OpeningSpawn {
	readonly kind: HostKind;
	readonly questId: string;
	readonly cwd: string;
	/** How the folder was picked, as the spawn's words say it. */
	readonly chosenBy: string;
	readonly untold?: boolean;
}

/**
 * The answer for a session the host's child runs but gave no answer for
 * in time: opened or adopted, its request in hand, with what it holds
 * unread, so only its id is named, and for an attended one how to view it.
 */
export function stillOpening(
	spawn: OpeningSpawn,
	key: string,
	sessionId: string,
	adopting: boolean,
): QuestResult {
	const attach =
		spawn.kind === "attended"
			? attachWords(holdOf(key, true), sessionId)
			: undefined;
	const screen = attach
		? `Its screen waits in the host until a viewer attaches: ${attach.join(" ")}`
		: "It runs in the background, with no screen.";
	const late =
		"its process gave no answer in time, but runs it, so nothing else was";
	const said = adopting
		? `The ${key} host is still adopting session ${sessionId}: ${late} adopted. It isn't told anything, so it waits where its log stopped. ${screen}`
		: `The ${key} host is still opening session ${sessionId} in ${spawn.cwd} (${spawn.chosenBy}), which loads ${spawn.questId}: ${late} opened. It ${spawn.untold ? "waits for its first words" : "is told to carry on"} once it has loaded. ${screen}`;
	return ok(said, {
		how: "host",
		host: key,
		sessionId,
		loading: true,
		attended: spawn.kind === "attended",
		autoloadQuestId: spawn.questId,
		...(attach ? { attach } : {}),
		...(adopting ? { resumedSessionId: sessionId } : {}),
	});
}
