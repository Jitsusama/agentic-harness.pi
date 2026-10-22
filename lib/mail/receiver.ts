/**
 * What a session works on, as mail triage needs to know it.
 *
 * Read from the quest it has loaded, since that is where a session's
 * work is written down: the README's title and the opening of its
 * summary say what the work is, and its trees say which repositories
 * it owns. A session on no quest is known by where it runs, unless
 * that is the home directory, which says nothing about anything.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseQuestFrontMatter } from "../internal/quest/frontmatter.ts";
import type { NamingPaths } from "./names.ts";
import type { Receiver } from "./triage.ts";

/** How much of the summary is said, which is enough to name the work. */
const SUMMARY_CHARS = 240;

/** The receiver this session is, for judging what concerns it. */
export function receiverFor(
	sessionId: string,
	name: string,
	channels: readonly string[],
	cwd: string,
	paths: NamingPaths,
): Receiver {
	const here = cwd !== homedir() ? [basename(cwd)] : [];
	const quest = loadedQuestId(sessionId, paths.sessions);
	const readme = quest ? readReadme(paths.quests, quest) : undefined;
	const parsed = readme ? parseQuestFrontMatter(readme) : undefined;
	if (!quest || !parsed) {
		return {
			name,
			worksOn: `the work in ${cwd}`,
			owns: [...here, ...channels],
		};
	}
	const trees = (parsed.frontMatter.trees ?? []).map((tree) =>
		basename(tree.repoRoot ?? tree.path),
	);
	return {
		name,
		worksOn: describe(parsed.body),
		owns: [...new Set([quest, ...trees, ...here, ...channels])],
	};
}

/** The quest's title and the start of its summary. */
function describe(body: string): string {
	const title = body.match(/^# (.+)$/m)?.[1]?.trim() ?? "";
	const summary =
		body
			.split(/^## .*Summary.*$/m)[1]
			?.split(/^## /m)[0]
			?.replace(/\s+/g, " ")
			.trim() ?? "";
	const opening =
		summary.length > SUMMARY_CHARS
			? `${summary.slice(0, SUMMARY_CHARS)}...`
			: summary;
	return [title, opening].filter(Boolean).join(": ");
}

function loadedQuestId(sessionId: string, sessions: string): string | null {
	try {
		const record: unknown = JSON.parse(
			readFileSync(join(sessions, `${sessionId}.json`), "utf8"),
		);
		const quest = (record as { quest?: unknown } | null)?.quest;
		return typeof quest === "string" ? quest : null;
	} catch {
		return null;
	}
}

function readReadme(quests: string, quest: string): string | undefined {
	try {
		return readFileSync(join(quests, quest, "README.md"), "utf8");
	} catch {
		return undefined;
	}
}
