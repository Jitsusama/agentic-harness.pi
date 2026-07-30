import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every round a prompt tells a participant to read a contract for. */
const ROUNDS = ["council", "judge", "critique", "audit", "stack"] as const;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The path `ask.ts` builds, spelled the same way.
 *
 * Kept as a literal rather than imported, because importing the tool
 * module would drag pi's extension API into a test that only wants to
 * know whether a file is on disk.
 */
const contractPath = (round: string) =>
	join(root, "skills", `review-${round}-format`, "SKILL.md");

describe("the output contract every round attaches", () => {
	it.each(ROUNDS)("has a skill on disk for %s", async (round) => {
		// A missing file is silent at runtime: the subagent starts, the
		// prompt tells it to follow a contract it was never given, and
		// the answer comes back unparseable for no stated reason.
		const text = await readFile(contractPath(round), "utf8");

		expect(text.length).toBeGreaterThan(0);
	});

	it.each(ROUNDS)("names itself in its frontmatter for %s", async (round) => {
		const text = await readFile(contractPath(round), "utf8");

		expect(text).toContain(`name: review-${round}-format`);
	});

	it.each(ROUNDS)("has a README beside it for %s", async (round) => {
		const text = await readFile(
			join(root, "skills", `review-${round}-format`, "README.md"),
			"utf8",
		);

		expect(text).toContain(`review-${round}-format`);
	});

	it("promises no verify tool, since nothing attaches one", async () => {
		// Telling a reviewer to call a tool it cannot see spends a turn on
		// a failed lookup and teaches it to distrust the rest of what it
		// was told.
		for (const round of ROUNDS) {
			const text = await readFile(contractPath(round), "utf8");
			expect(text, round).not.toMatch(/verify_output|verify tool/);
		}
	});
});
