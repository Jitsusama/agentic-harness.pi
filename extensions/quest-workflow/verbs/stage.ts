/**
 * Stage-machine verbs: think, draft, build, conclude,
 * retire. Plus the primary-plan pinning helpers and the
 * quest-scoped concludeOrRetire (which delegates to
 * stageTransition for document-scoped calls).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	auditQuestRecord,
	isRecordSound,
} from "../../../lib/core/internal/quest/record-audit.ts";
import { removeQuestWorkspace } from "../../../lib/core/internal/quest/workspace.ts";
import { resolveTreeProvider } from "../../../lib/core/tree/index.ts";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { nowYmd } from "../../../lib/internal/quest/dates.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import {
	duMeasure,
	formatSize,
	type Measure,
} from "../../../lib/internal/quest/footprint.ts";
import {
	parseDocumentFrontMatter,
	parseQuestFrontMatter,
} from "../../../lib/internal/quest/frontmatter.ts";
import { isWithin } from "../../../lib/internal/quest/git-signals.ts";
import { appendHarnessLog } from "../../../lib/internal/quest/harness-log.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { reapQuestScratchDir } from "../../../lib/internal/quest/scratch.ts";
import { isSealedStatus } from "../../../lib/internal/quest/status.ts";
import {
	type JournalChange,
	recordStructuralOp,
} from "../../../lib/internal/quest/structural-journal.ts";
import { treesHere } from "../../../lib/internal/quest/tree-place.ts";
import {
	listTreesOnQuest,
	removeTreeFromQuest,
	setPendingPrune,
} from "../../../lib/internal/quest/trees.ts";
import {
	checkboxProgress,
	type DocumentFrontMatter,
	type DocumentKind,
	mintId,
	type QuestSession,
	scaffoldDocument,
} from "../../../lib/quest/index.ts";
import { count, noun, verb } from "../../../lib/ui/count.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { refuseSealingDryRun } from "../dry-run.ts";
import {
	appendJourneyEntry,
	autoFocusPlan,
	autoFocusSaid,
	createDocument,
	focusDocument,
	logHarnessEntry,
	refreshProgress,
	sealQuestDocuments,
	setLoadedStatus,
	setQuestPriorityByDir,
	stampQuestUpdated,
	unfocusDocument,
	writeDocumentStage,
} from "../lifecycle.ts";
import { type TransitionAction, transition } from "../machine.ts";
import { outsideWritesSaid, readOutsideWrites } from "../outside-writes.ts";
import { recordBreakage } from "../record-watch.ts";
import { dropTempLink } from "../scratch.ts";
import type { QuestState } from "../state.ts";
import { defaultWorkspaceRoot, workspaceDirOf } from "../workspace.ts";
import { type Address, addressOf } from "./address.ts";
import { subdirForDocumentId } from "./queries.ts";
import {
	DOCUMENT_KINDS_SET,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";
import { bulkConcludeOrRetire } from "./structural.ts";

/** A quest a sweep held back, and what its record needs first. */
interface HeldQuest {
	id: string;
	lines: string[];
}

/**
 * The quests in a conclude sweep whose records are not whole, held to
 * the same audit a single conclude is. Unknown ids and quests already
 * concluded pass through, so core answers for them as it always has.
 */
function unwholeRecords(questsRoot: string, targets: string[]): HeldQuest[] {
	const { index } = discoverQuests(questsRoot);
	const held: HeldQuest[] = [];
	for (const id of targets) {
		const entry = index.quests.get(id);
		if (!entry || entry.doc.frontMatter.status === "concluded") continue;
		const audit = auditQuestRecord(entry.dir);
		if (isRecordSound(audit)) continue;
		const workspace = workspaceDirOf(defaultWorkspaceRoot(), id) ?? "";
		const lines = recordBreakage(audit, workspace).map((b) => b.line);
		held.push({ id, lines });
	}
	return held;
}

function describeHeld(held: HeldQuest[]): string {
	return held
		.map(({ id, lines }) => `${id}:\n${lines.map((l) => `- ${l}`).join("\n")}`)
		.join("\n");
}

/**
 * Conclude or retire a list of quests, then clear what each one's
 * conclude would have: the workspace's tmp/ and any scratch recorded
 * before workspaces. Core seals the records; the workspace root is
 * this package's to know.
 *
 * A conclude holds each record to the audit a single conclude does,
 * concluding the whole ones and naming the rest with what to put right,
 * so one untidy quest neither slips through nor stalls the batch. A
 * retire is abandoned as it stands, as it is one quest at a time.
 */
