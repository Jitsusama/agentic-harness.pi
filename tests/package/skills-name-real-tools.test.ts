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

/** Every tool name this package registers. */
function registeredTools(): Set<string> {
	const names = new Set<string>();
	for (const file of filesUnder(EXTENSIONS, ".ts")) {
		const source = readFileSync(file, "utf8");
		for (const [, name] of source.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) {
			if (source.includes("registerTool")) names.add(name);
		}
	}
	return names;
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
	const tools = registeredTools();

	it("registers the tool families this gate knows about", () => {
		// If this fails the gate is reading the wrong place, and every other
		// assertion here would pass by finding nothing.
		expect(tools).toContain("review_see");
		expect(tools).toContain("review_ask");
		expect(tools).toContain("work");
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
