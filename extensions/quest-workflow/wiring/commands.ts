/**
 * The quest workflow's slash commands, for a person at the prompt:
 * `/quest` to see the loaded quest or list them, and `/quest-resume`
 * to carry on one of its sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAllQuests } from "../lifecycle.ts";
import { formatQuestList } from "../render.ts";
import { resumeQuestSession } from "../resume.ts";
import type { QuestState } from "../state.ts";

/** Register `/quest` and `/quest-resume` over the given state. */
export function registerQuestCommands(
	pi: ExtensionAPI,
	state: QuestState,
): void {
	pi.registerCommand("quest", {
		description:
			"Show the loaded quest, or `/quest list` to discover quests under the questsRoot.",
		handler: async (args, ctx) => {
			if (args?.trim() === "list") {
				const entries = listAllQuests(state);
				ctx.ui.notify(
					entries.length > 0
						? formatQuestList(entries)
						: `No quests under ${state.questsRoot}.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				state.questId
					? `Quest ${state.questId} (${state.questStatus}/${state.questPriority}) → ${state.questDir}`
					: "No quest loaded.",
				"info",
			);
		},
	});

	pi.registerCommand("quest-resume", {
		description:
			"Carry on a session attached to the loaded quest: switch pi to it, or in a host, have the host adopt it. Usage: `/quest-resume <session-id>`",
		handler: (args, ctx) => resumeQuestSession(pi, state, args, ctx),
	});
}
