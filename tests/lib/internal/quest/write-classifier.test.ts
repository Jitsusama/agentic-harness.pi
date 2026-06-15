import { describe, expect, it } from "vitest";
import {
	type ClassifyWriteOptions,
	classifyWrite,
} from "../../../../lib/internal/quest/write-classifier";

const never = () => false;
const noTree = () => null;

function options(
	overrides: Partial<ClassifyWriteOptions> = {},
): ClassifyWriteOptions {
	return {
		questDir: null,
		scratchRoots: [],
		isGitignored: never,
		gitTreeRootOf: noTree,
		...overrides,
	};
}

describe("classifyWrite", () => {
	it("labels a target outside every exemption and git tree as loose", () => {
		const result = classifyWrite("/home/user/notes.txt", options());
		expect(result.category).toBe("loose-file");
	});

	it("labels a target under the loaded quest directory as quest-internal", () => {
		const result = classifyWrite(
			"/quests/Q1/research/note.md",
			options({ questDir: "/quests/Q1" }),
		);
		expect(result.category).toBe("quest-internal");
	});

	it("labels a target under a configured scratch root as scratch", () => {
		const result = classifyWrite(
			"/tmp/run-42/dump.json",
			options({ scratchRoots: ["/tmp"] }),
		);
		expect(result.category).toBe("scratch");
	});

	it("labels a gitignored in-tree target as scratch, not tracked code", () => {
		const result = classifyWrite(
			"/work/tree/.pi/scratch/repro.go",
			options({
				isGitignored: (p) => p === "/work/tree/.pi/scratch/repro.go",
				gitTreeRootOf: () => "/work/tree",
			}),
		);
		expect(result.category).toBe("scratch");
	});

	it("labels a non-exempt in-tree target as tracked-code with its tree root", () => {
		const result = classifyWrite(
			"/work/tree/areas/tools/gsperf/main.go",
			options({ gitTreeRootOf: () => "/work/tree" }),
		);
		expect(result.category).toBe("tracked-code");
		expect(result.treeRoot).toBe("/work/tree");
	});
});
