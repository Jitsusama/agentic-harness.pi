/**
 * A quest's record: what in a quest folder is kept, backed up and
 * protected, and what is not.
 *
 * The record is the README, the Journey beside it (`JOURNEY.md`), the
 * harness's bookkeeping beside that (`harness.log`), the documents (an
 * ID-named markdown file directly in a kind folder), and one shared
 * `attachments/` folder that any document may cite. Everything else a
 * quest makes (clones, raw data, labs, runs, builds) belongs in its
 * workspace outside the quests folder, so anything else found inside
 * one is a stray.
 *
 * The backup in the dotfiles (`quest-backup`) takes exactly this record
 * and must work without pi, so it keeps its own copy of these rules. A
 * change here needs the same change there.
 */

import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isId, prefixOf } from "./id.ts";

/** The folders a quest's documents live in, one per kind. */
export const DOCUMENT_FOLDERS = [
	"plans",
	"research",
	"briefs",
	"reports",
] as const;

/** The folder a quest's attachments live in. */
export const ATTACHMENTS_FOLDER = "attachments";

/** The file a quest's Journey lives in, beside its README. */
export const JOURNEY_FILE_NAME = "JOURNEY.md";

/** The harness's bookkeeping for a quest, beside its README. */
export const HARNESS_LOG_FILE_NAME = "harness.log";

/**
 * What a path is within a quest's record.
 *
 * - `quest`: the quest folder itself.
 * - `readme`: its README.
 * - `journey`: its Journey, beside the README.
 * - `log`: its harness log, beside the README.
 * - `document`: an ID-named markdown file directly in a kind folder.
 * - `folder`: a kind folder or the attachments folder itself.
 * - `attachment`: anything beneath the attachments folder.
 * - `stray`: anything else, which belongs in the workspace.
 */
export type RecordPlace =
	| "quest"
	| "readme"
	| "journey"
	| "log"
	| "document"
	| "folder"
	| "attachment"
	| "stray";

/** A path inside a quest folder, and what it is there. */
export interface QuestRecordPath {
	/** The quest's ID. */
	readonly quest: string;
	/** The quest's folder. */
	readonly questDir: string;
	/** The path relative to the quest's folder, `""` for the folder itself. */
	readonly rel: string;
	readonly place: RecordPlace;
}

/**
 * Which quest an absolute path belongs to and what it is there, or
 * undefined when it is not inside a quest folder.
 *
 * Quests sit directly under the quests root, one folder named by the
 * quest's ID, so the first segment beneath the root decides the quest.
 */
export function questRecordPath(
	questsRoot: string,
	path: string,
): QuestRecordPath | undefined {
	if (!isAbsolute(path)) return undefined;
	const fromRoot = relative(resolve(questsRoot), resolve(path));
	if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
		return undefined;
	}
	const [quest, ...rest] = fromRoot.split(sep);
	if (quest === undefined || prefixOf(quest) !== "QEST") return undefined;
	const rel = rest.join("/");
	return {
		quest,
		questDir: join(resolve(questsRoot), quest),
		rel,
		place: placeOf(rest),
	};
}

/** What a quest-relative path, given as its segments, is. */
function placeOf(segments: string[]): RecordPlace {
	const [top, name, ...deeper] = segments;
	if (top === undefined) return "quest";
	if (top === ATTACHMENTS_FOLDER) {
		return name === undefined ? "folder" : "attachment";
	}
	if (top === "README.md" && name === undefined) return "readme";
	if (top === JOURNEY_FILE_NAME && name === undefined) return "journey";
	if (top === HARNESS_LOG_FILE_NAME && name === undefined) return "log";
	if (!isKindFolder(top)) return "stray";
	if (name === undefined) return "folder";
	if (deeper.length > 0 || !isDocumentName(name)) return "stray";
	return "document";
}

function isKindFolder(name: string): boolean {
	return (DOCUMENT_FOLDERS as readonly string[]).includes(name);
}

/**
 * What an attachment may be. Text, read as a file with no NUL byte in
 * its first `sniffBytes`, up to `textBytes`; a raster image up to
 * `imageBytes`. The backup keeps the same numbers.
 */
