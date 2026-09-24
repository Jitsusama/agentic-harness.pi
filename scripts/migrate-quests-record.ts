/**
 * One-shot migrator that brings every quest folder down to its record:
 * the README, the ID documents in the kind folders and one shared
 * `attachments/` folder. Everything else moves to the quest's
 * workspace, outside the quests folder.
 *
 * Each path the record audit calls a stray is sorted three ways:
 *
 * 1. A file a document cites moves to `attachments/`, keeping its
 *    path, so nothing collides. A cited file over the attachment
 *    limits, or inside a git checkout, stays with its folder.
 * 2. Markdown and images in the kind folders, and loose at the quest's
 *    root, form the review bucket. They move to `attachments/` unless
 *    their group is listed in the `--to-workspace` file, one
 *    `<quest>/<folder>` key per line, which sends that folder and
 *    everything under it to the workspace instead. A Journey entry
 *    cites the groups kept, so the backup keeps them.
 * 3. Everything else moves to the workspace whole: labs, evidence,
 *    clones, raw data.
 *
 * References to a moved path are rewritten, in every quest's documents
 * and markdown attachments: markdown links, images, reference
 * definitions and paths in code spans. Only a reference that resolves
 * to a file or folder before the move is touched, and fenced code
 * blocks are left alone.
 *
 * Moves, never deletes. Idempotent: a second run finds nothing to do.
 * Dry run by default, printing a summary; pass --manifest <file> to
 * write the full manifest for review, and --apply to migrate, which
 * writes a JSON journal of every move and rewrite. --root and
 * --workspace point at stores other than the defaults. --skip takes
 * comma-separated quest IDs to leave for a later run, such as quests a
 * live session is writing in; links from them are still rewritten.
 *
 *   pnpm tsx scripts/migrate-quests-record.ts [--apply] [--manifest <file>]
 *     [--to-workspace <file>] [--journal <file>] [--root <path>]
 *     [--workspace <path>] [--skip <id,id>]
 */

import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	ATTACHMENTS_FOLDER,
	attachmentProblem,
	DOCUMENT_FOLDERS,
} from "@jitsusama/agentic-harness.core/quest/record";
import {
	attachmentFileAt,
	auditQuestRecord,
} from "@jitsusama/agentic-harness.core/quest/record-audit";
import { questWorkspace } from "@jitsusama/agentic-harness.core/quest/workspace";
import { defaultWorkspaceRoot } from "../extensions/quest-workflow/workspace.ts";
import { dataDir } from "../lib/internal/paths.ts";
import { appendJourneyByPath } from "../lib/internal/quest/append-journey.ts";
import { atomicWriteFile, withQuestLock } from "../lib/internal/quest/io.ts";

export interface MigrationOptions {
	questsRoot: string;
	workspaceRoot: string;
	/** Review groups, as `<quest>/<folder>`, to send to the workspace. */
	toWorkspace?: string[];
	/**
	 * Quests to leave for a later run, such as one a live session is
	 * working in. Nothing in them moves, so no link into them changes.
	 */
	skip?: string[];
}

export type MoveReason = "cited" | "review" | "working";

export interface Move {
	quest: string;
	/** The path inside the quest folder, before the move. */
	rel: string;
	from: string;
	to: string;
	reason: MoveReason;
	/** The review group, `<quest>/<folder>`, for a review move. */
	group?: string;
	files: number;
	bytes: number;
}

export interface Rewrite {
	/** Where the file lives once the moves are done. */
	file: string;
	quest: string;
	text: string;
	changes: { before: string; after: string }[];
}

export interface MigrationPlan {
	questsRoot: string;
	workspaceRoot: string;
	moves: Move[];
	rewrites: Rewrite[];
	collisions: string[];
}

