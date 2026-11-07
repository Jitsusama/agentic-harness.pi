/**
 * Where a quest's session window goes under niri: on its orchestrator's
 * workspace, with the orchestrator's window first and its sessions
 * after it by title (P9R1KI [871f8a4f], KP0L6A [03caeb43]).
 *
 * A session's orchestrator is the nearest orchestrating quest above its
 * own, and its window the one whose title the session signing with that
 * quest's address last said. An orchestrator goes where the sessions it
 * orchestrates are, and first among them, so two orchestrators never
 * share a workspace. Either falls back to the window the session itself
 * last had, and the library then to the asker's.
 */

import { join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import type { QuestIndex } from "../../lib/internal/quest/discovery.ts";
import { orchestrationOf } from "../../lib/internal/quest/orchestration.ts";
import { questAddress } from "../../lib/mesh/address.ts";
import {
	createPresences,
	type Presence,
	windowTitle,
} from "../../lib/mesh/presence.ts";
import type { WindowPlace } from "../../lib/terminal/index.ts";
import { shortNameOf } from "./lifecycle.ts";
import { sessionNameFor } from "./render.ts";

/** The window titles presence last gave, newest first. */
function titlesOf(presences: readonly Presence[]): string[] {
	return [...presences]
		.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
		.flatMap((one) => (one.title ? [one.title] : []));
}

/**
 * Where the window of a session on `questId`, in `cwd`, goes: beside
 * the windows that say where its orchestration is, in its order.
 */
export function windowPlaceFor(
	questId: string,
	cwd: string,
	index: QuestIndex,
	presences: readonly Presence[],
	session?: string,
): WindowPlace {
	const entry = index.quests.get(questId);
	const read = (id: string) => index.quests.get(id)?.doc.frontMatter;
	const orchestration = orchestrationOf(questId, read);
	const name = entry
		? sessionNameFor(
				entry.doc.title ?? null,
				shortNameOf(entry.doc.frontMatter),
			)
		: undefined;
	const title = windowTitle(name, cwd);
	const own = titlesOf(
		presences.filter((one) => session !== undefined && one.session === session),
	);
	if (orchestration.heads) {
		const address = questAddress(orchestration.heads);
		const led = titlesOf(
			presences.filter(
				(one) => one.orchestratedBy === address && one.session !== session,
			),
		);
		return { beside: [...led, ...own], first: title, title };
	}
	if (!orchestration.by) return { beside: own, title };
	const address = questAddress(orchestration.by);
	const orchestrator = titlesOf(
		presences.filter(
			(one) =>
				one.session !== session &&
				(one.orchestrates === address || one.addresses[0] === address),
		),
	);
	return {
		beside: [...orchestrator, ...own],
		...(orchestrator[0] ? { first: orchestrator[0] } : {}),
		title,
	};
}

/** Every peer's presence on this machine, as the mesh last wrote it. */
export function presencesHere(): Presence[] {
	return createPresences(join(stateDir("mesh-workflow"), "presence")).all();
}
