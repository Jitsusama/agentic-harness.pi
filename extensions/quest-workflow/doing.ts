/**
 * Keeps what this session is doing said for its presence: the focused
 * plan's next item and the quest's newest choice, written when a quest
 * action, a write to the focused plan or a start may have moved them,
 * and taken away when the session ends (lib/internal/quest/doing.ts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestState } from "../../lib/core/quest/state.ts";
import {
	doingFolder,
	doingNow,
	sayDoing,
} from "../../lib/internal/quest/doing.ts";
import { currentSessionId } from "./verbs/shared.ts";

/** Say what this session is doing now, or that it is doing nothing. */
export function keepDoingSaid(
	state: QuestState,
	ctx: ExtensionContext,
	folder: string = doingFolder(),
): void {
	const session = currentSessionId(ctx, undefined);
	if (!session) return;
	try {
		sayDoing(folder, session, doingNow(state), new Date());
	} catch (error) {
		// The quest's own work doesn't wait on a map's field, but the
		// person hears that the map can't show this session.
		const why = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			`The map can't show what this session is doing: ${why}`,
			"warning",
		);
	}
}

/** Take away what an ended session said it was doing. */
export function forgetDoing(
	session: string,
	folder: string = doingFolder(),
): void {
	try {
		sayDoing(folder, session, undefined, new Date());
	} catch {
		// An ended session has no presence to carry it, and the session's
		// next start says its own over whatever was left.
	}
}