export const ATTACHMENT_LIMITS = {
	textBytes: 1024 * 1024,
	imageBytes: 5 * 1024 * 1024,
	sniffBytes: 8192,
} as const;

/** Raster image types, which are the one binary an attachment may be. */
const IMAGE_TYPES = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"heic",
	"bmp",
	"ico",
]);

/**
 * Types that hold raw data rather than something a document cites:
 * databases, archives, git objects, logs, traces, dumps and builds. Their
 * home is the workspace even when they happen to be small or text.
 */
const RAW_DATA_TYPES = new Set([
	"db",
	"sqlite",
	"sqlite3",
	"zip",
	"tar",
	"tgz",
	"gz",
	"zst",
	"xz",
	"bz2",
	"7z",
	"pack",
	"idx",
	"jsonl",
	"ndjson",
	"log",
	"trace",
	"pcap",
	"dump",
	"core",
	"heapsnapshot",
	"cpuprofile",
	"slab",
	"bin",
	"parquet",
	"arrow",
	"wasm",
	"o",
	"a",
	"so",
	"dylib",
	"jar",
	"class",
	"pyc",
]);

/** What is known about a file that might be an attachment. */
export interface AttachmentFile {
	/** The path relative to the quest's folder. */
	readonly rel: string;
	readonly kind: "file" | "symlink" | "directory" | "other";
	readonly size: number;
	/** The file's first bytes, at least `sniffBytes` of them when it has that many. */
	readonly head: Uint8Array;
}

/** Why a file cannot be an attachment. */
export interface AttachmentProblem {
	readonly reason:
		| "not-a-file"
		| "in-a-checkout"
		| "raw-data"
		| "binary"
		| "too-large";
	/** The same, in words a refusal can quote. */
	readonly detail: string;
}

/**
 * Why a path cannot be an attachment, as far as its name decides: a path
 * inside a git checkout, or a raw-data type. Undefined when the name
 * allows it, which does not yet mean the file does.
 */
export function attachmentNameProblem(
	rel: string,
): AttachmentProblem | undefined {
	if (rel.split("/").includes(".git")) {
		return { reason: "in-a-checkout", detail: "part of a git checkout" };
	}
	const type = typeOf(rel);
	if (type !== undefined && RAW_DATA_TYPES.has(type)) {
		return { reason: "raw-data", detail: `a .${type} file, which is raw data` };
	}
	return undefined;
}

/**
 * Why a file cannot be an attachment, or undefined when it can. A folder
 * is fine, since it only holds attachments, unless it is a checkout's
 * `.git`.
 */
export function attachmentProblem(
	file: AttachmentFile,
): AttachmentProblem | undefined {
	const named = attachmentNameProblem(file.rel);
	if (named) return named;
	if (file.kind === "directory") return undefined;
	if (file.kind !== "file") {
		return {
			reason: "not-a-file",
			detail: `a ${file.kind}, not a regular file`,
		};
	}

	const type = typeOf(file.rel);
	if (type !== undefined && IMAGE_TYPES.has(type)) {
		return overLimit(file.size, ATTACHMENT_LIMITS.imageBytes, "image");
	}
	const sniffed = file.head.subarray(0, ATTACHMENT_LIMITS.sniffBytes);
	if (sniffed.includes(0)) {
		return { reason: "binary", detail: "binary, neither text nor an image" };
	}
	return overLimit(file.size, ATTACHMENT_LIMITS.textBytes, "text");
}

/** Which documents cite each attachment, and the links that lead nowhere. */
export interface AttachmentCitations {
	/** Each cited attachment's quest-relative path, and who cites it. */
	readonly cited: Map<string, string[]>;
	/** Links into `attachments/` that name no attachment, as written. */
	readonly broken: { document: string; target: string }[];
}

/** A markdown link or image target, inline or as a reference definition. */
const LINK_TARGET =
	/\]\(\s*(<[^>\n]+>|[^)\s]+)|^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/gm;

/** Any path-like run of text that goes through an `attachments/` folder. */
const MENTION = new RegExp(
	`[^\\s\`'"()<>\\[\\]|,;]*${ATTACHMENTS_FOLDER}/[^\\s\`'"()<>\\[\\]|,;]*`,
	"g",
);

