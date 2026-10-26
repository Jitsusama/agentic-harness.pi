/**
 * Quest-lifecycle verbs: create, load, unload, show, list,
 * focus, unfocus, reclassify.
 *
 * pi's own `verbs/lifecycle.ts` additionally enriches `load` with
 * automatic session-attach bookkeeping (`ctx.sessionManager`,
 * `pi.setSessionName`, `recordSessionOnQuest`) and `show`/`list`
 * with per-session liveness -- all keyed to pi's own session
 * concept, which no other host has an equivalent for. This version
 * loads and shows a quest without any of that; an adapter with its
 * own session story (pi's `verbs/lifecycle.ts` is the example)
 * layers it on by calling `load`/`show` here and then doing its
 * own session bookkeeping around the result.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseRef, urlForRef } from "../../../refs/index.ts";
import { displayPath } from "../../../ui/path.ts";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../internal/quest/alias-index.ts";
import { nowYmd } from "../../internal/quest/dates.ts";
import {
	discoverQuests,
	siblingRanks,
} from "../../internal/quest/discovery.ts";
import { parseQuestFrontMatter } from "../../internal/quest/frontmatter.ts";
import { atomicWriteFile } from "../../internal/quest/io.ts";
import { nextRank } from "../../internal/quest/ranking.ts";
import { isSealedStatus } from "../../internal/quest/status.ts";
import {
	fetchUrlHints,
	mintId,
	type QuestAlias,
	type QuestFrontMatter,
	type QuestKind,
	type QuestPriority,
	scaffoldQuestReadme,
} from "../index.ts";
import {
	appendJourneyEntry,
	ensureQuestsRoot,
	focusDocument,
	listAllQuests,
	loadQuestById,
	setLoadedKind,
	unfocusDocument,
	unloadQuest,
} from "../lifecycle.ts";
import { buildRowExpansion, locateOwner, showQuestById } from "../lookup.ts";
import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.ts";
import type { QuestState } from "../state.ts";
import { subdirForDocumentId } from "./queries.ts";
import {
	ok,
	QUEST_KINDS_SET,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Priority ladder for sorting list output. Lower numbers
 * sort first; driving is the most prominent bucket. A
 * priority outside the ladder sorts to the end so legacy
 * values do not silently jump ahead of legitimate ones.
 */
const PRIORITY_ORDER: Record<string, number> = {
	driving: 0,
	active: 1,
	queued: 2,
	bench: 3,
	someday: 4,
};
const PRIORITY_FALLBACK = 99;

// Sealed quests sort after every live one, whatever their priority,
// so a concluded quest that still carries a driving priority never
// jumps ahead of live work. Ordering within a tier stays priority
// then rank.
function statusTier(status: string): number {
	return isSealedStatus(status) ? 1 : 0;
}

/**
 * Change the loaded quest's kind (quest, subquest or sidequest), so a
 * misclassification made at create time is fixable in place instead
 * of forcing a delete-and-recreate.
 */
export function reclassify(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const kind = params.kind as QuestKind | undefined;
	if (!kind || !QUEST_KINDS_SET.has(kind)) {
		return refuse(
			`Pass the new kind: quest, subquest or sidequest (got "${params.kind ?? ""}").`,
		);
	}
	const from = state.questKind;
	const result = setLoadedKind(state, kind);
	if (!result.ok) return refuse(result.guidance);
	if (!result.changed) {
		return ok(`Quest ${state.questId} is already a ${kind}.`, {
			from,
			to: kind,
		});
	}
	state.questKind = kind;
	appendJourneyEntry(state, `Reclassified from ${from ?? "?"} to ${kind}.`);
	return ok(`Quest ${state.questId} is now a ${kind} (was ${from ?? "?"}).`, {
		from,
		to: kind,
	});
}

