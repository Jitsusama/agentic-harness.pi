/**
 * Stage-machine verbs: think, draft, build, and conclude or retire
 * of the focused document, with the primary-plan pin a first plan's
 * draft sets. Which conclude or retire a call means is conclude.ts's;
 * sealing the loaded quest is seal.ts's, and a sweep sweep.ts's.
 */

import { nowYmd } from "../../../lib/internal/quest/dates.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
import {
	type DocumentFrontMatter,
	type DocumentKind,
	mintId,
	scaffoldDocument,
} from "../../../lib/quest/index.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import {
	appendJourneyEntry,
	autoFocusPlan,
	autoFocusSaid,
	createDocument,
	refreshProgress,
	stampQuestUpdated,
	unfocusDocument,
	writeDocumentStage,
} from "../lifecycle.ts";
import { type TransitionAction, transition } from "../machine.ts";
import type { QuestState } from "../state.ts";
import {
	DOCUMENT_KINDS_SET,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

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
			? `${documentNamed(state)} stays in ${state.documentStage}, put down; \`focus\` takes it up again. This ${action === "draft" ? "drafts a new document" : "starts a fresh loop"} beside it.`
			: `${documentNamed(state)} stays ${state.documentStage}, and this starts a fresh loop beside it.`;
		unfocusDocument(state);
		const result = stageTransition(state, action, params);
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
		appendJourneyEntry(state, `Building against ${documentNamed(state)}.`);
	} else if (action === "conclude") {
		appendJourneyEntry(state, `Concluded ${documentNamed(state)}.`);
	} else if (action === "retire") {
		appendJourneyEntry(
			state,
			`Retired ${documentNamed(state)}: ${params.reason ?? "no reason given"}.`,
		);
	}
	if (state.questDir) stampQuestUpdated(state);
	const landed = `Now ${result.state.stage} on ${documentNamed(state)}${state.documentTitle ? ` (${state.documentTitle})` : ""}.`;
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
 * The focused document in words: its kind and id, or, for a loop that
 * never drafted, that it had no document yet, so no answer says null.
 */
function documentNamed(state: QuestState): string {
	const kind = state.documentKind ?? "document";
	return state.documentId
		? `${kind} ${state.documentId}`
		: `${kind} loop with no document yet`;
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
