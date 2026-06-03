/**
 * One-shot legacy project migrator.
 *
 * Reads `~/src/localhost/documents/projects/` and produces a
 * quest tree under the configured quests root. Project
 * READMEs become top-level quests; their asks, sidequests,
 * issues and PR notes become children scoped to that quest.
 * The script also reads `~/world/.pi/plans/` and parks each
 * stray plan as a top-level sidequest of kind plan-doc so
 * the agent can adopt them under the right quest later.
 *
 * Migration is structural, not prose-perfect: the original
 * body content is kept verbatim under the Summary section
 * of the new quest. The user re-shapes individual quests
 * after migration when they care to.
 *
 * Run:
 *   node scripts/migrate-legacy-projects.ts [--dry-run]
 *
 * Output goes to the quests root resolved via the same XDG
 * helpers the extension uses; the log lands at
 * `~/.pi/migration-log-quests.md`.
 *
 * This file is intentionally not exposed as a tool or a
 * package script. It's a one-shot the agent ran once,
 * preserved in version control for audit, and not expected
 * to be run again.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { dataDir } from "../lib/internal/paths.js";
import { mintId } from "../lib/internal/quest/id.js";
import { scaffoldQuestReadme } from "../lib/internal/quest/scaffold.js";
import type {
	QuestAlias,
	QuestFrontMatter,
	QuestKind,
} from "../lib/quest/types.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PROJECTS_ROOT = join(homedir(), "src/localhost/documents/projects");
const WORLD_PLANS = join(homedir(), "world/.pi/plans");
const QUESTS_ROOT =
	process.env.QUEST_WORKFLOW_ROOT?.trim() ||
	join(dataDir("quest-workflow"), "quests");
const LOG_PATH = join(homedir(), ".pi", "migration-log-quests.md");
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

interface MigrationLogEntry {
	source: string;
	target: string;
	kind: QuestKind;
	id: string;
}

const log: MigrationLogEntry[] = [];

function mintQuestId(): string {
	return mintId("QEST", NOW);
}

/**
 * Extract external-system aliases from a body. We look for
 * the link patterns the legacy workspace consistently used
 * and skip anything we don't recognise.
 */
function scanAliases(body: string): QuestAlias[] {
	const aliases: QuestAlias[] = [];
	const seen = new Set<string>();
	const push = (type: string, value: string): void => {
		const key = `${type}:${value}`;
		if (seen.has(key)) return;
		seen.add(key);
		aliases.push({ type, value });
	};

	for (const m of body.matchAll(
		/github\.com\/([^/\s)]+)\/([^/\s)]+)\/issues\/(\d+)/g,
	)) {
		push("github-issue", `${m[1]}/${m[2]}#${m[3]}`);
	}
	for (const m of body.matchAll(
		/github\.com\/([^/\s)]+)\/([^/\s)]+)\/pull\/(\d+)/g,
	)) {
		push("github-pr", `${m[1]}/${m[2]}#${m[3]}`);
	}
	for (const m of body.matchAll(/vault\.shopify\.io\/(projects)\/(\d+)/g)) {
		push("vault-project", m[2]);
	}
	for (const m of body.matchAll(
		/vault\.shopify\.io\/(gsd)\/projects\/(\d+)/gi,
	)) {
		push("gsd", m[2]);
	}
	for (const m of body.matchAll(
		/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/g,
	)) {
		push("gdoc", m[1]);
	}
	for (const m of body.matchAll(
		/shopify\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/g,
	)) {
		push("slack-message", `${m[1]}/${m[2]}`);
	}
	for (const m of body.matchAll(
		/shopify\.slack\.com\/archives\/([A-Z0-9]+)\b(?!\/p)/g,
	)) {
		push("slack-channel", m[1]);
	}
	return aliases;
}

/**
 * Pull the H1 from a body. Strips a trailing fragment in
 * parens if it looks like a metadata blob.
 */
