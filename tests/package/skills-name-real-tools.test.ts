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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, ROOT, registered } from "./registered-tools.ts";

/** Directories holding skills this package ships, plus its own project-local ones. */
const SKILL_ROOTS = [join(ROOT, "skills"), join(ROOT, ".pi", "skills")];

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
