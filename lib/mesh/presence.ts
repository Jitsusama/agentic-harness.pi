/**
 * Presence: what a peer publishes about itself, so others can tell who
 * is on the mesh and what bears on whom.
 *
 * A peer's work is written down in the quest it has loaded: the
 * README's title and the opening of its summary say what the work is,
 * and its trees say which repositories it owns. A peer on no quest is
 * known by where it runs, unless that is the home directory, which says
 * nothing about anything. Presence is kept by session id, which
 * survives a reload and a restore, so a peer stays in the groups it
 * joined.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseQuestFrontMatter } from "../internal/quest/frontmatter.ts";
import { loadedQuest, type QuestRecords } from "./address.ts";

/** One peer, as it is seen on the mesh. */
export interface Presence {
	/** The pi session id, which outlives the process. */
	readonly session: string;
	/** The addresses it answers to, the one it signs with first. */
	readonly addresses: readonly string[];
	/** The groups it joined, canonical (see group.ts). */
	readonly groups: readonly string[];
	/** Its work in a phrase: the quest's title and summary, or where it runs. */
	readonly worksOn: string;
	/** What it owns by name: its quest, its repositories, its groups. */
	readonly owns: readonly string[];
	/** When it last said so, as an ISO time. */
	readonly at: string;
}

/** Where presence is kept, and what can be asked of it. */
export interface Presences {
	/** This session's presence, when it has published one. */
	of(session: string): Presence | undefined;
	/** Publish a peer's presence. */
	publish(presence: Presence): void;
	/** Every peer's presence. */
	all(): Presence[];
}

/** How much of the summary is said, which is enough to name the work. */
const SUMMARY_CHARS = 240;

/** What this session's peer works on and owns, from its quest. */
export function workOf(
	sessionId: string,
	groups: readonly string[],
	cwd: string,
	records: QuestRecords,
): Pick<Presence, "worksOn" | "owns"> {
	const here = cwd !== homedir() ? [basename(cwd)] : [];
	// Owned as a message would mention them: harness, not #harness.
	const named = groups.map((group) => group.slice(1));
	const quest = loadedQuest(sessionId, records.sessions);
	const readme = quest ? readReadme(records.quests, quest) : undefined;
	const parsed = readme ? parseQuestFrontMatter(readme) : undefined;
	if (!quest || !parsed) {
		return { worksOn: `the work in ${cwd}`, owns: [...here, ...named] };
	}
	const trees = (parsed.frontMatter.trees ?? []).map((tree) =>
		basename(tree.repoRoot ?? tree.path),
	);
	return {
		worksOn: describe(parsed.body),
		owns: [...new Set([quest, ...trees, ...here, ...named])],
	};
}

/** The presence kept in this folder, one file per peer. */
export function createPresences(dir: string): Presences {
	const file = (session: string) =>
		join(dir, `${session.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
	return {
		of: (session) => read(file(session)),
		publish(presence) {
			mkdirSync(dir, { recursive: true });
			const path = file(presence.session);
			const staged = `${path}.${process.pid}.tmp`;
			writeFileSync(staged, JSON.stringify(presence));
			renameSync(staged, path);
		},
		all() {
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				return [];
			}
			return files
				.map((name) => read(join(dir, name)))
				.filter((one): one is Presence => one !== undefined);
		},
	};
}

function read(path: string): Presence | undefined {
	try {
		return presenceFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Presence read from outside, or nothing when it is not one. */
function presenceFrom(value: unknown): Presence | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const one = value as Record<string, unknown>;
	const strings = (list: unknown): list is string[] =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	if (
		typeof one.session !== "string" ||
		!strings(one.addresses) ||
		!strings(one.groups)
	) {
		return undefined;
	}
	return {
		session: one.session,
		addresses: one.addresses,
		groups: one.groups,
		worksOn: typeof one.worksOn === "string" ? one.worksOn : "",
		owns: strings(one.owns) ? one.owns : [],
		at: typeof one.at === "string" ? one.at : "",
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

function readReadme(quests: string, quest: string): string | undefined {
	try {
		return readFileSync(join(quests, quest, "README.md"), "utf8");
	} catch {
		return undefined;
	}
}
