/**
 * Every folder in the package says what goes in it.
 *
 * A reader, person or model, finds a file by walking folders by their names,
 * and a folder that says nothing about itself sends them through its files one
 * by one to learn what it is for, and leaves the next person to add something
 * to it guessing whether it belongs. So every folder carries a note: a
 * README.md, an AGENTS.md or a SKILL.md, or an entry file whose first line is
 * a comment (its index.ts, a .ts file inside it of its own name, or one beside
 * it of its name, as `lib/mesh.ts` would be for `lib/mesh/`). A top-level
 * folder may instead be described in AGENTS.md's Structure, and a folder in a
 * skill named in its SKILL.md, since a skill's reader reads that first.
 *
 * Tests mirror the source: `tests/extensions/<name>/` holds the tests of
 * `extensions/<name>/`, `tests/lib/<path>/` those of `lib/<path>/`, and
 * `tests/core/<path>/` those of `lib/core/<path>/`, so such a folder says what
 * it holds when its source folder does. A folder of tests with no source
 * folder of its name, such as a support folder, says so itself.
 *
 * A folder still waiting for its note is listed, with why, and the list fails
 * once one has its note or is gone, so it only shrinks. A folder of tests
 * waits with the source folder it mirrors.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** The notes a folder may carry in a file of their own. */
const NOTES = ["README.md", "AGENTS.md", "SKILL.md"];

/** A first line that is a comment, in TypeScript or a shell script. */
const COMMENT = /^(\/\*\*?|\/\/|#)/;

/** Where each folder of tests finds the source it mirrors. */
const MIRRORS: [string, string][] = [
	["tests/core/", "lib/core/"],
	["tests/lib/", "lib/"],
	["tests/", ""],
];

/**
 * Folders waiting for their note, each with why. Areas being rewritten by
 * their owner keep their shape until the rewrite lands.
 */
const HELD =
	"85PKB2's PLAN-20261025-LES0F4 rewrites this area and owns its shape until it lands";
const FOLDED =
	"folded in from agentic-harness.core (#749, #753, #767, #769, #770); notes come as the fold settles";
const OWN = "the harness's own; notes come in batches, a folder a line";

const WAITING: Record<string, string> = {
	"extensions/quest-workflow/verbs": HELD,
	"lib/internal/quest": HELD,
	"lib/mesh": HELD,
	"lib/core/internal": FOLDED,
	"lib/core/internal/github": FOLDED,
	"lib/core/internal/guardian": FOLDED,
	"lib/core/internal/lsp": FOLDED,
	"lib/core/internal/notes": FOLDED,
	"lib/core/internal/quest": FOLDED,
	"lib/core/internal/review": FOLDED,
	"lib/core/internal/sqlite": FOLDED,
	"lib/core/internal/terminal": FOLDED,
	"lib/core/internal/terminal/drivers": FOLDED,
	"lib/core/internal/tree": FOLDED,
	"lib/core/internal/tree/providers": FOLDED,
	"lib/core/lsp/standalone": FOLDED,
	"lib/core/notes": FOLDED,
	"lib/core/notes/verbs": FOLDED,
	"lib/core/quest/verbs": FOLDED,
	"lib/core/review/ask": FOLDED,
	"lib/core/review/draft": FOLDED,
	"lib/core/review/providers": FOLDED,
	"lib/core/sections": FOLDED,
	"lib/core/title": FOLDED,
	"lib/core/work/providers": FOLDED,
	"extensions/review-integration/personas": OWN,
	"lib/classifier": OWN,
	"lib/compaction/selection": OWN,
	"lib/gate": OWN,
	"lib/internal/away": OWN,
	"lib/internal/config": OWN,
	"lib/internal/gate": OWN,
	"lib/internal/github": OWN,
	"lib/internal/guardian": OWN,
	"lib/internal/install": OWN,
	"lib/internal/people": OWN,
	"lib/internal/priority": OWN,
	"lib/internal/recall": OWN,
	"lib/internal/refs": OWN,
	"lib/internal/registry": OWN,
	"lib/internal/reload": OWN,
	"lib/internal/session": OWN,
	"lib/internal/shell": OWN,
	"lib/internal/stray": OWN,
	"lib/internal/verification": OWN,
	"lib/mcp/frontend": OWN,
	"lib/mcp/render": OWN,
	"lib/mcp/surface": OWN,
	"lib/prose": OWN,
	"lib/subagent/runpi": OWN,
};

function foldersUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (!statSync(path).isDirectory()) continue;
		found.push(relative(ROOT, path), ...foldersUnder(path));
	}
	return found;
}

function opensWithAComment(file: string): boolean {
	if (!existsSync(file) || !statSync(file).isFile()) return false;
	const first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
	return COMMENT.test(first);
}

/** The top-level folders AGENTS.md's Structure describes, by their names. */
const STRUCTURED = new Set(
	[
		...(readFileSync(join(ROOT, "AGENTS.md"), "utf8")
			.split("\n## Structure\n")[1]
			?.split("\n## ")[0]
			.matchAll(/^- `([a-z.-]+)\/`:/gm) ?? []),
	].map((match) => match[1]),
);

/** Whether a folder carries a note of its own. */
function notes(folder: string): boolean {
	const path = join(ROOT, folder);
	const name = basename(folder);
	if (NOTES.some((note) => existsSync(join(path, note)))) return true;
	if (STRUCTURED.has(folder)) return true;
	const skill = join(dirname(path), "SKILL.md");
	if (existsSync(skill) && readFileSync(skill, "utf8").includes(`${name}/`))
		return true;
	return [
		join(path, "index.ts"),
		join(path, `${name}.ts`),
		join(dirname(path), `${name}.ts`),
	].some(opensWithAComment);
}

/** The source folder a folder of tests mirrors, when there is one. */
function mirrored(folder: string): string | undefined {
	for (const [tests, source] of MIRRORS) {
		if (!folder.startsWith(tests)) continue;
		const path = source + folder.slice(tests.length);
		if (existsSync(join(ROOT, path))) return path;
	}
	return undefined;
}

/** Whether a folder says what it holds, by its own note or its source's. */
function says(folder: string): boolean {
	if (notes(folder)) return true;
	const source = mirrored(folder);
	return source !== undefined && says(source);
}

/** Whether a folder is waiting for its note, or mirrors one that is. */
function waits(folder: string): boolean {
	if (folder in WAITING) return true;
	const source = mirrored(folder);
	return source !== undefined && waits(source);
}

describe("the package's folders", () => {
	const folders = foldersUnder(ROOT);

	it("each say what they hold", () => {
		const silent = folders.filter((f) => !says(f) && !waits(f));
		expect(
			silent,
			`these folders don't say what they hold: give each a README.md, or an index.ts or a file of its name whose first line is a comment saying what goes in it:\n${silent.join("\n")}`,
		).toEqual([]);
	});

	it("keep no folder waiting that has its note or is gone", () => {
		const spoken = Object.keys(WAITING).filter(
			(f) => !existsSync(join(ROOT, f)) || says(f),
		);
		expect(
			spoken,
			`waiting for a note they now have, or gone; take them out of WAITING:\n${spoken.join("\n")}`,
		).toEqual([]);
	});
});
