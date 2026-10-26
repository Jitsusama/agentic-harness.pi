/**
 * Add a Journey entry to a quest at a known path. Pure file
 * operation, no extension state involved. The extension's
 * `appendJourneyEntry` wraps this for the loaded-quest case; a
 * caller holding a path uses this directly so it can write to any
 * quest the alias index points it at.
 *
 * The entry goes to the head of the quest's Journey file
 * (`attachments/journey.md`), newest first; the README keeps one
 * line pointing at it. See `journey.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { nowYmd } from "./dates.ts";
import { withQuestLock } from "./io.ts";
import { sweepJourneyUnlocked } from "./journey-sweep.ts";

/**
 * Add a dated entry to the head of a quest's Journey. Anything
 * still in the README's Journey section is swept into the file
 * first, so the new entry lands above it and the README is left
 * holding its pointer. `now` is injected so tests can pin the date
 * stamp.
 *
 * Returns `true` on success, `false` when the README is missing so
 * callers can log instead of silently dropping the entry.
 */
export function appendJourneyByPath(
	questDir: string,
	prose: string,
	opts?: { now?: () => Date },
): boolean {
	if (!existsSync(join(questDir, "README.md"))) return false;
	const bullet = `- **${nowYmd(opts?.now)}**: ${prose.trim()}`;
	return withQuestLock(
		questDir,
		() => sweepJourneyUnlocked(questDir, [bullet]) !== undefined,
	);
}
