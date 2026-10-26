/**
 * An orchestrator's standing rules, flowing down to the quests below it.
 *
 * The person writes the rules every quest in an orchestration follows
 * into the orchestrator quest's README, under Context. Each session
 * was told to read that README before starting, and the mission's was
 * 49 KB, of which the Context section is about 4 KB. This puts that
 * section, and only it, in the prompt of every session on a quest
 * below a marked orchestrator, as a standing context (lib/prompt): it
 * freezes into the system prompt at the first turn, and a later edit
 * to the section, or a session loading a quest under another
 * orchestrator, is said once as a message. The orchestrator's own
 * session reads its README itself and gets nothing here.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseQuestFrontMatter } from "../../lib/internal/quest/frontmatter.ts";
import { orchestrationOf } from "../../lib/internal/quest/orchestration.ts";
import { extractSection } from "../../lib/internal/quest/quest-doc.ts";
import type { StandingContextWording } from "../../lib/prompt/index.ts";
import type { QuestFrontMatter } from "../../lib/quest/types.ts";

const LABEL = "[Standing rules]";

/** How the standing rules read in the prompt and when they change. */
export const STANDING_RULES: StandingContextWording = {
	customType: "orchestrator-standing-rules",
	inPrompt: (text) => `\n\n${LABEL} ${text}`,
	changed: (text) =>
		text === null
			? `${LABEL} Now: no orchestrator's standing rules apply. This supersedes the standing rules given earlier.`
			: `${LABEL} Now: ${text} This supersedes the standing rules given earlier.`,
};

/** Reads a quest's README by id, or undefined when it has none. */
export type ReadmeReader = (quest: string) => string | undefined;

/**
 * The standing rules for a session on this quest: the Context section
 * of the orchestrator quest above it, or null when none is above it or
 * its section is empty.
 */
export function standingRulesFor(
	quest: string,
	read: ReadmeReader,
): string | null {
	const by = orchestratorOf(quest, read);
	return by === undefined ? null : rulesIn(by, read(by));
}

/**
 * The standing rules for whichever quest is loaded, read again only
 * when the loaded quest, its own README (a reparent, a moved mark) or
 * its orchestrator's README changes, since the prompt asks on every
 * turn.
 */
export function standingRules(
	questsRoot: () => string,
): (quest: string | null) => string | null {
	let last:
		| {
				quest: string;
				own?: number;
				by?: string;
				mtime?: number;
				rules: string | null;
		  }
		| undefined;
	return (quest) => {
		if (!quest) return null;
		const read = readmeIn(questsRoot());
		const own = modified(join(questsRoot(), quest, "README.md"));
		if (last?.quest !== quest || last.own !== own) {
			const by = orchestratorOf(quest, read);
			last = { quest, own, by, mtime: undefined, rules: null };
		}
		if (last.by === undefined) return null;
		const mtime = modified(join(questsRoot(), last.by, "README.md"));
		if (mtime !== last.mtime) {
			last = { ...last, mtime, rules: rulesIn(last.by, read(last.by)) };
		}
		return last.rules;
	};
}

function orchestratorOf(quest: string, read: ReadmeReader): string | undefined {
	const seen = new Map<string, QuestFrontMatter | undefined>();
	const frontMatter = (id: string) => {
		if (!seen.has(id)) {
			const readme = read(id);
			seen.set(
				id,
				readme ? parseQuestFrontMatter(readme)?.frontMatter : undefined,
			);
		}
		return seen.get(id);
	};
	return orchestrationOf(quest, frontMatter).by;
}

function rulesIn(by: string, readme: string | undefined): string | null {
	const body = readme ? parseQuestFrontMatter(readme)?.body : undefined;
	const context = body ? extractSection(body, "context").join("\n").trim() : "";
	if (!context) return null;
	return `The quest orchestrating this one, ${by}, sets these for every quest below it, from its README's Context section, so its README need not be read for them:\n\n${context}`;
}

function readmeIn(questsRoot: string): ReadmeReader {
	return (quest) => {
		try {
			return readFileSync(join(questsRoot, quest, "README.md"), "utf8");
		} catch {
			// No README, no quest: the walk stops there.
			return undefined;
		}
	};
}

function modified(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// The orchestrator's README went away; its rules go with it.
		return undefined;
	}
}