const QUEST_ID = /^QEST-\d{8}-[0-9A-Z]{6}$/;
const DOCUMENT_NAME = /^(PLAN|RSCH|BRIF|RPRT)-\d{8}-[0-9A-Z]{6}\.md$/;
const REVIEWABLE = /\.(md|markdown|png|jpe?g|gif|webp|svg)$/i;
const PATHLIKE = /^(?:\.{1,2}\/|~\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// ---------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------

/** Work out every move and rewrite the migration would make. */
export function planRecordMigration(options: MigrationOptions): MigrationPlan {
	const { questsRoot, workspaceRoot } = options;
	const keys = options.toWorkspace ?? [];
	const sentToWorkspace = (group: string) =>
		keys.some((k) => group === k || group.startsWith(`${k}/`));
	const moves: Move[] = [];
	const collisions: string[] = [];
	const skipped = new Set(options.skip ?? []);
	const quests = readdirSync(questsRoot)
		.filter((name) => QUEST_ID.test(name))
		.sort();

	for (const quest of quests.filter((q) => !skipped.has(q))) {
		const questDir = join(questsRoot, quest);
		const audit = auditQuestRecord(questDir);
		if (audit.strays.length === 0 && audit.attachments.length === 0) continue;
		const workspace = questWorkspace(workspaceRoot, quest).dir;
		const cited = citedFiles(questsRoot, quest);
		const planned = new Set<string>();

		const move = (
			rel: string,
			to: string,
			reason: MoveReason,
			group?: string,
		): boolean => {
			if (exists(to)) {
				collisions.push(`${quest}/${rel}: ${to} already exists`);
				return false;
			}
			const from = join(questDir, rel);
			const size = reason === "working" ? sizeOf(from, planned) : undefined;
			moves.push({
				quest,
				rel,
				from,
				to,
				reason,
				...(group ? { group } : {}),
				files: size?.files ?? 1,
				bytes: size?.bytes ?? lstatSync(from).size,
			});
			planned.add(from);
			return true;
		};
		const attach = (rel: string) => join(questDir, ATTACHMENTS_FOLDER, rel);
		const fits = (rel: string) =>
			!attachmentProblem(
				attachmentFileAt(join(questDir, rel), `${ATTACHMENTS_FOLDER}/${rel}`),
			);
		const groupOf = (rel: string) =>
			dirname(rel) === "." ? quest : `${quest}/${dirname(rel)}`;

		for (const rel of audit.strays) {
			const abs = join(questDir, rel);
			const stats = lstatSync(abs);
			const inKindFolder = rel.includes("/");
			if (!stats.isDirectory()) {
				const group = groupOf(rel);
				if (cited.has(abs) && fits(rel)) move(rel, attach(rel), "cited");
				else if (REVIEWABLE.test(rel) && fits(rel) && !sentToWorkspace(group))
					move(rel, attach(rel), "review", group);
				else move(rel, join(workspace, rel), "working");
				continue;
			}
			if (!isCheckout(abs)) {
				for (const file of [...cited].sort()) {
					if (!file.startsWith(`${abs}/`)) continue;
					const fileRel = relative(questDir, file);
					if (insideCheckout(abs, file) || !fits(fileRel)) continue;
					move(fileRel, attach(fileRel), "cited");
				}
				if (inKindFolder) {
					// A folder is reviewed as one group, however deep it goes,
					// so the manifest asks one question per folder a person
					// made; a finer key in the decisions still matches.
					for (const file of reviewableUnder(abs)) {
						if (cited.has(file)) continue;
						const fileRel = relative(questDir, file);
						const group = sentToWorkspace(groupOf(fileRel))
							? undefined
							: `${quest}/${rel}`;
						if (!fits(fileRel) || !group || sentToWorkspace(group)) continue;
						move(fileRel, attach(fileRel), "review", group);
					}
				}
			}
			move(rel, join(workspace, rel), "working");
		}
		for (const { rel } of audit.attachments) {
			move(
				rel,
				join(workspace, rel.slice(ATTACHMENTS_FOLDER.length + 1)),
				"working",
			);
		}
	}

	const order = { cited: 0, review: 0, working: 1 };
	moves.sort(
		(a, b) =>
			order[a.reason] - order[b.reason] ||
			compare(a.quest, b.quest) ||
			compare(a.rel, b.rel),
	);
	const rewrites = planRewrites(questsRoot, quests, moves);
	return { questsRoot, workspaceRoot, moves, rewrites, collisions };
}

/** Files inside the quest that its README or one of its documents cites. */
function citedFiles(questsRoot: string, quest: string): Set<string> {
	const questDir = join(questsRoot, quest);
	const cited = new Set<string>();
	for (const document of documentsOf(questDir)) {
		const text = readFileSync(document, "utf8");
		for (const ref of references(text)) {
			const target = resolveReference(ref, dirname(document), questDir);
			if (!target?.abs.startsWith(`${questDir}/`)) continue;
			if (lstatSync(target.abs).isFile()) cited.add(target.abs);
		}
	}
	return cited;
}

/** The README and the ID documents in the kind folders. */
function documentsOf(questDir: string): string[] {
	const found = [join(questDir, "README.md")].filter(isFile);
	for (const folder of DOCUMENT_FOLDERS) {
		const dir = join(questDir, folder);
		if (!isDirectory(dir)) continue;
		for (const name of readdirSync(dir).sort()) {
			if (DOCUMENT_NAME.test(name) && isFile(join(dir, name))) {
				found.push(join(dir, name));
			}
		}
	}
	return found;
}

/** Markdown attachments already in the record. */
function markdownAttachmentsOf(questDir: string): string[] {
	const dir = join(questDir, ATTACHMENTS_FOLDER);
	if (!isDirectory(dir)) return [];
	return walkFiles(dir).filter((file) => /\.(md|markdown)$/i.test(file));
}

/** Markdown and images under a folder, skipping checkouts and packages. */
function reviewableUnder(dir: string): string[] {
	return walkFiles(dir).filter((file) => REVIEWABLE.test(file));
}

/** Regular files under a folder, never entering a checkout or packages. */
function walkFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		for (const name of readdirSync(current).sort()) {
			const path = join(current, name);
			const stats = lstatSync(path);
			if (stats.isDirectory()) {
				if (name === "node_modules" || isCheckout(path)) continue;
				walk(path);
			} else if (stats.isFile()) found.push(path);
		}
	};
	walk(dir);
	return found;
}

