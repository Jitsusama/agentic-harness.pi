/**
 * Plan discovery: finding the plan documents under a plan home so
 * `/plan list` can show them. The directory walk stays cheap by
 * pruning dot and vendor directories, probing only file heads,
 * and reading a full document only once it looks like a plan.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractTitle, parsePlan, progress } from "./plan-doc.js";

/** Bytes of each file we read for the cheap plan probe. */
const HEAD_BYTES = 1024;
/** How deep the walk recurses below the plan root. */
const MAX_DEPTH = 8;

/** A single row in the plan list. */
export interface PlanSummary {
	id: string;
	title: string | null;
	stage: string;
	updated: string;
	done: number;
	total: number;
	fileName: string;
}

/**
 * Build a list row from a plan file, or null when it is not a
 * plan. A plan must parse and carry a `PLAN-` id; that gate keeps
 * other front-mattered markdown out of the list.
 */
export function summarizePlan(
	fileName: string,
	text: string,
): PlanSummary | null {
	const doc = parsePlan(text);
	if (!doc || !doc.frontMatter.id.startsWith("PLAN-")) return null;
	const { done, total } = progress(doc.body);
	return {
		id: doc.frontMatter.id,
		title: extractTitle(doc.body),
		stage: doc.frontMatter.stage,
		updated: doc.frontMatter.updated,
		done,
		total,
		fileName,
	};
}

/**
 * Order plan rows for display: newest `updated` first, breaking
 * ties by id descending. Returns a new array; the input is left
 * untouched.
 */
export function sortPlans(summaries: PlanSummary[]): PlanSummary[] {
	return [...summaries].sort((a, b) => {
		if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
		return a.id < b.id ? 1 : -1;
	});
}

/** Read at most the first kilobyte of a file, for the cheap probe. */
async function readHead(file: string): Promise<string> {
	const handle = await fs.promises.open(file, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		return buffer.toString("utf-8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function summarizeFile(
	file: string,
	fileName: string,
): Promise<PlanSummary | null> {
	try {
		if (!isPlanHead(await readHead(file))) return null;
		return summarizePlan(fileName, await fs.promises.readFile(file, "utf-8"));
	} catch {
		// File vanished or is unreadable between listing and reading;
		// it simply does not appear in the list.
		return null;
	}
}

async function walk(
	dir: string,
	depth: number,
	out: PlanSummary[],
): Promise<void> {
	if (depth > MAX_DEPTH) return;
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		// Unreadable directory (permissions, race): skip it quietly.
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (shouldDescend(entry.name)) await walk(full, depth + 1, out);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const summary = await summarizeFile(full, entry.name);
			if (summary) out.push(summary);
		}
	}
}

/**
 * Find every plan document at or below a root directory, sorted
 * newest first. The walk prunes dot and heavy directories, caps
 * its depth, and reads a file in full only after its head probes
 * as a plan, so it stays cheap even over a large documents tree.
 */
export async function findPlans(rootDir: string): Promise<PlanSummary[]> {
	const out: PlanSummary[] = [];
	await walk(rootDir, 0, out);
	return sortPlans(out);
}

/** A front-matter line declaring a plan id. */
const PLAN_ID_LINE = /^\s*id:\s*PLAN-/;

/**
 * True only when a file head looks like a plan document: it opens
 * with a `---` fence and carries an `id: PLAN-` line before the
 * closing fence. Reading only the head keeps the probe cheap; a
 * plan's front-matter is tiny, so the closing fence is always
 * near the top.
 */
export function isPlanHead(head: string): boolean {
	const lines = head.split("\n");
	if (lines[0]?.trim() !== "---") return false;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") return false;
		if (PLAN_ID_LINE.test(lines[i])) return true;
	}
	return false;
}

/** Well-known heavy directories the plan walker never descends into. */
const HEAVY_DIRS = new Set(["node_modules", "vendor", "bower_components"]);

/**
 * Whether the plan walker should recurse into a child directory.
 * Dot directories and well-known heavy directories are pruned;
 * everything else is fair game.
 */
export function shouldDescend(dirName: string): boolean {
	if (dirName.startsWith(".")) return false;
	return !HEAVY_DIRS.has(dirName);
}
