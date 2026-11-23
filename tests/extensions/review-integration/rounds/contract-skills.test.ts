import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contractSkills } from "../../../../extensions/review-integration/tools/ask-reviewer.ts";

/** Every round a prompt tells a participant to read a contract for. */
const ROUNDS = ["council", "judge", "critique", "audit", "stack"] as const;

const root = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

/**
 * The path `ask-reviewer.ts` builds, spelled the same way.
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

	it.each(ROUNDS)(
		"loads every contract skill its contract points at for %s",
		async (round) => {
			// A reviewer starts with no skills but its contract's, so a link
			// to another contract reaches nothing unless that one is loaded:
			// judges told every field is as the council's says answered in a
			// shape of their own, with no label or location (23 November).
			const loaded = contractSkills(round);
			const named = new Set<string>();
			for (const path of loaded) {
				const text = await readFile(path, "utf8");
				for (const [, other] of text.matchAll(
					/\(\.\.\/(review-\w+-format)\)/g,
				)) {
					if (other !== undefined) named.add(other);
				}
			}

			for (const other of named) {
				expect(
					loaded,
					`${round}'s contract points at ${other}, so its round loads it`,
				).toContain(join(root, "skills", other, "SKILL.md"));
			}
			expect(loaded, `${round}'s round loads its own contract`).toContain(
				contractPath(round),
			);
		},
	);

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
