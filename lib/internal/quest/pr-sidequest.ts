/**
 * Find or scaffold a sidequest for a GitHub pull request.
 *
 * Pure file operations on a questsRoot. The pr-workflow
 * extension calls this when it loads a PR so the review
 * inherits an audit trail: a sidequest with the PR alias,
 * placed under the user's currently loaded quest when the
 * quest extension is active, otherwise free-standing under
 * the questsRoot.
 *
 * The integration is additive. Callers tolerate a `null`
 * `parentQuestId`; the resulting sidequest sits at the top
 * of the tree.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	QuestAlias,
	QuestFrontMatter,
	QuestKind,
} from "../../quest/types.js";
import { buildAliasIndex, lookupAliasDetail } from "./alias-index.js";
import { discoverQuests } from "./discovery.js";
import { mintId } from "./id.js";
import { scaffoldQuestReadme } from "./scaffold.js";

/** A GitHub PR reference. */
export interface PrSidequestRef {
	owner: string;
	repo: string;
	number: number;
}

/** Input for `findOrCreateSidequestForPr`. */
export interface FindOrCreateInput {
	/** Where the quest tree lives. */
	questsRoot: string;
	/** Optional parent quest id (the loaded quest, if any). */
	parentQuestId?: string | null;
	/** Title of the PR (used when scaffolding a new sidequest). */
	title?: string;
	/** Optional initial summary prose. */
	summary?: string;
	/** Optional author handle (recorded as Cast originator). */
	authorHandle?: string;
	/** Optional URL of the PR (recorded in the seed Journey bullet). */
	url?: string;
	/** Clock injection for tests. */
	now?: () => Date;
}

/** Outcome of `findOrCreateSidequestForPr`. */
export interface FindOrCreateResult {
	/** The sidequest's id (existing or newly minted). */
	sidequestId: string;
	/** Absolute path to the sidequest's directory. */
	sidequestDir: string;
	/** The parent quest id at scaffold time, if any. */
	parentQuestId: string | null;
	/** True when this call scaffolded a new sidequest. */
	isNew: boolean;
}

function nowYmd(now: () => Date): string {
	const d = now();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Walk the quest tree's alias index for the given PR. When
 * a sidequest already carries the matching `github-pr`
 * alias, return its id and path. Otherwise scaffold a new
 * sidequest under the questsRoot, parented to
 * `parentQuestId` when supplied.
 */
export function findOrCreateSidequestForPr(
	prRef: PrSidequestRef,
	input: FindOrCreateInput,
): FindOrCreateResult {
	const aliasValue = `${prRef.owner}/${prRef.repo}#${prRef.number}`;
	const { index } = discoverQuests(input.questsRoot);
	const aliasIdx = buildAliasIndex(index);
	const lookup = lookupAliasDetail(aliasIdx, {
		type: "github-pr",
		value: aliasValue,
	});
	if (lookup.kind === "collision") {
		throw new Error(
			`Alias github-pr:${aliasValue} is registered on multiple quests (${lookup.questIds.join(", ")}). Resolve the duplicate before creating a sidequest.`,
		);
	}
	if (lookup.kind === "hit") {
		const entry = index.quests.get(lookup.questId);
		if (entry) {
			return {
				sidequestId: lookup.questId,
				sidequestDir: entry.dir,
				parentQuestId: entry.doc.frontMatter.parent ?? null,
				isNew: false,
			};
		}
	}

	mkdirSync(input.questsRoot, { recursive: true });
	const id = mintId("QEST");
	const dir = join(input.questsRoot, id);
	const path = join(dir, "README.md");
	if (existsSync(path)) {
		// Shouldn't happen in practice because mintId is
		// random, but bail cleanly rather than overwrite.
		throw new Error(
			`Quest directory ${dir} already exists; mint a new id and retry.`,
		);
	}

	const alias: QuestAlias = { type: "github-pr", value: aliasValue };
	const date = nowYmd(input.now ?? (() => new Date()));
	const frontMatter: QuestFrontMatter = {
		id,
		kind: "sidequest" satisfies QuestKind,
		parent: input.parentQuestId ?? null,
		status: "active",
		priority: "active",
		rank: 1,
		started: date,
		updated: date,
		aliases: [alias],
		sessions: [],
	};

	const title = input.title?.trim() || `Review ${aliasValue}`;
	const summary =
		input.summary?.trim() ||
		`Review of ${aliasValue} by ${input.authorHandle ?? "the PR author"}.`;
	const cast = input.authorHandle
		? [{ role: "originator", subject: `@${input.authorHandle}`, prose: "" }]
		: undefined;
	const journeyProse = input.url
		? `Loaded for review from ${input.url}.`
		: "Loaded for review.";

	const body = scaffoldQuestReadme({
		frontMatter,
		title,
		summary,
		cast,
		journey: [{ date, prose: journeyProse }],
	});

	mkdirSync(dir, { recursive: true });
	writeFileSync(path, body, "utf8");

	return {
		sidequestId: id,
		sidequestDir: dir,
		parentQuestId: input.parentQuestId ?? null,
		isNew: true,
	};
}