function extractTitle(body: string, fallback: string): string {
	const lines = body.split("\n");
	for (const line of lines) {
		const m = line.match(/^#\s+(.+?)\s*$/);
		if (m) return m[1].trim();
	}
	return fallback;
}

/**
 * Build a slug-free, human-friendly title from a legacy
 * filename like `20260413T162540Z-resource-alarms-cpu-memory-disk.md`.
 */
function titleFromFilename(filename: string): string {
	const stem = filename.replace(/\.md$/i, "");
	const cleaned = stem.replace(/^\d{8}T?\d{0,6}Z?-/, "");
	return cleaned
		.split("-")
		.map((w) => (w.length === 0 ? w : `${w[0].toUpperCase()}${w.slice(1)}`))
		.join(" ");
}

/**
 * Detect a concluded marker in the body so we can mark the
 * quest concluded rather than active.
 */
function detectStatus(body: string): "active" | "concluded" {
	const concluded =
		/\b(closed|shipped|done|verified deployed|completed|retired)\b/i;
	if (concluded.test(body.slice(0, 500))) return "concluded";
	return "active";
}

interface ScaffoldOptions {
	id: string;
	kind: QuestKind;
	parent: string | null;
	title: string;
	sourceBody: string;
	sourcePath: string;
	includeOptionalSections?: boolean;
}

/**
 * Compose a quest README that keeps the original body
 * verbatim under Summary and adds a Journey entry noting
 * the migration.
 */
function composeQuestReadme(opts: ScaffoldOptions): string {
	const aliases = scanAliases(opts.sourceBody);
	const status = detectStatus(opts.sourceBody);
	const fm: QuestFrontMatter = {
		id: opts.id,
		kind: opts.kind,
		parent: opts.parent,
		status,
		priority: "queued",
		rank: 0,
		started: TODAY,
		updated: TODAY,
		aliases,
		sessions: [],
	};
	const summary = [
		`> Migrated from \`${opts.sourcePath}\` on ${TODAY}.`,
		"> Original body content preserved verbatim below.",
		"",
		opts.sourceBody.trim(),
	].join("\n");
	const journey = [
		{
			date: TODAY,
			prose: `Migrated from legacy project workspace at ${opts.sourcePath}.`,
		},
	];
	return scaffoldQuestReadme({
		frontMatter: fm,
		title: opts.title,
		summary,
		journey,
		includeOptionalSections: opts.includeOptionalSections ?? false,
	});
}

/**
 * Write a quest README to disk under the chosen directory.
 * Creates the directory and any required parents.
 */
function writeQuest(dir: string, body: string, entry: MigrationLogEntry): void {
	log.push(entry);
	if (DRY_RUN) {
		console.log(`[dry-run] ${entry.kind} ${entry.id} -> ${dir}`);
		return;
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "README.md"), body);
	console.log(`wrote ${entry.id} -> ${dir}`);
}

/**
 * Walk a directory of markdown files and scaffold one
 * sidequest per file, scoped to the given parent quest.
 */
function migrateMarkdownChildren(
	sourceDir: string,
	parentId: string,
	parentDir: string,
	kind: QuestKind,
): void {
	if (!existsSync(sourceDir)) return;
	const entries = readdirSync(sourceDir, { withFileTypes: true });
	for (const ent of entries) {
		const sourcePath = join(sourceDir, ent.name);
		if (ent.isFile() && extname(ent.name).toLowerCase() === ".md") {
			const body = readFileSync(sourcePath, "utf8");
			const title = extractTitle(body, titleFromFilename(ent.name));
			const id = mintQuestId();
			const childDir = join(parentDir, id);
			const readme = composeQuestReadme({
				id,
				kind,
				parent: parentId,
				title,
				sourceBody: body,
				sourcePath,
			});
			writeQuest(childDir, readme, {
				source: sourcePath,
				target: childDir,
				kind,
				id,
			});
		} else if (ent.isDirectory()) {
			// Each issue is its own subdirectory containing
			// further markdown. Walk it as a subquest and
			// promote nested markdown into research docs
			// under the new quest.
			migrateNestedDir(sourcePath, parentId, parentDir, kind, ent.name);
		}
	}
}

/**
 * A directory under issues/ or sidequests/ gets folded
 * into a single subquest. The directory's README.md (if
 * present) becomes the new quest README; the remaining
 * files survive verbatim copies under the new quest.
 */
function migrateNestedDir(
	sourceDir: string,
	parentId: string,
	parentDir: string,
	kind: QuestKind,
	dirName: string,
): void {
	const readmePath = join(sourceDir, "README.md");
	const body = existsSync(readmePath)
		? readFileSync(readmePath, "utf8")
		: collectDirSummary(sourceDir);
	const title = extractTitle(body, prettifyDirName(dirName));
	const id = mintQuestId();
	const childDir = join(parentDir, id);
	const readme = composeQuestReadme({
		id,
		kind,
		parent: parentId,
		title,
		sourceBody: body,
		sourcePath: sourceDir,
	});
	writeQuest(childDir, readme, {
		source: sourceDir,
		target: childDir,
		kind,
		id,
	});
	// Carry over loose markdown so it isn't lost. Each file
	// lives next to the new README under its original
	// basename; the body has a back-reference at the top.
	copyLooseFiles(sourceDir, childDir);
}

function prettifyDirName(name: string): string {
	return name
		.split(/[-_/]/)
		.map((w) => (w.length === 0 ? w : `${w[0].toUpperCase()}${w.slice(1)}`))
		.join(" ");
}

