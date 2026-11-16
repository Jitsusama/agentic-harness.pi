/**
 * Concluding or retiring quests by id, the loaded one aside: core
 * seals the records, a conclude holds each to the record audit, and
 * each one's scratch goes, said in full since `undo` never brings it
 * back.
 */

import { existsSync } from "node:fs";
import {
	auditQuestRecord,
	isRecordSound,
} from "../../../lib/core/internal/quest/record-audit.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import { appendHarnessLog } from "../../../lib/internal/quest/harness-log.ts";
import { reapQuestScratchDir } from "../../../lib/internal/quest/scratch.ts";
import { count } from "../../../lib/ui/count.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { wakeSealedQuestParks } from "../ends-with-quest.ts";
import { recordBreakage } from "../record-watch.ts";
import type { QuestState } from "../state.ts";
import { defaultWorkspaceRoot, workspaceDirOf } from "../workspace.ts";
import { scratchLeftElsewhere, scratchRemoved } from "./scratch-removal.ts";
import { type QuestResult, type QuestToolParams, refuse } from "./shared.ts";
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
 * Conclude or retire a list of quests, then remove what each one's
 * conclude would have: its whole scratch folder and any scratch
 * recorded before workspaces. Core seals the records; the workspace
 * root is this package's to know.
 *
 * Both the answer and a dry run's say which scratch folders go, since
 * `undo` brings back only status and priority: on 2026-11-04 a sweep
 * of 11 quests said it was reversible and took 1,010 files an archive
 * of them was to keep (N10TYF [1ed1ae94]).
 *
 * A conclude holds each record to the audit a single conclude does,
 * concluding the whole ones and naming the rest with what to put right,
 * so one untidy quest neither slips through nor stalls the batch. A
 * retire is abandoned as it stands, as it is one quest at a time.
 */
export async function sweepQuests(
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
	const changes = (result.details?.changes ?? []) as { id: string }[];
	const { index } = discoverQuests(state.questsRoot);
	if (result.details?.dryRun) {
		return {
			...result,
			message: `${result.message}\n${scratchToGo(changes, index)}`,
		};
	}
	const removed: string[] = [];
	const left: string[] = [];
	const woken: string[] = [];
	for (const { id } of changes) {
		const entry = index.quests.get(id);
		if (!entry) continue;
		const older = entry.doc.frontMatter.scratchDir ?? null;
		if (reapQuestScratchDir(entry.dir, older)) {
			appendHarnessLog(entry.dir, "Reaped the managed scratch directory.");
			removed.push(
				`${id}: Removed its older scratch directory, ${displayPath(older ?? "")}.`,
			);
		}
		if (id === state.questId) state.scratchDir = null;
		const said = await scratchRemoved(
			id,
			undefined,
			undefined,
			undefined,
			state.inUse,
		);
		if (said) {
			appendHarnessLog(entry.dir, said);
			removed.push(`${id}: ${said}`);
		}
		const elsewhere = scratchLeftElsewhere(
			id,
			entry.doc.frontMatter.sessions ?? [],
		);
		if (elsewhere) {
			appendHarnessLog(entry.dir, elsewhere);
			left.push(`${id}: ${elsewhere}`);
		}
		const woke = wakeSealedQuestParks(id);
		if (woke) {
			appendHarnessLog(entry.dir, woke);
			woken.push(`${id}: ${woke}`);
		}
	}
	const beyond =
		(left.length === 0
			? ""
			: `\nWhat it couldn't remove from here:\n${left.map((l) => `- ${l}`).join("\n")}`) +
		(woken.length === 0
			? ""
			: `\nTheir parked sessions:\n${woken.map((l) => `- ${l}`).join("\n")}`);
	return {
		...result,
		message:
			(removed.length === 0
				? `${result.message} None had a scratch folder to remove; ${UNDO_KEEPS}.`
				: `${result.message}\nWhat went with them, for good, since ${UNDO_KEEPS}:\n${removed.map((l) => `- ${l}`).join("\n")}`) +
			beyond,
	};
}

/** What `undo` gives back of a sweep, said wherever a sweep answers. */
const UNDO_KEEPS =
	"undo brings back only their status and priority, never a scratch folder";

/**
 * What a dry run of a sweep would remove: each quest's scratch folder
 * that exists, and any scratch recorded before workspaces.
 */
function scratchToGo(
	changes: readonly { id: string }[],
	index: ReturnType<typeof discoverQuests>["index"],
): string {
	const going: string[] = [];
	const left: string[] = [];
	for (const { id } of changes) {
		const dir = workspaceDirOf(defaultWorkspaceRoot(), id);
		const older = index.quests.get(id)?.doc.frontMatter.scratchDir;
		const paths = [
			...(dir && existsSync(dir) ? [`${displayPath(dir)}/`] : []),
			...(older && existsSync(older) ? [displayPath(older)] : []),
		];
		if (paths.length > 0) going.push(`  ${id}: ${paths.join(", ")}`);
		const elsewhere = scratchLeftElsewhere(
			id,
			index.quests.get(id)?.doc.frontMatter.sessions ?? [],
		);
		if (elsewhere) left.push(`  ${id}: ${elsewhere}`);
	}
	const beyond =
		left.length === 0
			? ""
			: `\nWhat it can't remove from here:\n${left.join("\n")}`;
	if (going.length === 0) {
		return `None has a scratch folder to remove; ${UNDO_KEEPS}.${beyond}`;
	}
	return `Run for real, it also removes ${going.length === 1 ? "this scratch folder" : `these ${going.length} scratch folders`}, whole, and ${UNDO_KEEPS}; move what is worth keeping into each quest's attachments/ first:\n${going.join("\n")}${beyond}`;
}
