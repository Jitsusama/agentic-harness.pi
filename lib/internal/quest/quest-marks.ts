/**
 * The marks a quest is drawn with, wherever it is drawn.
 *
 * The board under the editor and the table of contents both show a
 * quest's kind and status. The table spelled its own statuses as a
 * filling pie, which drew a retired quest three quarters full and a
 * blocked one half done, while the board drew a refusal for blocked and
 * a crossed circle for retired. The same quest read two ways, so the
 * marks live here and both draw them.
 *
 * Quests own the diamonds and the circles; work owns squares and review
 * triangles, which the package's glyph test holds them to.
 */

import type { QuestKind, QuestStatus } from "../../quest/types.ts";

/**
 * A filled diamond for a quest, one held in another for a subquest and
 * a hollow one for a sidequest.
 */
export const QUEST_KIND_MARK: Record<QuestKind, string> = {
	quest: "\u25c6", // ◆
	subquest: "\u25c8", // ◈
	sidequest: "\u25c7", // ◇
};

/**
 * Open while under way, half while set down, a refusal while something
 * stands in its way, full once concluded and crossed out once retired.
 */
export const QUEST_STATUS_MARK: Record<QuestStatus, string> = {
	active: "\u25cb", // ○
	paused: "\u25d0", // ◐
	blocked: "\u2298", // ⊘
	concluded: "\u25cf", // ●
	retired: "\u2297", // ⊗
};
