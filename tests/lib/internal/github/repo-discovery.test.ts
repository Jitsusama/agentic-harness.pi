import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extractOwnerRepo } from "../../../../lib/internal/github/pr-reference.js";
import { findRepoOnDisk } from "../../../../lib/internal/github/repo-discovery.js";

const HOME = "/home/test";

describe("findRepoOnDisk", () => {
	it("returns the first location that matches in search order", () => {
		// Both the github.com path and the shorter code/ path exist,
		// but the github.com pattern is searched first and wins.
		const found = findRepoOnDisk("acme", "widgets", {
			home: HOME,
			isGitRepo: (dir) =>
				dir === path.join(HOME, "src/github.com/acme/widgets") ||
				dir === path.join(HOME, "code/widgets"),
		});

		expect(found).toBe(path.join(HOME, "src/github.com/acme/widgets"));
	});

	it("falls through to a later pattern when the earlier ones miss", () => {
		const found = findRepoOnDisk("acme", "widgets", {
			home: HOME,
			isGitRepo: (dir) => dir === path.join(HOME, "dev/widgets"),
		});

		expect(found).toBe(path.join(HOME, "dev/widgets"));
	});

	it("returns null when no location matches", () => {
		const found = findRepoOnDisk("acme", "widgets", {
			home: HOME,
			isGitRepo: () => false,
		});

		expect(found).toBeNull();
	});
});

describe("extractOwnerRepo", () => {
	it("parses an https remote", () => {
		expect(extractOwnerRepo("https://github.com/acme/widgets.git")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	it("parses an ssh remote", () => {
		expect(extractOwnerRepo("git@github.com:acme/widgets.git")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	it("returns null for a non-GitHub remote", () => {
		expect(extractOwnerRepo("https://gitlab.com/acme/widgets.git")).toBeNull();
	});
});