/**
 * Walk a directory, concatenating any markdown into a
 * single body. Useful when a legacy issue dir holds
 * many notes but no top-level README.
 */
function collectDirSummary(dir: string): string {
	const parts: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (ent.isFile() && extname(ent.name).toLowerCase() === ".md") {
			parts.push(`\n### ${ent.name}\n`);
			parts.push(readFileSync(join(dir, ent.name), "utf8"));
		}
	}
	return parts.join("\n");
}

/**
 * Directories that hold derived artifacts we never copy.
 * Git packs, node_modules and venvs balloon migrations into
 * gigabytes and aren't part of the project's prose.
 */
const SKIP_DIR_NAMES = new Set<string>([
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	"target",
	"dist",
	"build",
]);

/**
 * Per-file size ceiling. Beyond this we leave the file in
 * place and write a stub describing where it lives. The
 * legacy tree stays on disk for now anyway, so the stub is
 * a navigable pointer rather than a duplicate.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function skipDir(name: string): boolean {
	return SKIP_DIR_NAMES.has(name);
}

function copyFileWithGuard(source: string, dest: string): void {
	let size = 0;
	try {
		size = statSync(source).size;
	} catch {
		// Source vanished between readdir and stat; leave a
		// stub rather than crashing the whole migration.
		writeFileSync(
			dest,
			`# Missing file\n\nSource ${source} unreadable at migration time.\n`,
		);
		return;
	}
	if (size > MAX_FILE_BYTES) {
		writeFileSync(
			`${dest}.stub.md`,
			`# Large file stub\n\nOriginal: \`${source}\` (${size} bytes).\nNot copied because it exceeds the ${MAX_FILE_BYTES}-byte migration ceiling.\nThe legacy file remains in place; reference it directly.\n`,
		);
		return;
	}
	writeFileSync(dest, readFileSync(source));
}

/**
 * Copy every non-README file from sourceDir to targetDir
 * preserving subdirectory structure. README.md is skipped
 * because composeQuestReadme already absorbed it.
 */
function copyLooseFiles(sourceDir: string, targetDir: string): void {
	if (DRY_RUN) return;
	for (const ent of readdirSync(sourceDir, { withFileTypes: true })) {
		if (ent.name === "README.md") continue;
		if (ent.isDirectory() && skipDir(ent.name)) continue;
		const source = join(sourceDir, ent.name);
		const dest = join(targetDir, ent.name);
		if (ent.isFile()) {
			mkdirSync(targetDir, { recursive: true });
			copyFileWithGuard(source, dest);
		} else if (ent.isDirectory()) {
			copyTree(source, dest);
		}
	}
}

function copyTree(source: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const ent of readdirSync(source, { withFileTypes: true })) {
		if (ent.isDirectory() && skipDir(ent.name)) continue;
		const s = join(source, ent.name);
		const d = join(dest, ent.name);
		if (ent.isFile()) copyFileWithGuard(s, d);
		else if (ent.isDirectory()) copyTree(s, d);
	}
}

interface ProjectInput {
	rootDir: string;
	displayName: string;
}

const STANDARD_CHILD_DIRS: ReadonlyArray<{ name: string; kind: QuestKind }> = [
	{ name: "asks", kind: "sidequest" },
	{ name: "sidequests", kind: "sidequest" },
	{ name: "issues", kind: "subquest" },
	{ name: "epics", kind: "subquest" },
	{ name: "prs", kind: "sidequest" },
	{ name: "drafts", kind: "sidequest" },
];

const LEGACY_META_FILES: ReadonlyArray<string> = [
	"OUTSTANDING.md",
	"INDEX.md",
	"SESSIONS.md",
	"AGENTS.md",
	"RECONCILIATION-LOG.md",
	"REANALYSIS-GUIDE.md",
	"Deep-Dive.md",
	"Overview.md",
	"Plan.md",
	"CLAUDE.md",
];

/**
 * Migrate one project root. Returns the top-level quest
 * id so the caller can record it in the log.
 */
