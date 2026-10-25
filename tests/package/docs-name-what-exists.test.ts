/**
 * The package's markdown may not name a file or folder that is not there.
 *
 * Code moves, and the prose about it stays where it was. When much of `lib/`
 * moved to agentic-harness.core, the guides and READMEs went on naming
 * `lib/web`, `lib/lsp`, `lib/slack/detect.ts` and thirty more paths that were
 * gone, and the convention matrix, which AGENTS.md tells every contributor to
 * keep, cited gates by files that no longer existed. A guide is read at the
 * moment somebody decides where to look, so a stale path sends the work the
 * wrong way rather than presenting as missing.
 *
 * Two kinds of mention are checked: a relative link, in any markdown file,
 * and a path in backticks that starts at one of this repository's top-level
 * folders, in the files that describe this repository (skills are left out of
 * that half, since they describe any repository). A path written after "core"
 * or "core's" is agentic-harness.core's, and is not looked for here. Code
 * blocks and inline code are examples, so links inside them are not followed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Folders that hold no markdown of this repository's own. */
const SKIPPED = new Set([".git", "node_modules", "dist", ".worktrees"]);

/** The top-level folders a backticked path may start from. */
const PATH =
	/`((?:bin|docs|extensions|lib|scripts|skills|tests)\/[^`\s*<>{}]+?)(?::\d+(?:-\d+)?)?`/g;

/** A relative link's target, before any anchor. */
const LINK = /\]\((?!https?:|mailto:|#)([^)\s#]+)(?:#[^)]*)?\)/g;

/** A path written as agentic-harness.core's, which this repository doesn't hold. */
const CORES = /core(?:'s)? $/i;

/**
 * Mentions that stay, each with why. A file being rewritten by its owner keeps
 * its words until the rewrite lands.
 */
const EXEMPT: Record<string, string> = {
	"extensions/quest-workflow/README.md lib/quest/pr-bridge.ts":
		"85PKB2's PLAN-20261025-LES0F4 rewrites quest-workflow and owns its words until it lands",
};

function markdownUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...markdownUnder(path));
		else if (entry.endsWith(".md")) found.push(path);
	}
	return found;
}

/** The text with its fenced code blocks blanked, so their lines are not read. */
function withoutFences(text: string): string {
	return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

/** Every path a markdown file names that is not there, as `file: path`. */
function missingIn(file: string): string[] {
	const name = relative(ROOT, file);
	const text = withoutFences(readFileSync(file, "utf8"));
	const missing: string[] = [];
	const describesThisRepository =
		!name.startsWith("skills/") && !name.startsWith(".pi/skills/");
	if (describesThisRepository) {
		for (const match of text.matchAll(PATH)) {
			const path = match[1].replace(/\/$/, "");
			const before = text.slice(Math.max(0, match.index - 8), match.index);
			if (CORES.test(before) || `${name} ${path}` in EXEMPT) continue;
			if (!existsSync(join(ROOT, path))) missing.push(`${name}: \`${path}\``);
		}
	}
	const prose = text.replace(/`[^`\n]*`/g, "");
	for (const [, target] of prose.matchAll(LINK)) {
		if (!existsSync(join(dirname(file), target)))
			missing.push(`${name}: (${target})`);
	}
	return missing;
}

describe("the package's markdown", () => {
	it("names only files and folders that are there", () => {
		const missing = markdownUnder(ROOT).flatMap(missingIn);
		expect(missing, `named but not there:\n${missing.join("\n")}`).toEqual([]);
	});

	it("keeps no exemption for a mention that has gone", () => {
		const stale = Object.keys(EXEMPT).filter((key) => {
			const [file, path] = key.split(" ");
			return !readFileSync(join(ROOT, file), "utf8").includes(path);
		});
		expect(stale, `exempt but no longer said:\n${stale.join("\n")}`).toEqual(
			[],
		);
	});
});
