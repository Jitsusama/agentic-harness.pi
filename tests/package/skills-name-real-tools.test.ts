/**
 * A skill may not name a tool or an action that does not exist.
 *
 * This gate exists because of a specific failure. A skill went on describing an
 * intermediate tool surface for days after it was replaced: `review view`, `review diff`,
 * `review_stack`, `review_thread reply`. None of those were ever wrong when written and
 * every one of them was wrong by the time somebody read it, because the tools were being
 * built at the time and the skill was not rebuilt with them.
 *
 * The cost was not a failed call. The same stale section also said the council was
 * unavailable for those changes, so the agent that read it did the council's work by hand,
 * with its own subagents and its own collation, three rounds running. A skill is read at
 * the moment somebody is deciding how to do a thing, which makes a stale one worse than a
 * missing one: it does not present as absent, it presents as guidance.
 *
 * Only tools this package registers are checked, since a skill may reference a tool that
 * some other package or the host provides, and this cannot know what those are.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Directories holding skills this package ships, plus its own project-local ones. */
const SKILL_ROOTS = [join(ROOT, "skills"), join(ROOT, ".pi", "skills")];

/** Where tools are registered, read so the gate cannot drift from the surface. */
const EXTENSIONS = join(ROOT, "extensions");

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
	}
	return found;
}

function filesUnder(dir: string, ending: string): string[] {
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
function registered(): Map<string, Set<string>> {
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

/**
 * Tool-shaped words a skill uses, as `tool` or `tool action`.
 *
 * Only underscored names and the bare families are recognized, so ordinary prose about
 * reviewing or working does not trip this.
 */
const MENTION =
	/\b((?:review|work|quest|tdd)(?:_[a-z]+)?)\s+([a-z][a-z-]{2,})\b/g;

/**
 * A skill's prose, with fenced blocks in a real language taken out.
 *
 * A SQL column called `review_comments` is not a tool. Unlabelled and `text` fences stay,
 * since that is where a skill puts a worked example of a tool call, which is exactly what
 * has to be checked.
 */
function prose(text: string): string {
	return text.replace(
		/```(?:sql|ts|typescript|js|javascript|json|go|python|bash|sh|yaml)\n[\s\S]*?```/g,
		"",
	);
}

describe("a skill names only tools that exist", () => {
	const surface = registered();
	const tools = new Set(surface.keys());

	it("registers the tool families this gate knows about", () => {
		// If this fails the gate is reading the wrong place, and every other
		// assertion here would pass by finding nothing.
		expect(tools).toContain("review_see");
		expect(tools).toContain("review_ask");
		expect(tools).toContain("work");
		expect(surface.get("review_see")).toContain("threads");
	});

	it("never writes a tool with an action it does not take", () => {
		// Only inside inline backticks, which is how a skill writes a call.
		// `review` is also an English word, and prose about reviewing comments
		// must not read as an invented action.
		const wrong: string[] = [];
		for (const root of SKILL_ROOTS) {
			for (const file of filesUnder(root, ".md")) {
				const text = prose(readFileSync(file, "utf8"));
				for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
					const [named, action] = span.trim().split(/\s+/);
					if (named === undefined || action === undefined) continue;
					const actions = surface.get(named);
					if (actions === undefined) continue;
					if (!/^[a-z][a-z-]*$/.test(action)) continue;
					if (!actions.has(action)) {
						wrong.push(`${file.slice(ROOT.length + 1)}: ${named} ${action}`);
					}
				}
			}
		}
		expect([...new Set(wrong)]).toEqual([]);
	});

	it("never names an underscored tool this package does not register", () => {
		const wrong: string[] = [];
		for (const root of SKILL_ROOTS) {
			for (const file of filesUnder(root, ".md")) {
				const text = prose(readFileSync(file, "utf8"));
				for (const [, named] of text.matchAll(
					/\b((?:review|work|quest|tdd)_[a-z]+)\b/g,
				)) {
					// A family prefix that is registered is fine; anything else
					// underscored is a tool that was renamed or never existed.
					if (!tools.has(named)) {
						wrong.push(`${file.slice(ROOT.length + 1)}: ${named}`);
					}
				}
			}
		}
		expect([...new Set(wrong)]).toEqual([]);
	});
});