/** Mint a new quest, optionally seeded from a URL, and load it. */
export async function create(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	const kind = (params.kind ?? "sidequest") as QuestKind;
	if (!QUEST_KINDS_SET.has(kind)) {
		return refuse(
			`Unknown kind "${params.kind}". Use quest, subquest or sidequest.`,
		);
	}
	let seededAlias: QuestAlias | undefined;
	let seededTitle: string | undefined = params.title?.trim() || undefined;
	let seededExcerpt: string | undefined;
	let seededOriginator: { type: string; value: string } | undefined;
	if (params.url?.trim()) {
		const ref = parseRef(params.url.trim());
		if (!ref) {
			return refuse(
				`URL "${params.url}" did not match any registered ref type. Pass a title and create without --url, or register a ref type for this URL shape.`,
			);
		}
		const { index } = discoverQuests(state.questsRoot);
		const aliasIdx = buildAliasIndex(index);
		const lookup = lookupAliasDetail(aliasIdx, ref);
		if (lookup.kind === "collision") {
			return refuse(
				`Alias ${ref.type}:${ref.value} is already on multiple quests (${lookup.questIds.join(", ")}). Resolve the duplicate before adding it again.`,
			);
		}
		if (lookup.kind === "hit") {
			return refuse(
				`Quest ${lookup.questId} already has alias ${ref.type}:${ref.value}. Load it instead: \`quest load ${lookup.questId}\`.`,
			);
		}
		seededAlias = { type: ref.type, value: ref.value };
		const hints = await fetchUrlHints(ref);
		if (hints) {
			if (!seededTitle && hints.title) seededTitle = hints.title;
			seededExcerpt = hints.excerpt;
			seededOriginator = hints.originator;
		}
	}

	if (!seededTitle) {
		return refuse(
			"Give a title in the `title` param (the quest's H1 heading). When passing `url`, the fetcher provides one when it can; otherwise the title is yours to choose.",
		);
	}
	ensureQuestsRoot(state);
	const id = mintId("QEST");

	const parent = params.parent ?? null;
	// Validate the priority before it reaches disk: an unchecked cast
	// lets an out-of-vocab value through, which the strict parser then
	// drops the whole quest for, making a freshly created quest
	// invisible. Refuse up front instead.
	if (params.priority !== undefined && !(params.priority in PRIORITY_ORDER)) {
		return refuse(
			`Unknown priority "${params.priority}". Use driving, active, queued, bench or someday.`,
		);
	}
	const priority = (params.priority as QuestPriority) ?? "active";
	// Append to the end of the (parent, priority) sibling group so the
	// new quest takes a free rank rather than colliding at 1.
	const { index } = discoverQuests(state.questsRoot);
	// A parent that does not exist would strand the quest under a
	// dangling reference the tree walk can never resolve. Refuse rather
	// than mint an orphan.
	if (parent !== null && !index.quests.has(parent)) {
		return refuse(
			`Parent quest "${parent}" not found. Create the parent first, or omit parent for a top-level quest.`,
		);
	}

	const frontMatter: QuestFrontMatter = {
		id,
		kind,
		parent,
		status: "active",
		priority,
		rank: nextRank(siblingRanks(index, parent, priority)),
		started: nowYmd(),
		updated: nowYmd(),
		aliases: seededAlias ? [seededAlias] : [],
		sessions: [],
	};
	const summaryParts: string[] = [];
	if (params.note?.trim()) summaryParts.push(params.note.trim());
	if (seededExcerpt) summaryParts.push(`Source excerpt: ${seededExcerpt}`);
	const summary =
		summaryParts.length > 0 ? summaryParts.join("\n\n") : undefined;

	const castEntries = seededOriginator
		? [
				{
					role: "originator",
					subject: `@${seededOriginator.value}`,
					prose: "",
				},
			]
		: undefined;
	const body = scaffoldQuestReadme({
		frontMatter,
		title: seededTitle,
		summary,
		cast: castEntries,
	});
	const dir = join(state.questsRoot, id);
	const path = join(dir, "README.md");
	if (existsSync(path)) {
		return refuse(
			`Quest directory ${dir} already exists. Mint a new ID and retry.`,
		);
	}
	// Born readable or not born at all. Every other quest writer refuses
	// front matter the strict parser cannot read back, and this one wrote
	// the very first copy without asking. A quest that fails the check
	// here is invisible to discovery from the moment it exists, which is
	// the hardest version of the fault to trace: there is no earlier
	// good state to compare against.
	if (!parseQuestFrontMatter(body)) {
		return refuse(
			`Refusing to create ${id}: the scaffolded README has front matter the parser cannot read back, so the quest would exist and never be found.`,
		);
	}
	mkdirSync(dir, { recursive: true });
	atomicWriteFile(path, body);
	const result = loadQuestById(state, id);
	if (!result.ok) return refuse(result.guidance);

	if (seededAlias) {
		const url = urlForRef(seededAlias) ?? params.url?.trim() ?? "";
		appendJourneyEntry(
			state,
			seededOriginator
				? `Created from ${url} by @${seededOriginator.value}.`
				: `Created from ${url}.`,
		);
	}

	return ok(`Created ${kind} ${id} at ${displayPath(path)}`, {
		id,
		path,
		kind,
	});
}

