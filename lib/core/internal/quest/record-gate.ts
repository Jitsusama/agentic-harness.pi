/**
 * The record's rules for a single write, applied before it lands.
 *
 * A write is refused only when the rule it breaks is certain from the
 * path alone, and every refusal says where the write belongs instead, so
 * the refusal is a redirection rather than a dead end. What a path cannot
 * decide (an attachment's size, whether it is text, whether a document
 * cites it) is left to the check on disk after the write.
 *
 * The rules hold in every quest's folder, not only the loaded quest's,
 * since a write into another quest's record breaks that record just the
 * same.
 */

import { basename, join } from "node:path";
import {
	ATTACHMENTS_FOLDER,
	attachmentNameProblem,
	DOCUMENT_FOLDERS,
	type QuestRecordPath,
	questRecordPath,
} from "./record.ts";
import { questWorkspace } from "./workspace.ts";

/** One write or removal, already resolved to an absolute path. */
export interface RecordWrite {
	readonly path: string;
	readonly effect: "write" | "remove";
	/** A bash command, or the write and edit tools. */
	readonly via: "bash" | "tool";
	/** Whether something is already at the path. */
	readonly exists: boolean;
}

/** Where the record and the workspaces live. */
export interface RecordRoots {
	readonly questsRoot: string;
	readonly workspaceRoot: string;
}

/** A write the record refuses, why, and where it belongs instead. */
export interface RecordRefusal {
	readonly rule:
		| "document-by-hand"
		| "document-by-bash"
		| "document-removed"
		| "journey-by-hand"
		| "stray"
		| "attachment";
	readonly reason: string;
	/** The path the write belongs at, when it belongs somewhere else. */
	readonly instead?: string;
}

/** Characters that make a path's name a pattern rather than a name. */
const GLOB = /[*?[]/;

/** Judge one write or removal against the record's rules. */
export function judgeRecordWrite(
	write: RecordWrite,
	roots: RecordRoots,
): RecordRefusal | undefined {
	const place = questRecordPath(roots.questsRoot, write.path);
	if (!place) return undefined;
	return write.effect === "remove"
		? judgeRemoval(place)
		: judgeWrite(place, write, roots);
}

function judgeRemoval(place: QuestRecordPath): RecordRefusal | undefined {
	const { place: kind, rel } = place;
	const kept =
		kind === "document" ||
		kind === "readme" ||
		kind === "journey" ||
		kind === "folder" ||
		kind === "quest" ||
		(kind === "stray" && isKindFolderPattern(rel));
	if (!kept) return undefined;
	const what = kind === "quest" ? `the quest ${place.quest}` : rel;
	return {
		rule: "document-removed",
		reason:
			`This removes ${what}, which is part of ${place.quest}'s record. ` +
			"Documents, the README, the Journey and the record's folders leave only through " +
			"`quest retire`, which keeps what was written.",
	};
}

function judgeWrite(
	place: QuestRecordPath,
	write: RecordWrite,
	roots: RecordRoots,
): RecordRefusal | undefined {
	const { place: kind, rel } = place;
	if (kind === "quest" || kind === "folder") return undefined;

	if (kind === "journey") {
		return {
			rule: "journey-by-hand",
			reason:
				`This writes into ${rel}, ${place.quest}'s Journey. Add an entry ` +
				"with `quest journal` instead, which dates it, puts it at the head " +
				"and writes under the quest's lock.",
		};
	}

	if (kind === "document" || kind === "readme") {
		if (write.via === "bash") {
			return {
				rule: "document-by-bash",
				reason:
					`This bash command writes into ${rel}. Change a document or the ` +
					"README with the edit or write tool instead, so the change is one " +
					"the quest's own checks read.",
			};
		}
		if (!write.exists) {
			return {
				rule: "document-by-hand",
				reason:
					kind === "readme"
						? `${place.quest} has no README to change. A quest and its README are made by \`quest create\`.`
						: `${rel} is a new document. Documents are made by \`quest draft\`, which mints the ID and the front matter; run \`quest think\` and then \`quest draft\` instead.`,
			};
		}
		return undefined;
	}

	const workspace = questWorkspace(roots.workspaceRoot, place.quest).dir;
	if (kind === "attachment") {
		const problem = attachmentNameProblem(rel);
		if (!problem) return undefined;
		const instead = join(workspace, rel.slice(ATTACHMENTS_FOLDER.length + 1));
		return {
			rule: "attachment",
			reason:
				`${rel} is ${problem.detail}, and attachments hold only text and ` +
				`images a document cites. Put it in the quest's workspace instead: ${instead}`,
			instead,
		};
	}

	const instead = join(workspace, rel);
	const citable = attachmentNameProblem(rel) === undefined;
	return {
		rule: "stray",
		reason:
			`${rel} is not part of ${place.quest}'s record, which holds only its ` +
			"README, its JOURNEY.md, its documents and attachments/. Put it in the quest's " +
			`workspace instead: ${instead}` +
			(citable
				? `. If a document will cite it, ${ATTACHMENTS_FOLDER}/${basename(rel)} is its place.`
				: ""),
		instead,
	};
}

/** Whether a path is a pattern inside a kind folder, which may name documents. */
function isKindFolderPattern(rel: string): boolean {
	const [top, name, ...deeper] = rel.split("/");
	return (
		deeper.length === 0 &&
		name !== undefined &&
		GLOB.test(name) &&
		(DOCUMENT_FOLDERS as readonly string[]).includes(top ?? "")
	);
}
