/**
 * The tools this package registers and the actions each takes, read from their source so
 * the gates that check the surface cannot drift from it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");

/** Where tools are registered. */
const EXTENSIONS = join(ROOT, "extensions");

/** Every file under a directory whose name ends as given, or none if it is missing. */
export function filesUnder(dir: string, ending: string): string[] {
	let found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// A root that does not exist is not a failure: `.pi/skills` is optional.
		return [];
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found = found.concat(filesUnder(path, ending));
		} else if (entry.endsWith(ending)) {
			found.push(path);
		}
	}
	return found;
}

/**
 * Actions a tool keeps in a sibling module rather than inline.
 *
 * Only the tool's own directory is read, so one tool's verbs cannot vouch for another's.
 */
function sharedActionLists(toolFile: string): string[] {
	const dir = toolFile.slice(0, toolFile.lastIndexOf("/"));
	const found: string[] = [];
	for (const sibling of filesUnder(dir, "actions.ts")) {
		const source = readFileSync(sibling, "utf8");
		for (const [, act] of source.matchAll(/"([a-z][a-zA-Z-]*)"/g)) {
			found.push(act);
		}
		// A re-export barrel points its real action list at an installed
		// package instead of holding it inline; follow the re-export into
		// the compiled dist artifact (per that package's "exports" map,
		// every subpath resolves under "dist/") or the gate reads an
		// empty shell.
		const coreImport = /from "@jitsusama\/agentic-harness\.core\/([^"]+)"/.exec(
			source,
		);
		if (coreImport) {
			try {
				const distSource = readFileSync(
					join(
						ROOT,
						"node_modules",
						"@jitsusama",
						"agentic-harness.core",
						"dist",
						`${coreImport[1]}.js`,
					),
					"utf8",
				);
				for (const [, act] of distSource.matchAll(/"([a-z][a-zA-Z-]*)"/g)) {
					found.push(act);
				}
			} catch {
				// Missing dist artifact is caught by the do-not-lose guards.
			}
		}
	}
	return found;
}

/**
 * Every tool this package registers, against the actions it accepts.
 *
 * Actions are gathered as every string literal in the file rather than only the ones on
 * the action property, which is deliberately loose: a name that appears anywhere in the
 * tool's own source is a name that tool knows about, and the question here is only
 * whether a skill invented one.
 *
 * Two spellings, because the tools disagree. Most declare their actions inline as typebox
 * literals; quest keeps a shared list in its own module and passes it to a string enum,
 * so that list is read too. Missing the second spelling made every real quest verb look
 * invented, which is the failure mode a loose gate has: it does not go quiet, it goes off
 * constantly and gets deleted.
 */
export function registered(): Map<string, Set<string>> {
	const tools = new Map<string, Set<string>>();
	for (const file of filesUnder(EXTENSIONS, ".ts")) {
		const source = readFileSync(file, "utf8");
		if (!source.includes("registerTool")) continue;
		for (const [, name] of source.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) {
			const actions = tools.get(name) ?? new Set<string>(tools.get(name) ?? []);
			for (const [, act] of source.matchAll(
				/Type\.Literal\("([a-z][a-zA-Z-]*)"\)/g,
			)) {
				actions.add(act);
			}
			for (const shared of sharedActionLists(file)) actions.add(shared);
			tools.set(name, actions);
		}
	}
	return tools;
}
