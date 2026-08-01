import { describe, expect, it } from "vitest";
import {
	parseQuestFrontMatter,
	serializeReadable,
} from "../../../../lib/internal/quest/frontmatter";

/**
 * A quest README that the strict parser accepts, used as the starting
 * point every case here mutates one field of.
 */
function readable() {
	const text = [
		"---",
		"id: QEST-20260101-AAAAAA",
		"kind: quest",
		"parent: null",
		"status: active",
		"priority: active",
		"rank: 1",
		"started: 2026-01-01",
		"updated: 2026-01-01",
		"---",
		"# A quest",
		"",
		"Body stays put.",
	].join("\n");
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) throw new Error("fixture is not readable");
	return parsed;
}

describe("serializing frontmatter that has to survive a read", () => {
	it("returns the text when the parser can read the result back", () => {
		const { frontMatter, body } = readable();

		const outcome = serializeReadable(frontMatter, body);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(parseQuestFrontMatter(outcome.text)?.frontMatter.id).toBe(
			"QEST-20260101-AAAAAA",
		);
		expect(outcome.text).toContain("Body stays put.");
	});

	it("refuses a value the strict parser will not read back", () => {
		// The whole point of the check. A writer that serializes an
		// out-of-vocabulary value and writes it anyway produces a quest
		// discovery cannot see, and nothing at write time says so.
		// Status is the cheapest field to make illegal.
		const { frontMatter, body } = readable();

		const outcome = serializeReadable(
			{ ...frontMatter, status: "nonsense" as never },
			body,
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toMatch(/read back/i);
	});

	it("names the quest in the refusal, since a sweep hits many", () => {
		const { frontMatter, body } = readable();

		const outcome = serializeReadable(
			{ ...frontMatter, status: "nonsense" as never },
			body,
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("QEST-20260101-AAAAAA");
	});
});