/** Load a quest by id. */
export function load(state: QuestState, params: QuestToolParams): QuestResult {
	if (!params.id) {
		return refuse("Pass the quest's id (e.g. `id: QEST-20260603-AAA111`).");
	}
	const result = loadQuestById(state, params.id);
	if (!result.ok) return refuse(result.guidance);
	return ok(`Loaded ${state.questId}: ${state.questTitle ?? ""}`, {
		id: state.questId,
		dir: state.questDir,
	});
}

export function unload(state: QuestState): QuestResult {
	if (!state.questId) return refuse("No quest loaded.");
	const prior = state.questId;
	unloadQuest(state);
	return ok(`Unloaded ${prior}.`);
}

/**
 * Project a quest for `show`, read-only: an explicit id projects
 * any quest without changing what is loaded; otherwise show the
 * loaded quest.
 */
export function show(
	state: QuestState,
	params: QuestToolParams = { action: "show" },
): QuestResult {
	if (params.id) {
		const projection = showQuestById(state, params.id);
		if (!projection) return refuse(`No quest with id "${params.id}".`);
		return ok(renderShow(projection), { projection, readOnly: true });
	}
	if (!state.questDir) {
		return refuse("No quest loaded. Pass an id to inspect a specific quest.");
	}
	const projection = showQuestById(state, state.questId ?? "");
	if (!projection) return refuse("Could not project the loaded quest.");
	return ok(renderShow(projection), { projection, readOnly: false });
}

function renderShow(
	projection: NonNullable<ReturnType<typeof showQuestById>>,
): string {
	const fm = projection.frontMatter;
	const lines: string[] = [];
	lines.push(`${fm.id}: ${projection.title ?? "(untitled)"}`);
	lines.push(
		`  kind: ${fm.kind}  status: ${fm.status}  priority: ${fm.priority}  parent: ${fm.parent ?? "none"}  updated: ${fm.updated}`,
	);
	if (projection.summary) lines.push(`  summary: ${projection.summary}`);
	if (projection.purpose) lines.push(`  purpose: ${projection.purpose}`);
	if (projection.cast.length > 0) {
		lines.push("");
		lines.push("Cast:");
		for (const c of projection.cast) {
			lines.push(`  - ${c.subject} (${c.role})`);
		}
	}
	if (projection.documents.length > 0) {
		lines.push("");
		lines.push("Documents:");
		for (const d of projection.documents) {
			const title = d.title ?? "(untitled)";
			lines.push(`  - ${d.id} (${d.kind}, ${d.stage}): ${title}`);
		}
	}
	const outgoing = projection.links;
	const outgoingCount =
		outgoing.quests.length + outgoing.refs.length + outgoing.urls.length;
	if (outgoingCount > 0) {
		lines.push("");
		lines.push(`Links out (${outgoingCount}):`);
		for (const q of outgoing.quests) {
			lines.push(`  -> ${q.id} ${q.title ?? ""}`.trimEnd());
		}
		for (const r of outgoing.refs) {
			lines.push(`  -> ${r.type}:${r.value}${r.url ? ` (${r.url})` : ""}`);
		}
		for (const u of outgoing.urls) {
			lines.push(`  -> ${u}`);
		}
	}
	const produced = projection.echoes.filter((e) => e.relation === "produced");
	const referenced = projection.echoes.filter(
		(e) => e.relation === "reference",
	);
	if (produced.length > 0) {
		lines.push("");
		lines.push(`Produced by (${produced.length}):`);
		for (const e of produced) {
			lines.push(`  <- ${e.questId} ${e.questTitle ?? ""}`.trimEnd());
		}
	}
	if (referenced.length > 0) {
		lines.push("");
		lines.push(`Referenced by (${referenced.length}):`);
		for (const e of referenced) {
			lines.push(`  <- ${e.questId} ${e.questTitle ?? ""}`.trimEnd());
		}
	}
	if (projection.journey.length > 0) {
		lines.push("");
		lines.push("Recent journey:");
		for (const j of projection.journey) {
			lines.push(`  ${j.date}: ${j.prose}`);
		}
	}
	return lines.join("\n");
}

