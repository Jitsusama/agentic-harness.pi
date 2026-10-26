/**
 * What a repo mapping is allowed to say.
 *
 * A mapping used to pin a provider and nothing else, so the reader
 * only had to decide whether it named one. It can now also say where
 * a repo is checked out, which is the one fact nothing else on the
 * machine can supply, and that turns two lenient readings into real
 * faults: a match is a substring test, so an empty one claims every
 * repo there is, and a path is handed to git, so a relative one is
 * resolved against whatever directory the session happens to be in.
 *
 * Both fail a long way from here and read as "that is not a checkout
 * of this repo", which is a true sentence about the wrong problem.
 */
import { describe, expect, it } from "vitest";
import { parseReviewSection } from "../../../lib/core/review/config.ts";

/** Parse a `review` section holding just these repo mappings. */
function read(repos: unknown) {
	return parseReviewSection({ repos });
}

describe("reading a repo mapping", () => {
	it("keeps a mapping that only says where the repo lives", () => {
		// A mapping with no providers used to be an entry that did
		// nothing, so it was refused. Saying where a repo is checked out
		// is a whole job on its own.
		const { config, problems } = read([
			{ match: "elsewhere/other", path: "/src/elsewhere/other" },
		]);

		expect(problems).toEqual([]);
		expect(config.repos).toEqual([
			{ match: "elsewhere/other", providers: [], path: "/src/elsewhere/other" },
		]);
	});

	it("refuses a match that would claim every repo", () => {
		// Matching is a substring test and every string contains the
		// empty one, so this mapping answers for every repo on the
		// machine. With a path on it, that means every round everywhere
		// reads one directory.
		const { config, problems } = read([
			{ match: "   ", path: "/src/somewhere" },
		]);

		expect(config.repos).toBeUndefined();
		expect(problems).toEqual([expect.stringContaining("non-empty")]);
	});

	it("refuses a path that is not absolute", () => {
		// Resolved against the session's own directory, which is the
		// thing this field exists to stop mattering.
		const { config, problems } = read([
			{ match: "elsewhere/other", path: "src/elsewhere" },
		]);

		expect(config.repos).toBeUndefined();
		expect(problems).toEqual([expect.stringContaining("absolute")]);
	});

	it("says what a leading tilde is, since the shell hides it", () => {
		// `~` is the shell's expansion, not one node performs, so this
		// names a directory called `~` under the current one. Worth its
		// own sentence because the path looks right to whoever wrote it.
		const { problems } = read([
			{ match: "elsewhere/other", path: "~/src/elsewhere" },
		]);

		expect(problems).toEqual([expect.stringContaining("shell")]);
	});

	it("still refuses a mapping that says nothing at all", () => {
		const { config, problems } = read([{ match: "elsewhere/other" }]);

		expect(config.repos).toBeUndefined();
		expect(problems).toEqual([expect.stringContaining("provider")]);
	});

	it("has nothing to say about an absent section", () => {
		expect(parseReviewSection(undefined)).toEqual({ config: {}, problems: [] });
	});

	it("refuses a section that is not an object", () => {
		const { config, problems } = parseReviewSection("nope");
		expect(config).toEqual({});
		expect(problems).toEqual([expect.stringContaining("object")]);
	});

	it("reads reference mappings alongside repo mappings", () => {
		const { config, problems } = parseReviewSection({
			references: [{ pattern: "^GH-(?<id>\\d+)$", provider: "github" }],
		});

		expect(problems).toEqual([]);
		expect(config.references).toEqual([
			{ pattern: "^GH-(?<id>\\d+)$", provider: "github" },
		]);
	});

	it("refuses a reference mapping with an unusable pattern", () => {
		const { config, problems } = parseReviewSection({
			references: [{ pattern: "(", provider: "github" }],
		});

		expect(config.references).toBeUndefined();
		expect(problems).toEqual([expect.stringContaining("unusable pattern")]);
	});
});
