import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeLoaded,
	homely,
	isSwapped,
	readLoaded,
} from "../../../../lib/internal/reload/loaded.ts";
import { disposeRepo, freshRepo } from "../../../support/git-fixture.ts";

const NAME = "agentic-harness.pi";
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("saying which code runs", () => {
	it("says the install, with its commit, when that is what runs", () => {
		const text = describeLoaded(NAME, {
			root: "/opt/harness",
			install: "/opt/harness",
			head: SHA,
			uncommitted: 0,
		});
		expect(text).toBe(
			"agentic-harness.pi runs its install, /opt/harness at 0123456789ab.",
		);
	});

	it("says a tree is not the install, and where the install is", () => {
		const text = describeLoaded(NAME, {
			root: "/src/tree",
			install: "/opt/harness",
			head: SHA,
			uncommitted: 3,
		});
		expect(text).toBe(
			"agentic-harness.pi runs /src/tree at 0123456789ab, with 3 uncommitted changes, not its install: the install is /opt/harness.",
		);
	});

	it("counts one change as one", () => {
		expect(
			describeLoaded(NAME, {
				root: "/t",
				install: "/i",
				head: SHA,
				uncommitted: 1,
			}),
		).toContain("with 1 uncommitted change,");
	});

	it("says when no settings name an install at all", () => {
		expect(describeLoaded(NAME, { root: "/src/tree" })).toContain(
			"pi's settings name no install of it",
		);
		expect(isSwapped({ root: "/src/tree" })).toBe(true);
	});

	it("counts a release the install's link has left as the install, behind it", () => {
		const releases = "/p/github.com/Jitsusama/agentic-harness.pi/releases";
		expect(
			isSwapped({ root: `${releases}/aaa`, install: `${releases}/bbb` }),
		).toBe(false);
		expect(isSwapped({ root: "/src/tree", install: `${releases}/bbb` })).toBe(
			true,
		);
		expect(
			isSwapped({
				root: "/p/github.com/Jitsusama/neovim.pi/releases/aaa",
				install: `${releases}/bbb`,
			}),
		).toBe(true);
	});

	it("writes the home directory as ~", () => {
		expect(homely("/home/joel/src/x", "/home/joel")).toBe("~/src/x");
		expect(homely("/home/joelle/x", "/home/joel")).toBe("/home/joelle/x");
	});
});

describe("reading what runs from git", () => {
	let repo: string | undefined;
	afterEach(() => {
		if (repo) disposeRepo(repo);
		repo = undefined;
	});

	it("reads the checkout's commit and counts what differs from it", async () => {
		repo = await freshRepo();
		writeFileSync(join(repo, "new.txt"), "x");
		const loaded = await readLoaded(repo, "/opt/harness");
		expect(loaded.head).toMatch(/^[0-9a-f]{40}$/);
		expect(loaded.uncommitted).toBe(1);
		expect(loaded.install).toBe("/opt/harness");
	});

	it("reads nothing from git where there is no checkout", async () => {
		const loaded = await readLoaded("/", undefined);
		expect(loaded).toEqual({ root: "/" });
	});
});
