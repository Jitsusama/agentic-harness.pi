/**
 * Which conclude or retire a call means: the loaded quest sealed in
 * full, a document finished by id here or in another quest, the
 * focused document through the stage machine, or a sweep of quests.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { parseDocumentFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { refuseSealingDryRun } from "../dry-run.ts";
import { focusDocument, writeDocumentStage } from "../lifecycle.ts";
import { transition } from "../machine.ts";
import type { QuestState } from "../state.ts";
import { type Address, addressOf } from "./address.ts";
import { subdirForDocumentId } from "./queries.ts";
import { sealLoadedQuest } from "./seal.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";
import { stageTransition } from "./stage.ts";
import { sweepQuests } from "./sweep.ts";

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
	const result = stageTransition(state, action, params);
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
export async function concludeOrRetire(
	state: QuestState,
	action: "conclude" | "retire",
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	// An explicit id targets that id rather than the loaded quest, so
	// naming an id never silently falls through to the loaded quest.
	// A single document-kind id concludes that document (not
	// undoable, see concludeDocumentById); a quest id or any comma
	// list runs the sweep, which removes each quest's scratch folder and
	// whose undo restores only status and priority.
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
		// Quest ids, and any comma list, run the quest sweep.
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
				concludeDocumentById(state, action, params, targetId, subdir)
			);
		}
		if (declaredScope === "quest") {
			return sweepQuests(state, action, params);
		}
		if (subdir) {
			return (
				refuseSealingDryRun(params, action, `document ${targetId}`) ??
				concludeDocumentById(state, action, params, targetId, subdir)
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
			) ?? stageTransition(state, action, params)
		);
	}
	// Sealing a quest is final, prunes its trees and sets it to someday,
	// so it is never inferred from what happens to be loaded. A quest was
	// once concluded this way when the person meant to put it down.
	return refuse(
		`${action === "conclude" ? "Concluding" : "Retiring"} a quest seals it for good, so it needs the quest named: pass \`id: ${state.questId}\` (${state.questTitle ?? "the loaded quest"}) to ${action} it. To stop working on it without sealing it, use \`unload\`.`,
	);
}
