/**
 * Finds and reads plan files that are relevant to the current
 * PR, using the same plan directory that plan-workflow uses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PLAN_DIR } from "./state.js";

/**
 * Load the plan directory from project settings.
 * Mirrors plan-workflow's loadPlanDir to share configuration.
 */
export function loadPlanDir(cwd: string): string {
	try {
		const settingsPath = path.join(cwd, ".pi", "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return settings.planDir ?? DEFAULT_PLAN_DIR;
	} catch {
		/* Settings file missing or malformed: use default */
		return DEFAULT_PLAN_DIR;
	}
}

/**
 * Search the plan directory for files matching a keyword
 * (e.g. an issue number or feature name). Returns concatenated
 * content of matching files, or null if nothing found.
 */
export function findPlanContext(cwd: string, keyword: string): string | null {
	const planDir = loadPlanDir(cwd);
	const absoluteDir = path.resolve(cwd, planDir);

	if (!isDirectory(absoluteDir)) return null;

	const matchingFiles = findFilesMatching(absoluteDir, keyword);
	if (matchingFiles.length === 0) return null;

	const parts: string[] = [];
	for (const filePath of matchingFiles) {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const relativePath = path.relative(cwd, filePath);
			parts.push(`--- ${relativePath} ---`);
			parts.push(content);
			parts.push("");
		} catch {
			/* File not readable: skip */
		}
	}

	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Recursively find files whose name or path contains the keyword.
 * Case-insensitive matching.
 */
function findFilesMatching(dir: string, keyword: string): string[] {
	const results: string[] = [];
	const lowerKeyword = keyword.toLowerCase();

	function walk(currentDir: string) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			/* Directory not readable: skip */
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				// We recurse into subdirectories.
				if (entry.name.toLowerCase().includes(lowerKeyword)) {
					// The directory name matches, so we include all files in it.
					collectAllFiles(fullPath, results);
				} else {
					walk(fullPath);
				}
			} else if (entry.isFile()) {
				if (entry.name.toLowerCase().includes(lowerKeyword)) {
					results.push(fullPath);
				}
			}
		}
	}

	walk(dir);
	return results;
}

/** Collect all files in a directory tree. */
function collectAllFiles(dir: string, results: string[]) {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		/* Directory not readable: skip */
		return;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectAllFiles(fullPath, results);
		} else if (entry.isFile()) {
			results.push(fullPath);
		}
	}
}

/** Check if a path is an existing directory. */
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