/** How much a move carries, less what earlier moves take out of it. */
function sizeOf(
	path: string,
	taken: Set<string>,
): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	const walk = (current: string, stats: Stats): void => {
		if (taken.has(current)) return;
		if (!stats.isDirectory()) {
			files += 1;
			bytes += stats.size;
			return;
		}
		for (const name of readdirSync(current)) {
			const child = join(current, name);
			walk(child, lstatSync(child));
		}
	};
	walk(path, lstatSync(path));
	return { files, bytes };
}

function isCheckout(dir: string): boolean {
	return exists(join(dir, ".git"));
}

/** Whether a file sits in a checkout somewhere below `top`. */
function insideCheckout(top: string, file: string): boolean {
	for (let dir = dirname(file); dir.startsWith(top); dir = dirname(dir)) {
		if (isCheckout(dir)) return true;
		if (dir === top) break;
	}
	return false;
}

// ---------------------------------------------------------------------
// References
// ---------------------------------------------------------------------

/** One place a markdown file names a path. */
interface Reference {
	start: number;
	end: number;
	raw: string;
	form: "link" | "span";
}

/** How a reference spelled its path, kept when it is rewritten. */
type Style = "tilde" | "absolute" | "document" | "quest";

const INLINE =
	/!?\[(?:[^\]\\]|\\.)*\]\(\s*<?(?<target>[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/dg;
const REFERENCE_DEFINITION =
	/^ {0,3}\[[^\]]+\]:\s*<?(?<target>[^\s>]+)>?(?:\s+.*)?$/dgm;
const IMAGE_TAG = /<img[^>]+src=["'](?<target>[^"']+)/dgi;
const CODE_SPAN = /(`+)([^`][\s\S]*?)\1(?!`)/g;

/** Every link, image, reference definition and path in a code span. */
function references(text: string): Reference[] {
	const found: Reference[] = [];
	let masked = maskFences(text);
	for (const match of masked.matchAll(CODE_SPAN)) {
		const body = match[2];
		const trimmed = body.trim();
		const start = (match.index ?? 0) + match[1].length + body.indexOf(trimmed);
		// A span of dots and slashes (`./`, `../`) points somewhere
		// relative to where it is read rather than naming anything.
		const names = /[^./]/.test(trimmed);
		if (names && trimmed.includes("/") && PATHLIKE.test(trimmed)) {
			found.push({
				start,
				end: start + trimmed.length,
				raw: trimmed,
				form: "span",
			});
		}
	}
	masked = masked.replace(CODE_SPAN, (span) => " ".repeat(span.length));
	for (const pattern of [INLINE, REFERENCE_DEFINITION, IMAGE_TAG]) {
		for (const match of masked.matchAll(pattern)) {
			const range = match.indices?.groups?.target;
			if (!range) continue;
			found.push({
				start: range[0],
				end: range[1],
				raw: text.slice(range[0], range[1]),
				form: "link",
			});
		}
	}
	return found.sort((a, b) => a.start - b.start);
}

/** The text with fenced code blocks blanked, keeping every offset. */
function maskFences(text: string): string {
	const lines = text.split("\n");
	let fence: string | undefined;
	return lines
		.map((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (fence === undefined) {
				if (!marker) return line;
				fence = marker;
				return " ".repeat(line.length);
			}
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
				if (line.trim() === marker) fence = undefined;
			}
			return " ".repeat(line.length);
		})
		.join("\n");
}

/** Where a reference leads before the migration, if anywhere. */
function resolveReference(
	ref: Reference,
	documentDir: string,
	questDir: string,
): { abs: string; style: Style; suffix: string } | undefined {
	const cut = ref.raw.search(/[#?]/);
	const path = cut < 0 ? ref.raw : ref.raw.slice(0, cut);
	const suffix = cut < 0 ? "" : ref.raw.slice(cut);
	if (!path || SCHEME.test(path)) return;
	const decoded = safeDecode(path);
	const candidates: [string, Style][] = decoded.startsWith("~/")
		? [[join(homedir(), decoded.slice(2)), "tilde"]]
		: isAbsolute(decoded)
			? [[decoded, "absolute"]]
			: ref.form === "link"
				? [[join(documentDir, decoded), "document"]]
				: [
						[join(documentDir, decoded), "document"],
						[join(questDir, decoded), "quest"],
					];
	for (const [candidate, style] of candidates) {
		const abs = candidate.replace(/\/+$/, "");
		if (exists(abs)) return { abs, style, suffix };
	}
}

function safeDecode(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

// ---------------------------------------------------------------------
// Rewrites
// ---------------------------------------------------------------------

/** Where a path ends up once every move is made. */
function destinationMap(moves: Move[]): (path: string) => string {
	const exact = new Map<string, string>();
	const folders: [string, string][] = [];
	for (const move of moves) {
		exact.set(move.from, move.to);
		folders.push([move.from, move.to]);
	}
	folders.sort((a, b) => b[0].length - a[0].length);
	return (path) => {
		const hit = exact.get(path);
		if (hit) return hit;
		for (const [from, to] of folders) {
			if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
		}
		return path;
	};
}

/** The rewrites every record markdown file needs once the moves land. */
function planRewrites(
	questsRoot: string,
	quests: string[],
	moves: Move[],
): Rewrite[] {
	const after = destinationMap(moves);
	const rewrites: Rewrite[] = [];
	for (const quest of quests) {
		const questDir = join(questsRoot, quest);
		const files = [
			...documentsOf(questDir),
			...markdownAttachmentsOf(questDir),
			...moves
				.filter((m) => m.quest === quest && m.reason !== "working")
				.filter((m) => /\.(md|markdown)$/i.test(m.rel))
				.map((m) => m.from),
		];
		for (const file of files) {
			const rewrite = rewriteOf(file, quest, questsRoot, after);
			if (rewrite) rewrites.push(rewrite);
		}
	}
	return rewrites;
}

function rewriteOf(
	file: string,
	quest: string,
	questsRoot: string,
	after: (path: string) => string,
): Rewrite | undefined {
	const questDir = join(questsRoot, quest);
	const text = readFileSync(file, "utf8");
	const moved = after(file);
	const changes: { before: string; after: string }[] = [];
	let result = text;
	for (const ref of references(text).reverse()) {
		const target = resolveReference(ref, dirname(file), questDir);
		if (!target) continue;
		const destination = after(target.abs);
		const relativeStyle =
			target.style === "document" || target.style === "quest";
		if (destination === target.abs && (moved === file || !relativeStyle)) {
			continue;
		}
		const spelled = spell(destination, target.style, ref, {
			questsRoot,
			questDir,
			documentDir: dirname(moved),
		});
		const replacement = spelled + target.suffix;
		if (replacement === ref.raw) continue;
		changes.unshift({ before: ref.raw, after: replacement });
		result = result.slice(0, ref.start) + replacement + result.slice(ref.end);
	}
	if (changes.length === 0) return;
	return { file: moved, quest, text: result, changes };
}

/** A reference's new path, spelled the way the original was. */
function spell(
	destination: string,
	style: Style,
	ref: Reference,
	where: { questsRoot: string; questDir: string; documentDir: string },
): string {
	const slash = /\/(?:[#?].*)?$/.test(ref.raw) ? "/" : "";
	const tilde = (path: string) =>
		path.startsWith(`${homedir()}/`)
			? `~/${path.slice(homedir().length + 1)}`
			: path;
	let path: string;
	if (style === "tilde") path = tilde(destination);
	else if (style === "absolute") path = destination;
	else if (!destination.startsWith(`${where.questsRoot}/`)) {
		path = ref.form === "link" ? destination : tilde(destination);
	} else if (
		style === "quest" &&
		destination.startsWith(`${where.questDir}/`)
	) {
		path = relative(where.questDir, destination);
	} else {
		path = relative(where.documentDir, destination) || ".";
	}
	path = path.split(sep).join("/") + slash;
	const encode =
		ref.raw.includes("%") || (ref.form === "link" && /[\s()]/.test(path));
	return encode ? encodeURI(path) : path;
}

// ---------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------

interface Journal {
	startedAt: string;
	questsRoot: string;
	workspaceRoot: string;
	moves: { from: string; to: string; reason: MoveReason }[];
	rewrites: { file: string; changes: { before: string; after: string }[] }[];
	journeys: { quest: string; entry: string }[];
	error?: string;
}

/**
 * Make the moves, then the rewrites, then a Journey entry per quest.
 * The journal is written whatever happens, so a run that stops part
 * way says exactly what it did.
 */
export function applyRecordMigration(
	plan: MigrationPlan,
	options: { journal: string; now?: () => Date },
): void {
	const journal: Journal = {
		startedAt: (options.now?.() ?? new Date()).toISOString(),
		questsRoot: plan.questsRoot,
		workspaceRoot: plan.workspaceRoot,
		moves: [],
		rewrites: [],
		journeys: [],
	};
	try {
		for (const move of plan.moves) {
			mkdirSync(dirname(move.to), { recursive: true });
			renameSync(move.from, move.to);
			journal.moves.push({ from: move.from, to: move.to, reason: move.reason });
		}
		for (const rewrite of plan.rewrites) {
			withQuestLock(join(plan.questsRoot, rewrite.quest), () =>
				atomicWriteFile(rewrite.file, rewrite.text),
			);
			journal.rewrites.push({ file: rewrite.file, changes: rewrite.changes });
		}
		for (const [quest, entry] of journeyEntries(plan)) {
			appendJourneyByPath(join(plan.questsRoot, quest), entry, {
				now: options.now,
			});
			journal.journeys.push({ quest, entry });
		}
	} catch (error) {
		journal.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		mkdirSync(dirname(options.journal), { recursive: true });
		writeFileSync(options.journal, `${JSON.stringify(journal, null, "\t")}\n`);
	}
}

/**
 * The Journey entry each migrated quest gets: where its working
 * material went, and a citation of each review group it kept, which is
 * what keeps those attachments in the backup.
 */
function journeyEntries(plan: MigrationPlan): Map<string, string> {
	const entries = new Map<string, string>();
	const quests = [...new Set(plan.moves.map((m) => m.quest))].sort();
	for (const quest of quests) {
		const moves = plan.moves.filter((m) => m.quest === quest);
		const sentences: string[] = [];
		if (moves.some((m) => m.reason === "working")) {
			const workspace = questWorkspace(plan.workspaceRoot, quest).dir;
			const shown = workspace.startsWith(`${homedir()}/`)
				? `~/${workspace.slice(homedir().length + 1)}`
				: workspace;
			sentences.push(
				`Moved working material out of the record into the workspace, \`${shown}/\`.`,
			);
		} else {
			sentences.push("Moved working material into the record's attachments.");
		}
		const kept = keptCitations(moves);
		if (kept.length > 0) {
			sentences.push(
				`Kept as attachments: ${kept.map((c) => `\`${c}\``).join(", ")}.`,
			);
		}
		entries.set(quest, wrap(sentences.join(" ")));
	}
	return entries;
}

/** One citation per kept review group, dropping groups inside another. */
function keptCitations(moves: Move[]): string[] {
	const folders = new Set<string>();
	const files: string[] = [];
	for (const move of moves) {
		if (move.reason !== "review") continue;
		const folder = dirname(move.rel);
		if (folder === ".") files.push(`${ATTACHMENTS_FOLDER}/${move.rel}`);
		else folders.add(folder);
	}
	const outermost = [...folders].filter(
		(f) => ![...folders].some((g) => g !== f && f.startsWith(`${g}/`)),
	);
	return [
		...files.sort(),
		...outermost.sort().map((f) => `${ATTACHMENTS_FOLDER}/${f}/`),
	];
}

/** Wrap Journey prose to the column rule, as continuation lines. */
function wrap(prose: string): string {
	const lines: string[] = [];
	let line = "";
	let width = 72 - "- **YYYY-MM-DD**: ".length;
	for (const word of prose.split(" ")) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
			width = 70;
		} else line = line ? `${line} ${word}` : word;
	}
	lines.push(line);
	return lines.join("\n  ");
}

// ---------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------

/** The dry run in full, for a person to review before anything moves. */
export function renderManifest(plan: MigrationPlan): string {
	const total = (moves: Move[]) => ({
		files: moves.reduce((n, m) => n + m.files, 0),
		bytes: moves.reduce((n, m) => n + m.bytes, 0),
	});
	const row = (label: string, moves: Move[]) => {
		const { files, bytes } = total(moves);
		return `| ${label} | ${files} | ${mib(bytes)} |`;
	};
	const cited = plan.moves.filter((m) => m.reason === "cited");
	const review = plan.moves.filter((m) => m.reason === "review");
	const working = plan.moves.filter((m) => m.reason === "working");
	const lines = [
		"# Quest Record Migration",
		"",
		`Planned over \`${plan.questsRoot}\`, with workspaces in \`${plan.workspaceRoot}\`.`,
		"",
		"| Destination | Files | Size |",
		"| --- | ---: | ---: |",
		row("attachments, cited", cited),
		row("attachments, review bucket", review),
		row("workspace", working),
		"",
		`${plan.rewrites.length} files get rewritten references, and ${plan.collisions.length} moves collide.`,
		"",
		"## Review Bucket",
		"",
		"Each group moves to `attachments/` unless its key is listed in the",
		"`--to-workspace` file, which sends the folder and everything under",
		"it to the workspace.",
		"",
		"| Group | Files | Size | Examples |",
		"| --- | ---: | ---: | --- |",
	];
	const groups = new Map<string, Move[]>();
	for (const move of review) {
		const key = move.group ?? move.quest;
		groups.set(key, [...(groups.get(key) ?? []), move]);
	}
	for (const [group, moves] of [...groups].sort((a, b) =>
		compare(a[0], b[0]),
	)) {
		const { files, bytes } = total(moves);
		const examples = moves
			.slice(0, 3)
			.map((m) => basename(m.rel))
			.join(", ");
		lines.push(
			`| \`${group}\` | ${files} | ${mib(bytes)} | ${examples}${moves.length > 3 ? ", …" : ""} |`,
		);
	}
	if (plan.collisions.length > 0) {
		lines.push("", "## Collisions", "");
		for (const collision of plan.collisions) lines.push(`- ${collision}`);
	}
	lines.push("", "## Moves by Quest");
	for (const quest of [...new Set(plan.moves.map((m) => m.quest))].sort()) {
		lines.push("", `### ${quest}`, "");
		for (const move of plan.moves.filter((m) => m.quest === quest)) {
			const where = move.reason === "working" ? "workspace" : "attachments";
			const size =
				move.files > 1
					? ` (${move.files} files, ${mib(move.bytes)})`
					: ` (${mib(move.bytes)})`;
			lines.push(`- ${move.reason} → ${where}: \`${move.rel}\`${size}`);
		}
	}
	lines.push("", "## Rewrites");
	for (const rewrite of plan.rewrites) {
		lines.push("", `### \`${relative(plan.questsRoot, rewrite.file)}\``, "");
		for (const change of rewrite.changes) {
			lines.push(`- \`${change.before}\` → \`${change.after}\``);
		}
	}
	return `${lines.join("\n")}\n`;
}