async function sweepQuests(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
): Promise<QuestResult> {
	const targets = (params.id ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	const held =
		action === "conclude" ? unwholeRecords(state.questsRoot, targets) : [];
	const heldIds = new Set(held.map((h) => h.id));
	const sweeping = targets.filter((id) => !heldIds.has(id));
	if (held.length > 0 && sweeping.length === 0) {
		return refuse(
			`No record in the batch is whole yet, so nothing was concluded. Put these right first:\n${describeHeld(held)}`,
		);
	}
	const swept = bulkConcludeOrRetire(state, action, {
		...params,
		id: sweeping.join(","),
	});
	if (!swept.ok) return swept;
	const result: QuestResult =
		held.length === 0
			? swept
			: {
					...swept,
					message: `${swept.message} ${swept.details?.dryRun ? "Would skip" : "Skipped"} ${count(held.length, "quest")} whose record is not whole yet; put these right, then conclude ${held.length === 1 ? "it" : "them"}:\n${describeHeld(held)}`,
					details: { ...swept.details, skipped: [...heldIds] },
				};
	if (result.details?.dryRun) return result;
	const changes = (result.details?.changes ?? []) as { id: string }[];
	const { index } = discoverQuests(state.questsRoot);
	for (const { id } of changes) {
		const entry = index.quests.get(id);
		if (!entry) continue;
		if (
			reapQuestScratchDir(entry.dir, entry.doc.frontMatter.scratchDir ?? null)
		) {
			appendHarnessLog(entry.dir, "Reaped the managed scratch directory.");
		}
		if (id === state.questId) state.scratchDir = null;
		const said = await scratchRemoved(id);
		if (said) appendHarnessLog(entry.dir, said);
	}
	return result;
}

/**
 * Pin `planId` as the quest's primary plan when no primary
 * has been recorded yet. Quietly leaves an existing
 * recorded primary in place. This runs at draft time so
 * the gate has a stable answer the first time the user
 * tries to build.
 */
function pinPrimaryPlanIfUnset(questDir: string, planId: string): void {
	// Best-effort pin through the validated core: leave the field unset
	// on any failure so the next draft tries again, and quietly keep an
	// existing recorded primary in place.
	mutateQuestFrontMatter(questDir, (fm) =>
		fm.primaryPlanId ? undefined : { ...fm, primaryPlanId: planId },
	);
}

/**
 * Drive the document stage machine: think -> draft ->
 * build -> conclude/retire. The build-stage code home is
 * enforced at write time by the write classifier (see
 * enforce.ts), not at the transition, so crossing into
 * build never refuses; first-draft document scaffolding is
 * handled inline.
 *
 * A finished document is never reopened by a stage verb, but
 * it no longer stands in the way either. Concluding or
 * retiring the focused document puts it down, and thinking or
 * drafting while one is still focused starts a fresh loop
 * beside it. Agents met "this document is terminal" and
 * "draft from think" 45 times in a week, and the next call
 * was `unfocus` nearly every time, so the verb does that step
 * itself and says so.
 *
 * The same holds for `draft` given a title while a document already
 * drafted or in build is focused: a title names a new document, since
 * the focused one has its H1, so that one is put down where it stands
 * and the new one drafted beside it. Of 40 "draft from think"
 * refusals from 2026-10-19 to 2026-10-26, 39 were exactly that.
 *
 * And for `think` given a kind: a kind is chosen for a fresh loop, so
 * it too names a new document. It used to send the focused one back
 * to think, which in that week happened 35 times out of 36 with a
 * note about some other document; the next `build` was refused, or
 * the next `draft` re-drafted the old plan in place of minting the
 * new one. A `think` with no kind still sends the focused document
 * back to think.
 */
export function stageTransition(
	state: QuestState,
	action: TransitionAction,
	params: QuestToolParams,
	ctx: ExtensionContext,
): QuestResult {
	if (!state.questDir) {
		return refuse(
			"Load a quest before driving the document machine. Try `quest load <id>` first.",
		);
	}
	const terminal =
		state.documentStage === "concluded" || state.documentStage === "retired";
	const namesNewDocument =
		(action === "draft" && Boolean(params.title?.trim())) ||
		(action === "think" && Boolean(params.kind?.trim()));
	const besideActive =
		namesNewDocument &&
		Boolean(state.documentId) &&
		(state.documentStage === "draft" || state.documentStage === "build");
	if (
		(terminal && (action === "think" || action === "draft")) ||
		besideActive
	) {
		const left = besideActive
			? `${state.documentKind} ${state.documentId} stays in ${state.documentStage}, put down; \`focus\` takes it up again. This ${action === "draft" ? "drafts a new document" : "starts a fresh loop"} beside it.`
			: `${state.documentKind} ${state.documentId} stays ${state.documentStage}, and this starts a fresh loop beside it.`;
		unfocusDocument(state);
		const result = stageTransition(state, action, params, ctx);
		return result.ok
			? { ...result, message: `${left} ${result.message}` }
			: result;
	}

	if (action === "think" && state.documentStage === "idle") {
		if (!params.note?.trim()) {
			return refuse(
				"Say what this document is about in `note`: the problem you are investigating, the plan you are about to draft, or the brief you are scoping.",
			);
		}
		const kind = beginLoop(state, params);
		if (kind === undefined) {
			return refuse(
				`Unknown kind "${params.kind}". Use plan, research, brief or report.`,
			);
		}
		return ok(
			`Thinking about a ${kind} for ${state.questId}: ${params.note.trim()}. This loop has no document id yet; \`draft\` (with a title) mints it.`,
			{ stage: "think", kind },
		);
	}

	// Drafting with nothing in hand thinks and drafts in one call. The
	// note is still required, since saying what a document is for is
	// the whole of what think asks; only the extra round trip goes.
	if (action === "draft" && state.documentStage === "idle") {
		if (!params.note?.trim() || !params.title?.trim()) {
			return refuse(
				"Nothing is being thought about yet, so draft starts the loop as well. Give `note` (what this document is about) and `title` (its H1), and it thinks and drafts in one call.",
			);
		}
		if (beginLoop(state, params) === undefined) {
			return refuse(
				`Unknown kind "${params.kind}". Use plan, research, brief or report.`,
			);
		}
	}

	const result = transition(
		{ stage: state.documentStage },
		{
			action,
			note: params.note,
			reason: params.reason,
		},
	);
	if (!result.ok) return refuse(result.guidance);

	if (action === "draft" && !state.documentId) {
		if (!params.title?.trim()) {
			return refuse(
				"Give the document a title in `title` (it becomes the H1).",
			);
		}
		// A kind given at draft overrides the think-time kind before the
		// id is minted, so a wrong choice at think is fixable here rather
		// than forcing the loop to be abandoned.
		const requestedKind = params.kind as DocumentKind | undefined;
		if (requestedKind && !DOCUMENT_KINDS_SET.has(requestedKind)) {
			return refuse(
				`Unknown kind "${params.kind}". Use plan, research, brief or report.`,
			);
		}
		const kind = requestedKind ?? state.documentKind ?? "plan";
		const prefix = (
			{
				plan: "PLAN",
				research: "RSCH",
				brief: "BRIF",
				report: "RPRT",
			} as const
		)[kind];
		const id = mintId(prefix);
		const fm: DocumentFrontMatter = {
			id,
			kind,
			quest: state.questId ?? "",
			stage: "draft",
			updated: nowYmd(),
		};
		const body = scaffoldDocument({
			frontMatter: fm,
			title: params.title.trim(),
		});
		const path = createDocument(state, {
			id,
			kind,
			title: params.title.trim(),
			stage: "draft",
			scaffoldBody: body,
		});
		if (!path) {
			return refuse("Failed to write the document; is a quest loaded?");
		}
		state.documentId = id;
		state.documentPath = path;
		state.documentTitle = params.title.trim();
		state.documentStage = "draft";
		state.documentKind = kind;
		if (kind === "plan" && state.questDir) {
			pinPrimaryPlanIfUnset(state.questDir, id);
		}
		refreshProgress(state);
		appendJourneyEntry(state, `Drafted ${kind} ${id}.`);
		return ok(`Drafted ${kind} ${id} at ${displayPath(path)}.`, {
			stage: "draft",
			id,
			path,
		});
	}

	if (state.documentPath) {
		const persisted = writeDocumentStage(state, result.state.stage);
		if (!persisted) {
			return refuse(
				`Could not persist the stage change to ${state.documentPath}; the document stays ${state.documentStage}. Check the file exists and is readable, then retry.`,
			);
		}
	}
	state.documentStage = result.state.stage;
	refreshProgress(state);
	if (action === "build") {
		appendJourneyEntry(
			state,
			`Building against ${state.documentKind} ${state.documentId}.`,
		);
	} else if (action === "conclude") {
		appendJourneyEntry(
			state,
			`Concluded ${state.documentKind} ${state.documentId}.`,
		);
	} else if (action === "retire") {
		appendJourneyEntry(
			state,
			`Retired ${state.documentKind} ${state.documentId}: ${params.reason ?? "no reason given"}.`,
		);
	}
	if (state.questDir) stampQuestUpdated(state);
	const landed = `Now ${result.state.stage} on ${state.documentKind} ${state.documentId}${state.documentTitle ? ` (${state.documentTitle})` : ""}.`;
	if (action !== "conclude" && action !== "retire") {
		return ok(landed, { stage: result.state.stage });
	}
	// A finished document is put down, so the next think or draft is
	// a fresh loop and the footer stops showing work that is over.
	// The plan still being worked, if there is one, takes its place.
	unfocusDocument(state);
	const next = autoFocusSaid(autoFocusPlan(state));
	return ok([landed, next ?? "Nothing is focused now."].join(" "), {
		stage: result.state.stage,
	});
}

/**
 * Start a think loop with no document yet, of the kind asked for or
 * a plan. Undefined when the kind is not one there is.
 */
function beginLoop(
	state: QuestState,
	params: QuestToolParams,
): DocumentKind | undefined {
	const kind = (params.kind ?? "plan") as DocumentKind;
	if (!DOCUMENT_KINDS_SET.has(kind)) return undefined;
	state.documentKind = kind;
	state.documentStage = "think";
	state.documentId = null;
	state.documentPath = null;
	state.documentTitle = null;
	state.done = 0;
	state.total = 0;
	return kind;
}

/**
 * Inspect the loaded quest's primary plan for unchecked work.
 * Returns the plan id and its checkbox tallies when items remain
 * open, so conclude can warn rather than silently sealing a quest
 * with work still on its plan. Returns undefined when there is no
 * primary plan, it is unreadable, has no checkboxes, or is fully
 * checked.
 */
function primaryPlanDrift(
	state: QuestState,
): { planId: string; done: number; total: number } | undefined {
	if (!state.questDir) return undefined;
	let readme: string;
	try {
		readme = readFileSync(join(state.questDir, "README.md"), "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseQuestFrontMatter(readme);
	const planId = parsed?.frontMatter.primaryPlanId;
	if (!planId) return undefined;
	let planText: string;
	try {
		planText = readFileSync(
			join(state.questDir, "plans", `${planId}.md`),
			"utf8",
		);
	} catch {
		return undefined;
	}
	const { done, total } = checkboxProgress(planText);
	if (total === 0 || done >= total) return undefined;
	return { planId, done, total };
}

/** Read the loaded quest's sessions list off disk. */
function readSessionsFromQuest(state: QuestState): QuestSession[] {
	if (!state.questDir) return [];
	try {
		const readme = join(state.questDir, "README.md");
		const text = readFileSync(readme, "utf8");
		const parsed = parseQuestFrontMatter(text);
		return parsed?.frontMatter.sessions ?? [];
	} catch {
		// Quest README missing or unreadable; treat as no
		// sessions so we don't accidentally block pruning.
		return [];
	}
}

async function pruneAllTreesOnQuest(
	state: QuestState,
	signal?: AbortSignal,
): Promise<{
	pruned: string[];
	blocked: { path: string; reason: string }[];
}> {
	const pruned: string[] = [];
	const blocked: { path: string; reason: string }[] = [];
	if (!state.questDir) return { pruned, blocked };
	const listing = listTreesOnQuest(state.questDir);
	if (!listing.ok) return { pruned, blocked };
	// Only this machine's: another machine's trees, seen through a
	// shared quest, stay listed in the sealed README for that machine.
	for (const tree of treesHere(listing.trees)) {
		// Only auto-prune trees the tool scaffolded. Adopted trees, and
		// legacy or hand-registered trees with no origin marker, are
		// references the quest does not own, so concluding the quest
		// must never delete them; they are released deliberately with
		// tree-release.
		if (tree.origin !== "scaffolded") continue;
		// Stopped: the rest are left standing rather than each handed a
		// signal that has already fired.
		if (signal?.aborted) break;
		// Re-read the live session list immediately before each prune
		// rather than from one snapshot taken before the loop: the
		// awaits below yield the event loop, so another session can
		// attach into a tree we are about to prune and must be seen.
		const sessions = readSessionsFromQuest(state);
		const attached = sessions.filter(
			(s) => s.cwd && isWithin(s.cwd, tree.path),
		);
		if (attached.length > 0) {
			const names = attached.map((s) => s.name ?? s.id).join(", ");
			blocked.push({
				path: tree.path,
				reason: `attached ${noun(attached.length, "session")}: ${names}`,
			});
			continue;
		}
		const provider = resolveTreeProvider(tree.repoRoot ?? tree.path);
		if (!provider) {
			blocked.push({ path: tree.path, reason: "no applicable provider" });
			continue;
		}
		try {
			await provider.release({
				path: tree.path,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			blocked.push({ path: tree.path, reason: message });
			continue;
		}
		// The worktree is gone; de-register it. If the frontmatter write
		// fails the tree is half-pruned (removed on disk, still listed),
		// so surface it for manual cleanup rather than reporting a clean
		// prune.
		const removal = removeTreeFromQuest(state.questDir, tree.path);
		if (!removal.ok) {
			blocked.push({
				path: tree.path,
				reason: `worktree removed but could not be de-registered: ${removal.reason}`,
			});
			continue;
		}
		pruned.push(tree.path);
	}
	return { pruned, blocked };
}

/**
 * Reopen a concluded or retired quest, returning it to active. The
 * inverse of concluding the whole quest; the resuscitate pattern in
 * the quest convention. Document stages are left as they are, so a
 * reopened quest keeps whatever plans it had concluded; the author
 * moves the ones they want back to build deliberately.
 */
export function reopenQuest(state: QuestState): QuestResult {
	if (!state.questId || !state.questDir) {
		return refuse("Load a quest before reopening it.");
	}
	if (state.questStatus !== "concluded" && state.questStatus !== "retired") {
		return refuse(
			`Quest ${state.questId} is ${state.questStatus ?? "active"}, not concluded or retired; there is nothing to reopen.`,
		);
	}
	const result = setLoadedStatus(state, "active");
	if (!result.ok) return refuse(result.guidance);
	appendJourneyEntry(state, "Reopened the quest.");
	return ok(`Reopened quest ${state.questId}; now active.`, {
		status: "active",
	});
}

/**
 * Conclude or retire a specific document by id: focus it so the
 * stage machine and widget stay in sync, then drive the document
 * transition. This shares the focused-document semantics, so like
 * any document conclusion it is not reversible through `undo`
 * (only the quest sweep journals a structural op).
 *
 * The id comes from the agent, so the resolved path is contained to
 * the quest's subdirectory: a crafted id carrying path separators
 * or `..` resolves outside it and is refused, never reaching the
 * filesystem. Any prior focus is restored afterward so concluding a
 * sibling document does not silently move the user's focus.
 *
 * A document of another quest, or one named from a session with no
 * quest loaded, is finished where it lies (see `concludeElsewhere`).
 */
function concludeDocumentById(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	ctx: ExtensionContext,
	id: string,
	subdir: string,
): QuestResult {
	const probeDir = resolve(state.questDir ?? state.questsRoot, subdir);
	if (dirname(resolve(probeDir, `${id}.md`)) !== probeDir) {
		return refuse(
			`Document id ${id} is not a plain id; it must not contain path separators.`,
		);
	}
	const target = addressOf(state, id, { focused: false });
	if ("refusal" in target || target.documentId === undefined) {
		return refuse(
			`Document ${id} not found in any quest. Check the id, or pass a quest id for a status sweep.`,
		);
	}
	if (!target.loaded) return concludeElsewhere(action, params, state, target);
	const path = target.path;
	const priorFocus = state.documentPath;
	const focused = focusDocument(state, path);
	if (!focused.ok) return refuse(focused.guidance);
	const result = stageTransition(state, action, params, ctx);
	// Restore the focus the user had before, unless they were already
	// focused on the document just concluded.
	if (priorFocus && priorFocus !== path) focusDocument(state, priorFocus);
	return result;
}

/**
 * Conclude or retire a document of a quest this session has not
 * loaded. Nothing there is focused, so the stage machine runs on the
 * stage the file holds, the stage is written to the file, and the
 * Journey entry goes to the document's own quest. The session stays
 * on its own quest and its focus does not move.
 */
function concludeElsewhere(
	action: "conclude" | "retire",
	params: QuestToolParams,
	state: QuestState,
	target: Address,
): QuestResult {
	const shown = displayPath(target.path);
	let text: string;
	try {
		text = readFileSync(target.path, "utf8");
	} catch (err) {
		return refuse(`Cannot read ${shown}: ${(err as Error).message}`);
	}
	const parsed = parseDocumentFrontMatter(text);
	if (!parsed) {
		return refuse(
			`${shown} has front matter the parser cannot read, so its stage is unknown. Load ${target.questId} and repair it first.`,
		);
	}
	const { id, kind, stage } = parsed.frontMatter;
	const result = transition(
		{ stage },
		{ action, note: params.note, reason: params.reason },
	);
	if (!result.ok) return refuse(result.guidance);
	// Core writes the stage through the loaded quest's slots; a view
	// aimed at the other quest reuses that validated, locked write
	// rather than keeping a second copy of it here.
	const view: QuestState = {
		...state,
		questDir: target.questDir,
		documentPath: target.path,
	};
	if (!writeDocumentStage(view, result.state.stage)) {
		return refuse(
			`Could not write the stage change to ${shown}; the document stays ${stage}.`,
		);
	}
	const said =
		action === "conclude"
			? `Concluded ${kind} ${id}.`
			: `Retired ${kind} ${id}: ${params.reason ?? "no reason given"}.`;
	appendJourneyByPath(target.questDir, said);
	// An identity transform: the write stamps `updated` and nothing else.
	mutateQuestFrontMatter(target.questDir, (fm) => fm);
	const here = state.questId
		? `This session stays on ${state.questId}.`
		: "Nothing was loaded.";
	return ok(`${said} It belongs to ${target.questId}. ${here}`, {
		stage: result.state.stage,
	});
}

/**
 * Quest-or-document scoped conclude/retire. With a focused
 * document and no explicit scope, delegates to
 * stageTransition. Otherwise concludes or retires the
 * whole quest and auto-prunes its trees.
 */
/**
 * How long a conclude may spend measuring the workspace it keeps.
 *
 * The largest workspace here, 19 GB, took a quarter of a second with
 * the cache warm, and all 133 took eleven seconds cold. A conclude
 * waits on this, so one slower than the deadline says "at least"
 * rather than holding it up.
 */
const CONCLUDE_MEASURE_MS = 5_000;

/**
 * Remove a sealed quest's scratch folder, its caches and builds with it,
 * and say what that freed: a cache goes with its owner, not with its
 * age. One a process still works in stays for the disk guard. Nothing
 * when it has no scratch folder.
 */
export async function scratchRemoved(
	questId: string | null,
	signal?: AbortSignal,
	measure: Measure = duMeasure({
		deadlineMs: CONCLUDE_MEASURE_MS,
		...(signal ? { signal } : {}),
	}),
	root: string = defaultWorkspaceRoot(),
	users?: (dir: string) => readonly number[],
): Promise<string | undefined> {
	const dir = questId ? workspaceDirOf(root, questId) : undefined;
	if (!questId || !dir) return undefined;
	const size = await measure(dir);
	const removal = removeQuestWorkspace(root, questId, users);
	const held = size ? `, which held ${formatSize(size)}` : "";
	if (removal.removed) {
		dropTempLink(questId);
		return `Removed its scratch folder${held}.`;
	}
	if (removal.why === "in use") {
		return `Left its scratch folder${held}, since a process still works in it; the disk guard takes it once nothing does.`;
	}
	if (removal.why === "stuck") {
		return `Could not remove all of its scratch folder${held}; the disk guard takes what is left.`;
	}
	return undefined;
}

export async function concludeOrRetire(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<QuestResult> {
	// An explicit id targets that id rather than the loaded quest, so
	// naming an id never silently falls through to the loaded quest.
	// A single document-kind id concludes that document (not
	// undoable, see concludeDocumentById); a quest id or any comma
	// list runs the reversible status sweep.
	const targetId = (params.id ?? "").trim();
	const declaredScope =
		params.scope === "quest" || params.scope === "document"
			? params.scope
			: undefined;
	// Naming the loaded quest seals it in full: trees pruned, workspace
	// cleared, documents sealed. The sweep is for quests not loaded here.
	if (
		targetId.length > 0 &&
		targetId === state.questId &&
		declaredScope !== "document"
	) {
		return (
			refuseSealingDryRun(params, action, `the loaded quest ${targetId}`) ??
			sealLoadedQuest(state, action, params, signal)
		);
	}
	if (targetId.length > 0) {
		// A single document-kind id (PLAN/RSCH/BRIF/RPRT) concludes or
		// retires that document under the loaded quest, with the same
		// (non-undoable) semantics as concluding a focused document.
		// Quest ids, and any comma list, run the reversible quest sweep.
		const subdir = targetId.includes(",")
			? undefined
			: subdirForDocumentId(targetId);
		// A declared scope wins over id-shape inference, so the caller
		// can be explicit rather than relying on the tool guessing from
		// whether the id looks like a document or a quest.
		if (declaredScope === "document") {
			if (!subdir) {
				return refuse(
					`scope:document needs a single document id (PLAN, RSCH, BRIF or RPRT); "${targetId}" is not one.`,
				);
			}
			return (
				refuseSealingDryRun(params, action, `document ${targetId}`) ??
				concludeDocumentById(state, action, params, ctx, targetId, subdir)
			);
		}
		if (declaredScope === "quest") {
			return sweepQuests(state, action, params);
		}
		if (subdir) {
			return (
				refuseSealingDryRun(params, action, `document ${targetId}`) ??
				concludeDocumentById(state, action, params, ctx, targetId, subdir)
			);
		}
		return sweepQuests(state, action, params);
	}
	if (!state.questDir) {
		return refuse("Load a quest before concluding or retiring anything.");
	}
	const scope =
		params.scope === "quest" || params.scope === "document"
			? params.scope
			: state.documentId
				? "document"
				: "quest";
	if (scope === "document") {
		return (
			refuseSealingDryRun(
				params,
				action,
				`the focused document ${state.documentId ?? ""}`.trim(),
			) ?? stageTransition(state, action, params, ctx)
		);
	}
	// Sealing a quest is final, prunes its trees and sets it to someday,
	// so it is never inferred from what happens to be loaded. A quest was
	// once concluded this way when the person meant to put it down.
	return refuse(
		`${action === "conclude" ? "Concluding" : "Retiring"} a quest seals it for good, so it needs the quest named: pass \`id: ${state.questId}\` (${state.questTitle ?? "the loaded quest"}) to ${action} it. To stop working on it without sealing it, use \`unload\`.`,
	);
}

/** Conclude or retire the loaded quest, once it has been named. */
async function sealLoadedQuest(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	if (!state.questDir) {
		return refuse("Load a quest before concluding or retiring anything.");
	}
	if (action === "retire" && !params.reason?.trim()) {
		return refuse("Retire needs a `reason`: why is the quest being abandoned?");
	}
	const target = action === "conclude" ? "concluded" : "retired";
	if (state.questStatus === target) {
		return ok(`Quest already ${target}.`);
	}
	// A concluded quest's record is what the backup keeps and what a
	// later reader trusts, so it must be whole before the quest seals:
	// nothing outside the record, no attachment over the limits, no link
	// into attachments/ that leads nowhere. A retired quest is abandoned
	// as it stands, so it is not held to this.
	const audit =
		action === "conclude" ? auditQuestRecord(state.questDir) : undefined;
	if (audit && !isRecordSound(audit)) {
		const workspace =
			workspaceDirOf(defaultWorkspaceRoot(), state.questId) ?? "";
		const lines = recordBreakage(audit, workspace).map((b) => `- ${b.line}`);
		return refuse(
			`${state.questId}'s record is not whole yet, so it cannot conclude. Put these right first:\n${lines.join("\n")}`,
		);
	}
	// Prune before flipping status so a prune that cannot complete
	// leaves the quest in its prior state with the blocked trees
	// recorded, rather than sealing a still-active quest.
	const { pruned, blocked } = await pruneAllTreesOnQuest(state, signal);
	// Stopped mid-prune is the person taking the seal back, so the quest
	// stays as it was. A tree already removed stays removed, and says so.
	if (signal?.aborted) {
		const gone =
			pruned.length > 0
				? ` ${count(pruned.length, "tree")} already pruned: ${pruned.join(", ")}.`
				: "";
		return refuse(
			`Stopped while pruning trees, so ${state.questId} was not ${action === "conclude" ? "concluded" : "retired"}.${gone}`,
		);
	}
	// Capture the pre-seal status and priority so the seal can be
	// journalled and reversed by undo, the same way the bulk path is.
	const priorStatus = state.questStatus ?? "active";
	const priorPriority = state.questPriority ?? "active";
	const questId = state.questId;
	const result = setLoadedStatus(state, target);
	if (!result.ok) return refuse(result.guidance);
	// Cascade the seal so the quest leaves nothing live behind: drop
	// the priority to the least prominent bucket and seal every
	// still-active document to the same terminal stage. Drop the
	// priority rank-preserving, matching the bulk path: the seal must
	// not renumber the quest's rank, because undo restores only the
	// priority bucket, so a rank moved here would strand the quest at a
	// foreign, colliding rank in its restored bucket.
	if (state.questDir && priorPriority !== "someday") {
		setQuestPriorityByDir(state.questDir, "someday");
		state.questPriority = "someday";
	}
	const sealedDocs = sealQuestDocuments(state.questDir, target);
	// Journal the seal so undo restores the status and the prior
	// priority bucket, not just the bulk path's version of the same.
	if (questId) {
		const changes: JournalChange[] = [
			{ id: questId, field: "status", old: priorStatus, new: target },
		];
		if (priorPriority !== "someday") {
			changes.push({
				id: questId,
				field: "priority",
				old: priorPriority,
				new: "someday",
			});
		}
		recordStructuralOp(state.questsRoot, action, changes);
	}
	// Reap any scratch dir recorded before workspaces existed; the
	// workspace itself goes at the end, once what it records is read.
	const reapedScratch = reapQuestScratchDir(state.questDir, state.scratchDir);
	state.scratchDir = null;
	appendJourneyEntry(
		state,
		action === "conclude"
			? "Concluded the quest."
			: `Retired the quest: ${params.reason?.trim()}.`,
	);
	for (const path of pruned) {
		logHarnessEntry(state, `Pruned tree at ${path}.`);
	}
	if (reapedScratch) {
		logHarnessEntry(state, "Reaped the managed scratch directory.");
	}
	// What the gates let through outside every tree, said once at the
	// end, so the record shows everything the quest touched.
	const outside = outsideWritesSaid(
		readOutsideWrites(defaultWorkspaceRoot(), state.questId),
	);
	if (outside) appendJourneyEntry(state, outside);
	const named = state.questTitle
		? `${state.questId} (${state.questTitle})`
		: state.questId;
	let message =
		action === "conclude"
			? `Concluded quest ${named}.`
			: `Retired quest ${named}.`;
	if (sealedDocs > 0) {
		appendJourneyEntry(
			state,
			`Sealed ${count(sealedDocs, "document")} with the quest.`,
		);
		message += ` Sealed ${count(sealedDocs, "document")}.`;
	}
	if (pruned.length > 0) message += ` Pruned ${count(pruned.length, "tree")}.`;
	if (audit && audit.uncited.length > 0) {
		message += ` No document cites ${audit.uncited.join(", ")}, so the backup leaves ${audit.uncited.length === 1 ? "it" : "them"} out.`;
	}
	// Warn about live children, matching the bulk path: sealing a loaded
	// parent leaves its live subquests orphaned but live, so surface them
	// rather than cascading or silently stranding them.
	if (questId) {
		const { index } = discoverQuests(state.questsRoot);
		const liveChildren: string[] = [];
		for (const childId of index.children.get(questId) ?? []) {
			const child = index.quests.get(childId);
			if (child && !isSealedStatus(child.doc.frontMatter.status)) {
				liveChildren.push(childId);
			}
		}
		if (liveChildren.length > 0) {
			message += ` Warning: ${count(liveChildren.length, "live child quest")} ${verb(liveChildren.length, "remains", "remain")} under a sealed parent: ${liveChildren.join(", ")}.`;
		}
	}
	const drift = action === "conclude" ? primaryPlanDrift(state) : undefined;
	if (drift) {
		const open = drift.total - drift.done;
		message += ` Warning: primary plan ${drift.planId} still has ${count(open, "unchecked item")} (${drift.done}/${drift.total} done); concluded anyway.`;
	}
	if (blocked.length > 0) {
		const detectedAt = new Date().toISOString();
		for (const b of blocked) {
			setPendingPrune(state.questDir, {
				path: b.path,
				reason: b.reason,
				detectedAt,
			});
		}
		message += ` ${count(blocked.length, "tree")} ${verb(blocked.length, "needs", "need")} manual resolution: ${blocked.map((b) => `${b.path}: ${b.reason}`).join("; ")}. Run \`tree-release\` with its cwd once that is settled.`;
	}
	if (outside) message += ` ${outside}`;
	const removed = await scratchRemoved(state.questId, signal);
	if (removed) {
		logHarnessEntry(state, removed);
		message += ` ${removed}`;
	}
	return ok(message, {
		scope: "quest",
		action,
		prunedTrees: pruned,
		blockedTrees: blocked,
		...(drift ? { planDrift: drift } : {}),
	});
}