const QUEST_ID = /QEST-\d{8}-[0-9A-Z]{6}/g;

/**
 * Which of a quest's documents cite each of its attachments.
 *
 * Documents live in the quest folder or one level down, so any mention
 * of an attachment runs through `attachments/`, whichever way it is
 * written: a link, an image, a reference definition, a code span, or a
 * path in prose or a code block. A mention of a folder cites everything
 * in it, and a glob cites the folder it starts in. A mention that names
 * another quest's folder is that quest's business.
 *
 * Only a link can be broken. Prose often names a path that does not exist
 * yet ("put the chart in attachments/cost.png"), while a link that goes
 * nowhere is a record that lost its attachment.
 */
export function attachmentCitations(
	quest: string,
	documents: readonly { rel: string; text: string }[],
	attachments: readonly string[],
): AttachmentCitations {
	const cited = new Map<string, string[]>();
	const broken: { document: string; target: string }[] = [];
	const credit = (document: string, mention: string): boolean => {
		const key = attachmentKey(quest, mention);
		if (key === undefined) return true;
		const matches = attachments.filter(
			(attachment) => attachment === key || attachment.startsWith(`${key}/`),
		);
		for (const attachment of matches) {
			const citers = cited.get(attachment) ?? [];
			if (!citers.includes(document)) citers.push(document);
			cited.set(attachment, citers);
		}
		return matches.length > 0;
	};

	for (const { rel, text } of documents) {
		for (const match of text.matchAll(LINK_TARGET)) {
			const written = (match[1] ?? match[2] ?? "").replace(/^<|>$/g, "");
			const target = decoded(written.replace(/[#?].*$/, ""));
			if (!target.includes(`${ATTACHMENTS_FOLDER}/`)) continue;
			if (!credit(rel, target)) broken.push({ document: rel, target: written });
		}
		for (const [mention] of text.matchAll(MENTION)) credit(rel, mention);
	}

	return { cited, broken };
}

/**
 * The quest-relative path a mention names under `attachments/`, or
 * undefined when it names another quest's, the folder as a whole, or
 * nothing that stays inside it.
 */
function attachmentKey(quest: string, mention: string): string | undefined {
	const ids = mention.match(QUEST_ID) ?? [];
	const owner = ids.at(-1);
	if (owner !== undefined && owner !== quest) return undefined;
	const marker = `${ATTACHMENTS_FOLDER}/`;
	const after = owner === undefined ? 0 : mention.lastIndexOf(owner);
	const at = mention.indexOf(marker, after);
	if (at < 0) return undefined;

	let within = mention.slice(at + marker.length).replace(/[#?].*$/, "");
	const glob = within.search(/[*?[{]/);
	if (glob >= 0) within = within.slice(0, within.lastIndexOf("/", glob) + 1);
	within = within.replace(/[.:;!?*_]+$/, "");
	const normal = posix.normalize(within).replace(/\/+$/, "");
	if (!normal || normal === "." || normal.startsWith("..")) return undefined;
	return `${marker}${normal}`;
}

/** A link target with its percent-encoding undone, or as written when malformed. */
function decoded(target: string): string {
	try {
		return decodeURI(target);
	} catch {
		return target;
	}
}

/** A size problem when `size` is over `limit`. */
function overLimit(
	size: number,
	limit: number,
	what: string,
): AttachmentProblem | undefined {
	if (size <= limit) return undefined;
	return {
		reason: "too-large",
		detail: `${mebibytes(size, 1)} MiB of ${what}, over the ${mebibytes(limit, 0)} MiB limit`,
	};
}

function mebibytes(bytes: number, digits: number): string {
	return (bytes / (1024 * 1024)).toFixed(digits);
}

/** A file's type, its last extension lowercased, or undefined without one. */
function typeOf(rel: string): string | undefined {
	const name = rel.split("/").at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** Whether a file name is a document's: a non-quest ID with `.md`. */
function isDocumentName(name: string): boolean {
	if (!name.endsWith(".md")) return false;
	const id = name.slice(0, -3);
	return isId(id) && prefixOf(id) !== "QEST";
}