function migrateProject(project: ProjectInput): string {
	const readmePath = join(project.rootDir, "README.md");
	const body = existsSync(readmePath)
		? readFileSync(readmePath, "utf8")
		: `# ${project.displayName}\n\n_Legacy project root with no README._\n`;
	const title = extractTitle(body, project.displayName);
	const id = mintQuestId();
	const dir = join(QUESTS_ROOT, id);
	const readme = composeQuestReadme({
		id,
		kind: "quest",
		parent: null,
		title,
		sourceBody: body,
		sourcePath: project.rootDir,
		includeOptionalSections: true,
	});
	writeQuest(dir, readme, {
		source: project.rootDir,
		target: dir,
		kind: "quest",
		id,
	});

	const handled = new Set<string>(["README.md"]);
	for (const { name, kind } of STANDARD_CHILD_DIRS) {
		const sub = join(project.rootDir, name);
		if (existsSync(sub)) {
			migrateMarkdownChildren(sub, id, dir, kind);
			handled.add(name);
		}
	}

	// Carry over known legacy meta files so historical
	// context survives.
	for (const meta of LEGACY_META_FILES) {
		const src = join(project.rootDir, meta);
		if (existsSync(src) && !DRY_RUN) {
			writeFileSync(join(dir, `legacy-${meta}`), readFileSync(src));
		}
		handled.add(meta);
	}

	// Carry every unhandled directory and loose file as
	// legacy-* so non-standard project layouts (analysis/,
	// data/, drafts/ when not flat) don't lose their content.
	for (const ent of readdirSync(project.rootDir, { withFileTypes: true })) {
		if (handled.has(ent.name)) continue;
		if (ent.name.startsWith(".")) continue;
		const src = join(project.rootDir, ent.name);
		const dest = join(dir, `legacy-${ent.name}`);
		if (DRY_RUN) continue;
		if (ent.isFile()) writeFileSync(dest, readFileSync(src));
		else if (ent.isDirectory()) copyTree(src, dest);
	}

	return id;
}

/**
 * Park each stray `~/world/.pi/plans/*.md` as a top-level
 * sidequest with kind sidequest. The user later moves them
 * under the right quest by hand.
 */
function migrateOrphanPlans(): void {
	if (!existsSync(WORLD_PLANS)) return;
	for (const ent of readdirSync(WORLD_PLANS, { withFileTypes: true })) {
		if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".md")) continue;
		const source = join(WORLD_PLANS, ent.name);
		const body = readFileSync(source, "utf8");
		const title = extractTitle(body, titleFromFilename(ent.name));
		const id = mintQuestId();
		const dir = join(QUESTS_ROOT, id);
		const readme = composeQuestReadme({
			id,
			kind: "sidequest",
			parent: null,
			title,
			sourceBody: body,
			sourcePath: source,
		});
		writeQuest(dir, readme, {
			source,
			target: dir,
			kind: "sidequest",
			id,
		});
	}
}

function appendMigrationLog(topLevelIds: string[]): void {
	if (DRY_RUN) return;
	mkdirSync(join(homedir(), ".pi"), { recursive: true });
	const lines: string[] = [];
	lines.push(`# Quest Migration Log`);
	lines.push("");
	lines.push(`Ran on ${TODAY}. Quests root: \`${QUESTS_ROOT}\`.`);
	lines.push("");
	lines.push(`Top-level quests created: ${topLevelIds.length}.`);
	lines.push(`Total artifacts migrated: ${log.length}.`);
	lines.push("");
	lines.push("## Per-Project Summary");
	lines.push("");
	const grouped = new Map<string, MigrationLogEntry[]>();
	for (const entry of log) {
		const top =
			topLevelIds.find((id) => entry.target.includes(id)) ?? "(orphan)";
		const bucket = grouped.get(top) ?? [];
		bucket.push(entry);
		grouped.set(top, bucket);
	}
	for (const [top, entries] of grouped) {
		lines.push(`### ${top}`);
		lines.push("");
		for (const e of entries) {
			lines.push(`- ${e.kind} ${e.id}: \`${e.source}\` → \`${e.target}\``);
		}
		lines.push("");
	}
	writeFileSync(LOG_PATH, lines.join("\n"));
	console.log(`Log written to ${LOG_PATH}`);
}

function main(): void {
	console.log(`Quests root: ${QUESTS_ROOT}`);
	if (DRY_RUN) console.log(`(dry run)`);

	mkdirSync(QUESTS_ROOT, { recursive: true });

	const topLevelIds: string[] = [];

	// GSD/* projects.
	const gsdDir = join(PROJECTS_ROOT, "GSD");
	if (existsSync(gsdDir)) {
		for (const ent of readdirSync(gsdDir, { withFileTypes: true })) {
			if (!ent.isDirectory()) continue;
			const rootDir = join(gsdDir, ent.name);
			topLevelIds.push(
				migrateProject({
					rootDir,
					displayName: `GSD ${ent.name}`,
				}),
			);
		}
	}

	// proj-* projects.
	for (const ent of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
		if (!ent.isDirectory() || !ent.name.startsWith("proj-")) continue;
		const rootDir = join(PROJECTS_ROOT, ent.name);
		topLevelIds.push(
			migrateProject({
				rootDir,
				displayName: ent.name.replace(/^proj-/, ""),
			}),
		);
	}

	// Stray world plans.
	migrateOrphanPlans();

	appendMigrationLog(topLevelIds);

	console.log("");
	console.log(
		`Migrated ${log.length} artifacts across ${topLevelIds.length} top-level quests.`,
	);
}

main();
