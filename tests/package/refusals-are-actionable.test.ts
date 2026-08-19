/**
 * A refusal has to be actionable on its own.
 *
 * Every block these interceptors return goes to an agent that has to fix the command
 * and retry. For years ten of them ended by naming a skill to go and read, which is
 * only useful while that skill happens to be loaded, and one of them named a skill
 * whose worked example the next check blocked. The existing tests never caught it
 * because they assert the problem half of each message and never the fix half.
 *
 * This is the gate on the gates. It does not judge prose; it checks the one property
 * that decayed, which is whether the message hands the reader onward instead of
 * telling them what to do.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Files whose whole job is producing block messages.
 *
 * Deliberately a list rather than a glob over `extensions`. A tool description may
 * legitimately point at a methodology skill, because reading it is the point there
 * and nothing is being refused; `tdd-workflow` and `browser-integration` both do, and
 * should. What must not defer is a message returned at the moment an action was
 * stopped.
 */
const BLOCK_SOURCES = [
	// The detection logic (and its block messages) now lives in
	// agentic-harness.core, pinned by pnpm-lock.yaml rather than
	// tracked in this repo; read it from the installed dependency.
	"node_modules/@jitsusama/agentic-harness.core/dist/github-cli/index.js",
	"node_modules/@jitsusama/agentic-harness.core/dist/git-cli/index.js",
];

/** Telling the reader to go and read something, in the shapes people write it. */
const DEFERS = /\b(?:read|see|consult|refer to)\s+the\s+[a-z-]+\s+skill/i;

describe("a block message", () => {
	for (const path of BLOCK_SOURCES) {
		it(`does not send the reader to a skill in ${path}`, () => {
			const source = readFileSync(join(ROOT, path), "utf8");
			// Comments explain the history and are allowed to name skills; only the
			// strings the agent receives are held to this.
			const strings = source
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("*"))
				.filter((line) => !line.trimStart().startsWith("//"))
				.join("\n");

			expect(strings).not.toMatch(DEFERS);
		});
	}

	it("shows the gh body form literally, since naming the flag is not enough", () => {
		// An agent told to use --body-file with a heredoc can still reach for a file
		// path or an unquoted delimiter, both of which are separately blocked. Three
		// blocks in a row for one mistake is a message that did not do its job.
		const source = readFileSync(join(ROOT, BLOCK_SOURCES[0]), "utf8");

		expect(source).toContain("--body-file - <<'EOF'");
	});

	it("shows the git commit form literally, for the same reason", () => {
		const source = readFileSync(join(ROOT, BLOCK_SOURCES[1]), "utf8");

		expect(source).toContain("git commit -F- <<'EOF'");
	});
});
