import { describe, expect, it } from "vitest";
import {
	type ClassifyWriteOptions,
	classifyWrite,
} from "../../../../lib/internal/quest/write-classifier";

const never = () => false;
const always = () => true;
const noTree = () => null;

function options(
	overrides: Partial<ClassifyWriteOptions> = {},
): ClassifyWriteOptions {
	return {
		questDir: null,
		scratchDir: null,
		tempRoots: [],
		isGitignored: never,
		isTracked: never,
		gitTreeRootOf: noTree,
		...overrides,
	};
}

describe("classifyWrite", () => {
	it("labels a /dev node as a device", () => {
		for (const node of [
			"/dev/null",
			"/dev/stdout",
			"/dev/stderr",
			"/dev/fd/1",
			"/dev/tty",
		]) {
			expect(classifyWrite(node, options()).category).toBe("device");
		}
	});

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

	it("labels a target under a system temp root as system-temp", () => {
		const result = classifyWrite(
			"/tmp/run-42/dump.json",
			options({ tempRoots: ["/tmp"] }),
		);
		expect(result.category).toBe("system-temp");
	});

	it("labels a target under the managed scratch dir as quest-scratch", () => {
		const result = classifyWrite(
			"/tmp/pi-quest-Q1-Ab3xZ9/dump.json",
			options({
				scratchDir: "/tmp/pi-quest-Q1-Ab3xZ9",
				tempRoots: ["/tmp"],
			}),
		);
		expect(result.category).toBe("quest-scratch");
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

	it("labels a tracked in-tree target as tracked-code with its tree root", () => {
		const result = classifyWrite(
			"/work/tree/areas/tools/gsperf/main.go",
			options({ gitTreeRootOf: () => "/work/tree", isTracked: always }),
		);
		expect(result.category).toBe("tracked-code");
		expect(result.treeRoot).toBe("/work/tree");
	});

	it("labels an untracked, not-ignored in-tree target as untracked-in-tree", () => {
		const result = classifyWrite(
			"/work/tree/tmp_dump/scratch.json",
			options({ gitTreeRootOf: () => "/work/tree", isTracked: never }),
		);
		expect(result.category).toBe("untracked-in-tree");
		expect(result.treeRoot).toBe("/work/tree");
	});
});
