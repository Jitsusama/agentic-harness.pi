/**
 * Quest-lifecycle verbs: create, load, unload, show,
 * list, focus, unfocus.
 *
 * Plus the cwd-walk helper `questIdFromCwd` that `load`
 * uses when no id is passed.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../lib/internal/quest/alias-index.js";
import { nowYmd } from "../../../lib/internal/quest/dates.js";
import {
	discoverQuests,
	siblingRanks,
} from "../../../lib/internal/quest/discovery.js";
import { atomicWriteFile } from "../../../lib/internal/quest/io.js";
import { nextRank } from "../../../lib/internal/quest/ranking.js";
import { formatRelativeAge } from "../../../lib/internal/quest/session-liveness.js";
import { isSealedStatus } from "../../../lib/internal/quest/status.js";
import { recordStructuralOp } from "../../../lib/internal/quest/structural-journal.js";
import {
	fetchUrlHints,
	mintId,
	type QuestAlias,
	type QuestFrontMatter,
	type QuestKind,
	type QuestPriority,
	scaffoldQuestReadme,
} from "../../../lib/quest/index.js";
import { parseRef, urlForRef } from "../../../lib/refs/index.js";
import {
	appendJourneyEntry,
	attachCurrentSession,
	captureSessionIdentity,
	detachSessionInQuestDir,
	ensureQuestsRoot,
	focusDocument,
	listAllQuests,
	loadQuest,
	prunePhantomSessionsOnLoaded,
	reconcileSessionMembership,
	setLoadedKind,
	unfocusDocument,
	unloadQuest,
} from "../lifecycle.js";
import { buildRowExpansion, showLoaded, showQuestById } from "../lookup.js";
import { recordCurrentWorkspace } from "../workspace-snapshot.js";

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

import {
	type ListingDetails,
	type ListingFlatRow,
	paginate,
	type QuestRowBrief,
	renderListing,
	renderRowBrief,
} from "../render-rows.js";
import type { QuestState } from "../state.js";
import { subdirForDocumentId } from "./queries.js";
import {
	currentSessionId,
	isPersistedSession,
	ok,
	QUEST_KINDS_SET,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

/**
 * Look up the quest that owns the given cwd. Walks the
 * quest dirs first (cwd inside quest's own directory),
 * then registered trees (deepest match wins). Every path
 * is canonicalised through realpath so /var vs /private/var
 * and bind-mounts compare correctly.
 */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isUnder(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(`${parent}/`);
}

export function questIdFromCwd(
	state: QuestState,
	cwd: string,
): string | undefined {
	const { index } = discoverQuests(state.questsRoot);
	const realCwd = canonical(cwd);
	// A quest's own directory is the strongest claim. Prefer a live
	// quest over a sealed one when both directories cover the cwd.
	let dirMatch: string | undefined;
	let dirMatchLive = false;
	for (const entry of index.quests.values()) {
		if (!isUnder(realCwd, canonical(entry.dir))) continue;
		const live = !isSealedStatus(entry.doc.frontMatter.status);
		if (dirMatch === undefined || (live && !dirMatchLive)) {
			dirMatch = entry.doc.frontMatter.id;
			dirMatchLive = live;
		}
	}
	if (dirMatch !== undefined) return dirMatch;

	// Otherwise fall back to tree and worktree-alias paths. The longest
	// covering path wins; a live quest breaks a tie against a sealed one.
	// Only `scaffolded` trees resolve: an adopted or unmarked tree, and a
	// `git-worktree:` alias, is a reference to a possibly shared checkout,
	// so a cwd-only load in a checkout adopted by many quests refuses to
	// guess rather than magnetize an arbitrary one.
	let bestId: string | undefined;
	let bestLen = -1;
	let bestLive = false;
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		const live = !isSealedStatus(fm.status);
		const paths: string[] = [];
		for (const tree of fm.trees ?? []) {
			if (tree.origin === "scaffolded") paths.push(tree.path);
		}
		for (const p of paths) {
			const real = canonical(p);
			if (!isUnder(realCwd, real)) continue;
			if (
				real.length > bestLen ||
				(real.length === bestLen && live && !bestLive)
			) {
				bestLen = real.length;
				bestId = fm.id;
				bestLive = live;
			}
		}
	}
	return bestId;
}

/** Mint a new quest, optionally seeded from a URL. */
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
	// Journal the kind change so undo can reverse a misclassification
	// the same way it reverses a status or priority change.
	if (state.questId && from) {
		recordStructuralOp(state.questsRoot, "reclassify", [
			{ id: state.questId, field: "kind", old: from, new: kind },
		]);
	}
	appendJourneyEntry(state, `Reclassified from ${from ?? "?"} to ${kind}.`);
	return ok(`Quest ${state.questId} is now a ${kind} (was ${from ?? "?"}).`, {
		from,
		to: kind,
	});
}

export async function create(
	state: QuestState,
	pi: ExtensionAPI,
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
	mkdirSync(dir, { recursive: true });
	atomicWriteFile(path, body);
	const result = loadQuest(state, pi, id);
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

	return ok(`Created ${kind} ${id} at ${path}`, { id, path, kind });
}

