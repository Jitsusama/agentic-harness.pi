/**
 * The record's rules, read from disk rather than from a single write.
 *
 * The gate judges a write by its path before it lands, which cannot see
 * what a command made without saying so, how big a file turned out, or
 * whether a document cites it. The audit reads the whole quest folder
 * afterwards and reports what the record holds that it should not: the
 * check after each write, conclude's refusal and the migration all ask
 * it the same question.
 */

import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	type Stats,
} from "node:fs";
import { basename, join } from "node:path";
import {
	ATTACHMENT_LIMITS,
	type AttachmentFile,
	type AttachmentProblem,
	attachmentCitations,
	attachmentProblem,
	questRecordPath,
} from "./record.ts";

/** What a quest folder holds that its record should not. */
export interface RecordAudit {
	/** Paths outside the record, each by its outermost folder or file. */
	readonly strays: string[];
	/** Attachments that break the limits, and how. */
	readonly attachments: { rel: string; problem: AttachmentProblem }[];
	/** Links into `attachments/` that name no attachment. */
	readonly broken: { document: string; target: string }[];
	/** Attachments no document cites, which the backup leaves out. */
	readonly uncited: string[];
}

/**
 * Files the quest machinery and the system keep in a quest folder: the
 * quest lock, the atomic writer's half-written files and Finder's notes.
 */
function isMachinery(name: string): boolean {
	return (
		name === ".quest.lock" ||
		name === ".DS_Store" ||
		/^\..+\.tmp-\d+-/.test(name)
	);
}

/** Read a quest folder and report what its record should not hold. */
export function auditQuestRecord(questDir: string): RecordAudit {
	const questsRoot = join(questDir, "..");
	const quest = basename(questDir);
	const strays: string[] = [];
	const problems: { rel: string; problem: AttachmentProblem }[] = [];
	const documents: { rel: string; text: string }[] = [];
	const attachments: string[] = [];

	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (isMachinery(name)) continue;
			const path = join(dir, name);
			const place = questRecordPath(questsRoot, path);
			if (!place) continue;
			const stats = lstatSync(path);
			switch (place.place) {
				case "stray":
					strays.push(place.rel);
					break;
				case "readme":
				case "document":
					if (stats.isFile()) {
						documents.push({
							rel: place.rel,
							text: readFileSync(path, "utf8"),
						});
					} else strays.push(place.rel);
					break;
				case "folder":
					if (stats.isDirectory()) walk(path);
					else strays.push(place.rel);
					break;
				case "attachment": {
					const problem = attachmentProblem(
						attachmentFileAt(path, place.rel, stats),
					);
					if (problem) problems.push({ rel: place.rel, problem });
					else if (stats.isDirectory()) walk(path);
					else attachments.push(place.rel);
					break;
				}
			}
		}
	};
	walk(questDir);

	const { cited, broken } = attachmentCitations(quest, documents, attachments);
	return {
		strays: strays.sort(),
		attachments: problems.sort((a, b) => compare(a.rel, b.rel)),
		broken,
		uncited: attachments.filter((rel) => !cited.has(rel)).sort(),
	};
}

/**
 * Whether a record may conclude as it is. Uncited attachments do not
 * stop it: the backup leaves them out, which is their only cost.
 */
export function isRecordSound(audit: RecordAudit): boolean {
	return (
		audit.strays.length === 0 &&
		audit.attachments.length === 0 &&
		audit.broken.length === 0
	);
}

/**
 * What the attachment rules need to know about one path on disk, named
 * by `rel` as it would sit in the record. The migration asks this of a
 * file before it moves, so it is judged the same way the audit would
 * judge it once it lands.
 */
export function attachmentFileAt(
	path: string,
	rel: string,
	stats: Stats = lstatSync(path),
): AttachmentFile {
	const kind = stats.isSymbolicLink()
		? "symlink"
		: stats.isDirectory()
			? "directory"
			: stats.isFile()
				? "file"
				: "other";
	return {
		rel,
		kind,
		size: stats.size,
		head: kind === "file" ? headOf(path) : new Uint8Array(),
	};
}

/** A file's first bytes, as many as the text sniff reads. */
function headOf(path: string): Uint8Array {
	const buffer = new Uint8Array(ATTACHMENT_LIMITS.sniffBytes);
	const fd = openSync(path, "r");
	try {
		return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
	} finally {
		closeSync(fd);
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