export function list(state: QuestState, params: QuestToolParams): QuestResult {
	const all = listAllQuests(state);
	const entries = all.filter((e) => {
		const fm = e.doc.frontMatter;
		if (params.priority && fm.priority !== params.priority) return false;
		if (params.kind && fm.kind !== params.kind) return false;
		if (params.status && fm.status !== params.status) return false;
		if (params.parent !== undefined) {
			const expected = params.parent === "null" ? null : params.parent;
			if (fm.parent !== expected) return false;
		}
		return true;
	});
	entries.sort((a, b) => {
		const ta = statusTier(a.doc.frontMatter.status);
		const tb = statusTier(b.doc.frontMatter.status);
		if (ta !== tb) return ta - tb;
		const pa = PRIORITY_ORDER[a.doc.frontMatter.priority] ?? PRIORITY_FALLBACK;
		const pb = PRIORITY_ORDER[b.doc.frontMatter.priority] ?? PRIORITY_FALLBACK;
		if (pa !== pb) return pa - pb;
		return a.doc.frontMatter.rank - b.doc.frontMatter.rank;
	});
	const view = paginate(entries, {
		limit: params.limit,
		offset: params.offset,
	});
	const rows: ListingFlatRow[] = view.rows.map((entry) => ({
		id: entry.doc.frontMatter.id,
		kind: entry.doc.frontMatter.kind,
		status: entry.doc.frontMatter.status,
		title: entry.doc.title ?? null,
		priority: entry.doc.frontMatter.priority,
		parent: entry.doc.frontMatter.parent,
		updated: entry.doc.frontMatter.updated,
		depth: 0,
		...buildRowExpansion(entry),
	}));
	const rendered = rows.map((row) => {
		const brief: QuestRowBrief = {
			id: row.id,
			kind: row.kind,
			status: row.status,
			priority: row.priority,
			title: row.title,
		};
		return renderRowBrief(brief);
	});
	const listing: ListingDetails = {
		rows,
		total: view.total,
		offset: view.offset,
		limit: view.limit,
		remaining: view.remaining,
	};
	return ok(renderListing(rendered, view), {
		listing,
		total: view.total,
		offset: view.offset,
		limit: view.limit,
		remaining: view.remaining,
	});
}

export function focus(state: QuestState, params: QuestToolParams): QuestResult {
	if (!state.questDir)
		return refuse("Load a quest before focusing a document.");
	if (!params.id) {
		return refuse("Pass the document id (e.g. PLAN-20260603-...).");
	}
	const subdir = subdirForDocumentId(params.id);
	if (!subdir) {
		return refuse(`"${params.id}" does not look like a document id.`);
	}
	const path = join(state.questDir, subdir, `${params.id}.md`);
	if (!existsSync(path)) {
		// A path built from the loaded quest, so saying it does not exist names
		// a location nobody meant when the document belongs to another quest.
		const owner = locateOwner(state, params.id).find(
			(hit) => hit.questId !== state.questId,
		);
		if (owner) {
			return refuse(
				`${params.id} belongs to ${owner.questId}${owner.questTitle ? ` (${owner.questTitle})` : ""}, not to the loaded quest. Load that quest first, then focus it.`,
			);
		}
		return refuse(
			`No document ${params.id} in this quest. Expected it at ${path}.`,
		);
	}
	const result = focusDocument(state, path);
	if (!result.ok) return refuse(result.guidance);
	return ok(`Focused ${state.documentId} (${state.documentKind}).`, {
		path,
	});
}

export function unfocus(state: QuestState): QuestResult {
	if (!state.documentId) return refuse("No document focused.");
	const prior = state.documentId;
	unfocusDocument(state);
	return ok(`Unfocused ${prior}.`);
}