function mib(bytes: number): string {
	return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------
// Helpers and the command line
// ---------------------------------------------------------------------

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	return exists(path) && lstatSync(path).isFile();
}

function isDirectory(path: string): boolean {
	return exists(path) && lstatSync(path).isDirectory();
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function main(): void {
	const args = process.argv.slice(2);
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const questsRoot =
		option("--root") ?? join(dataDir("quest-workflow"), "quests");
	const workspaceRoot = option("--workspace") ?? defaultWorkspaceRoot();
	const decisions = option("--to-workspace");
	const toWorkspace = decisions
		? readFileSync(decisions, "utf8")
				.split("\n")
				.map((line) => line.replace(/#.*/, "").trim())
				.filter(Boolean)
		: [];

	const skip = (option("--skip") ?? "").split(",").filter(Boolean);

	const plan = planRecordMigration({
		questsRoot,
		workspaceRoot,
		toWorkspace,
		skip,
	});
	const manifest = renderManifest(plan);
	const manifestPath = option("--manifest");
	if (manifestPath) writeFileSync(manifestPath, manifest);
	console.log(manifest.split("\n## Review Bucket")[0].trimEnd());
	if (plan.collisions.length > 0) {
		console.log(`\nCollisions:\n${plan.collisions.join("\n")}`);
	}
	if (!args.includes("--apply")) {
		console.log("\n(dry run: nothing moved)");
		return;
	}
	if (plan.collisions.length > 0) {
		console.error("\nRefusing to migrate: resolve the collisions first.");
		process.exit(1);
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const journal =
		option("--journal") ??
		join(dirname(questsRoot), `migrate-quests-record-${stamp}.json`);
	applyRecordMigration(plan, { journal });
	console.log(`\nMigrated. The journal is ${journal}.`);
}

// Only run when invoked directly, so tests can import the planner
// without migrating the live store.
if (require.main === module) {
	main();
}