/** Load a quest by id (or via cwd lookup when no id given). */
export async function load(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: QuestToolParams,
): Promise<QuestResult> {
	let targetId = params.id;
	if (!targetId) {
		const cwd = params.cwd ?? ctx.cwd ?? process.cwd();
		if (cwd) targetId = questIdFromCwd(state, cwd);
		if (!targetId) {
			return refuse(
				"Pass the quest's id (e.g. `id: QEST-20260603-AAA111`) or run from inside a tree registered on a quest.",
			);
		}
	}
	// Capture the quest being left so the current session can be
	// released from it on a switch.
	const priorQuestId = state.questId;
	const priorQuestDir = state.questDir;

	const result = loadQuest(state, pi, targetId);
	if (!result.ok) return refuse(result.guidance);

	const sid = currentSessionId(ctx, undefined);

	// On a switch, detach this session from the quest it is leaving:
	// one pi session that loads several quests over its life should
	// read active on the one it is on, not on all of them. Only for a
	// persisted session, mirroring the attach guard.
	if (
		priorQuestDir &&
		priorQuestId &&
		priorQuestId !== state.questId &&
		sid &&
		isPersistedSession(ctx)
	) {
		detachSessionInQuestDir(priorQuestDir, sid);
	}

	// Garbage-collect no-log phantoms left by pre-guard fan-outs so
	// the prior-session list and frontmatter reflect real sessions.
	const pruned = prunePhantomSessionsOnLoaded(state).removed;

	const loaded = await showLoaded(state);
	const priorSessions = loaded?.frontMatter.sessions ?? [];

	// Capture the current session automatically rather than
	// nudging the user to run session-attach by hand: this is
	// what keeps the sessions frontmatter honest so reopening
	// can later resolve where work happened.
	const attached = attachCurrentSession(state, {
		id: sid,
		cwd: ctx.cwd,
		persisted: isPersistedSession(ctx),
		...captureSessionIdentity(),
	}).attached;

	// Record this session in its terminal workspace so a later restart
	// can reconstruct the set that was open together. Only a persisted
	// session is resumable, so an ephemeral fan-out session is never
	// snapshotted. A best-effort side write; it never blocks the load.
	if (sid && isPersistedSession(ctx) && state.questId) {
		recordCurrentWorkspace({
			questId: state.questId,
			sessionId: sid,
			cwd: ctx.cwd,
		});
	}

	// Reconcile membership so this session reads active on only the
	// loaded quest, detaching it from any straggler quest an earlier
	// run or a lost state left it attached to.
	const reconciled =
		sid && isPersistedSession(ctx) && state.questId
			? reconcileSessionMembership(state, sid, state.questId)
			: [];

	const resumable = priorSessions
		.filter((s) => s.id !== sid)
		.map((s) => ({
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			started: s.started,
			status: s.status,
		}));

	let message = `Loaded ${state.questId}: ${state.questTitle ?? ""}`;
	if (resumable.length > 0) {
		message += `. ${resumable.length} prior session(s) on file; run \`quest recent\` to pick one to resume`;
	}
	if (attached) {
		message += `. Tracking this pi session on the quest.`;
	}
	if (pruned > 0) {
		message += `. Pruned ${pruned} phantom session(s).`;
	}
	if (reconciled.length > 0) {
		message += `. Detached this session from ${reconciled.length} other quest(s).`;
	}

	return ok(message, {
		id: state.questId,
		dir: state.questDir,
		attached,
		resumable,
		pruned,
		reconciled,
	});
}

export function unload(state: QuestState): QuestResult {
	if (!state.questId) return refuse("No quest loaded.");
	const prior = state.questId;
	unloadQuest(state);
	return ok(`Unloaded ${prior}.`);
}

export async function show(
	state: QuestState,
	params: QuestToolParams = { action: "show" },
): Promise<QuestResult> {
	// An explicit id projects any quest read-only, without
	// changing what is loaded; otherwise show the loaded quest.
	if (params.id) {
		const projection = await showQuestById(state, params.id);
		if (!projection) return refuse(`No quest with id "${params.id}".`);
		return ok(renderShow(projection), { projection, readOnly: true });
	}
	if (!state.questDir) {
		return refuse("No quest loaded. Pass an id to inspect a specific quest.");
	}
	const projection = await showLoaded(state);
	if (!projection) return refuse("Could not project the loaded quest.");
	return ok(renderShow(projection), { projection, readOnly: false });
}

function renderShow(
	projection: NonNullable<Awaited<ReturnType<typeof showLoaded>>>,
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
			const identity = c.identityId ? ` [${c.identityId}]` : "";
			lines.push(`  - ${c.subject} (${c.role})${identity}`);
		}
	}
	// Honour the resolution fallback: on warn or ask, surface cast
	// bullets that resolved to no identity so the miss is visible
	// rather than silent. On silent, say nothing.
	if (
		projection.resolutionFallback !== "silent" &&
		projection.unresolvedCast.length > 0
	) {
		lines.push("");
		const nudge =
			projection.resolutionFallback === "ask"
				? " Resolve them or correct the handles."
				: "";
		lines.push(
			`Unresolved cast (${projection.unresolvedCast.length}): ${projection.unresolvedCast.join(", ")}.${nudge}`,
		);
	}
	if (projection.documents.length > 0) {
		lines.push("");
		lines.push("Documents:");
		for (const d of projection.documents) {
			const title = d.title ?? "(untitled)";
			lines.push(`  - ${d.id} (${d.kind}, ${d.stage}): ${title}`);
		}
	}
	if (projection.sessions.length > 0) {
		const now = new Date();
		lines.push("");
		lines.push("Sessions:");
		for (const s of projection.sessions) {
			const age = formatRelativeAge(s.lastActivity, now);
			const facts = [s.liveness, ...(age ? [age] : [])].join(", ");
			const name = s.name ? ` "${s.name}"` : "";
			const where = s.cwd ? ` ${s.cwd}` : "";
			const mark = s.resumeTarget ? "  <- resumes on reopen" : "";
			lines.push(`  - ${s.id}${name} (${facts})${where}${mark}`);
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
		return refuse(`Document ${path} does not exist.`);
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
