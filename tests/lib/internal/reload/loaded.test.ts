import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeLoaded,
	homely,
	isSwapped,
	lastingPath,
	readLoaded,
} from "../../../../lib/internal/reload/loaded.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";
import { watchSpawns } from "../../../support/spawns.ts";

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
		expect(
			isSwapped({ root: "/src/tree" }),
			"a load with no install named counts as swapped",
		).toBe(true);
	});

	it("counts a version the install's link has left as the install, behind it", () => {
		const versions = "/p/github.com/Jitsusama/agentic-harness.pi/versions";
		expect(
			isSwapped({ root: `${versions}/aaa`, install: `${versions}/bbb` }),
			"a version the link has left counts as the install",
		).toBe(false);
		expect(
			isSwapped({ root: "/src/tree", install: `${versions}/bbb` }),
			"a tree outside the install counts as swapped",
		).toBe(true);
		expect(
			isSwapped({
				root: "/p/github.com/Jitsusama/neovim.pi/versions/aaa",
				install: `${versions}/bbb`,
			}),
			"another package's version counts as swapped",
		).toBe(true);
	});

	it("counts a version in the former releases/ folder as the install too", () => {
		const install = "/p/github.com/Jitsusama/agentic-harness.pi";
		expect(
			isSwapped({
				root: `${install}/releases/aaa`,
				install: `${install}/versions/bbb`,
			}),
			"a version in releases/ counts as the install",
		).toBe(false);
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

	// Every conversation a host starts or wakes asks which code runs, and
	// each git it started was forked from the loop the others wait on:
	// 459 ms of one turn in a soak of twelve (13 November).
	it("reads the commit from git's files, and asks git once a load what differs", async () => {
		repo = await freshRepo();
		const watch = watchSpawns();
		try {
			const first = await readLoaded(repo, undefined);
			const again = await readLoaded(repo, undefined);
			expect(again).toEqual(first);
		} finally {
			watch.stop();
		}
		expect(
			watch.started.map(({ how, program }) => `${how} ${program}`),
			"git asked only what differs, once",
		).toEqual(["execFile git"]);
		expect((await readLoaded(repo, undefined)).head).toBe(
			await git(repo, "rev-parse", "HEAD"),
		);
	});
});

describe("a path that outlives its version", () => {
	const OLD = "1111111111111111111111111111111111111111";
	const NEW = "2222222222222222222222222222222222222222";
	const SCRIPT = join("scripts", "host-join.ts");
	let install = "";

	/** An install holding `versions` in `folder`, each with the join script, its link at the last. */
	function installIn(folder: string, ...versions: readonly string[]): void {
		install = mkdtempSync(join(tmpdir(), "install-"));
		for (const version of versions) {
			mkdirSync(join(install, folder, version, "scripts"), {
				recursive: true,
			});
			writeFileSync(join(install, folder, version, SCRIPT), "");
		}
		symlinkSync(join(folder, versions.at(-1) ?? ""), join(install, "current"));
	}

	/** An install holding `versions` under versions/, its link at the last. */
	function installWith(...versions: readonly string[]): void {
		installIn("versions", ...versions);
	}

	afterEach(() => {
		if (install !== "") rmSync(install, { recursive: true, force: true });
		install = "";
	});

	it("still reaches the file once the version it was taken from is removed", () => {
		installWith(OLD, NEW);
		const lasting = lastingPath(join(install, "versions", OLD, SCRIPT));
		rmSync(join(install, "versions", OLD), { recursive: true });
		expect(
			existsSync(lasting),
			`the path ${lasting} names a file that outlived its version`,
		).toBe(true);
		expect(lasting, "it goes through the install's link").toBe(
			join(install, "current", SCRIPT),
		);
	});

	it("reaches the file through the link from the former releases/ folder too", () => {
		installIn("releases", OLD, NEW);
		expect(
			lastingPath(join(install, "releases", OLD, SCRIPT)),
			"it goes through the install's link",
		).toBe(join(install, "current", SCRIPT));
	});

	it("keeps the version's own path when the link's version lacks the file", () => {
		installWith(OLD, NEW);
		rmSync(join(install, "versions", NEW, SCRIPT));
		const file = join(install, "versions", OLD, SCRIPT);
		expect(lastingPath(file), "the file as it was").toBe(file);
	});

	it("keeps a path outside any install, as a checkout's", () => {
		const file = join("/src", "tree", SCRIPT);
		expect(
			lastingPath(file, () => true),
			"the checkout's own path",
		).toBe(file);
	});
});
