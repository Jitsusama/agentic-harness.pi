/**
 * A server's answer in the tool's terms, where pi reads each file it
 * names to give its lines: one it can't read (gone, or one its fence
 * refuses) is left out, and the rest still answer.
 */
import { describe, expect, it } from "vitest";
import {
	fromSymbols,
	toLocations,
} from "../../../../lib/core/lsp/standalone/answers.ts";

const range = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 1 },
};

/** Lines for any file but `refused`, which the fence won't let pi read. */
const linesBut =
	(refused: string) =>
	(path: string): string[] => {
		if (path === refused) throw new Error(`${path} is outside`);
		return ["x"];
	};

describe("an answer naming a file pi can't read", () => {
	it("gives the locations it can read and leaves that one out", () => {
		expect(
			toLocations(
				[
					{ uri: "file:///work/a.ts", range },
					{ uri: "file:///away/key", range },
				],
				linesBut("/away/key"),
			).map((location) => location.path),
		).toEqual(["/work/a.ts"]);
	});

	it("does so for a link's target too", () => {
		expect(
			toLocations(
				[
					{
						targetUri: "file:///away/key",
						targetRange: range,
						targetSelectionRange: range,
					},
				],
				linesBut("/away/key"),
			),
		).toEqual([]);
	});

	it("gives the symbols it can read and leaves that one out", () => {
		expect(
			fromSymbols(
				[
					{
						name: "a",
						kind: 12,
						location: { uri: "file:///work/a.ts", range },
					},
					{ name: "k", kind: 12, location: { uri: "file:///away/key", range } },
				],
				linesBut("/away/key"),
			).map((symbol) => symbol.name),
		).toEqual(["a"]);
	});
});
