/**
 * What the nix-offload exemption lets out of the fence beyond a bare
 * call: never a flag that works on this machine, a `--run` only of the
 * store's own, and one `cd` only into a tree the work tool holds for the
 * session, as ISXEG8's review of 11 November set out. A bare call runs
 * in the command's own folder, whose git a `--run` always reads.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitFolders, guardsGitFolder } from "../../../lib/internal/fence.ts";
import {
	NO_GIT_DIR,
	type OffloadPlace,
	offloadedOutside,
} from "../../../lib/internal/offload-exemption.ts";
import { folderGit, heldTree } from "../../../lib/internal/sandbox.ts";

const OFFLOAD = {
	program: "/nix/store/0000-nix-offload/bin/nix-offload",
	env: "/nix/store/0000-coreutils/bin/env",
};
const SCRIPT = "/nix/store/0000-harness-check";

/** The shell text for `command`, or nothing when it stays fenced. */
function letOut(
	command: string,
	place: Partial<OffloadPlace> = {},
): string | undefined {
	return offloadedOutside(command, OFFLOAD, {
		home: "/home/someone",
		env: {},
		...place,
	});
}

describe("the flags the exemption lets out", () => {
	it("refuses every flag that builds, waits or runs on this machine", () => {
		for (const command of [
			"nix-offload there --here /tree checks.x86_64-linux.formatting",
			"nix-offload there --here-when-idle /tree checks.x86_64-linux.a",
			"nix-offload there --outlive /tree checks.x86_64-linux.a",
			"nix-offload there --here=1 /tree checks.x86_64-linux.a",
			"nix-offload there --changed --here",
			"nix-offload there --out /home/someone/.config/systemd/user /tree a",
			"nix-offload there --out=/home/someone/.config /tree a",
		]) {
			expect(letOut(command), command).toBeUndefined();
		}
	});

	it("lets out a build or a changed-checks run on a builder", () => {
		for (const command of [
			"nix-offload there --keep-going /tree checks.x86_64-linux.formatting",
			"nix-offload there -L --changed",
			"nix-offload there /nix/store/0000-a.drv^*",
		]) {
			expect(letOut(command), command).toBeDefined();
		}
	});

	it("tells git outside any tree to read no .git at all", () => {
		const text = letOut("nix-offload there /tree checks.x86_64-linux.a");
		for (const set of [
			`GIT_DIR=${NO_GIT_DIR}`,
			"GIT_CEILING_DIRECTORIES=/",
			"GIT_CONFIG_KEY_0=core.fsmonitor",
			"GIT_CONFIG_VALUE_0=false",
		]) {
			expect(text, set).toContain(`'${set}'`);
		}
	});

	it("lets out a --run only of what the store holds", () => {
		expect(
			letOut(
				`nix-offload there --run --copy ${SCRIPT} --longest 1800 -- ${SCRIPT} main`,
			),
			"a store program with a store copy",
		).toBeDefined();
		for (const command of [
			`nix-offload there --run --copy ${SCRIPT} -- bash ${SCRIPT} main`,
			`nix-offload there --run --copy /home/someone/x.sh -- ${SCRIPT}`,
			`nix-offload there --run --copy=${SCRIPT} -- ${SCRIPT}`,
			`nix-offload there --run --copy ${SCRIPT} -- /home/someone/x.sh`,
			`nix-offload there --run --copy /nix/store/../home/x -- ${SCRIPT}`,
			`nix-offload there --run --copy ${SCRIPT} ${SCRIPT}`,
			`nix-offload there --run --copy ${SCRIPT} --`,
			`nix-offload there --run --copy -- ${SCRIPT}`,
		]) {
			expect(letOut(command), command).toBeUndefined();
		}
	});
});

describe("a cd before the call", () => {
	let base: string;
	let home: string;
	let tree: string;
	let records: string;

	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "offload-cd-")));
		home = join(base, "home");
		const repository = join(base, "repo");
		const own = join(repository, "worktrees", "tree");
		tree = join(base, "trees", "tree");
		records = join(base, "records");
		for (const folder of [
			home,
			join(repository, "objects"),
			own,
			tree,
			records,
		])
			mkdirSync(folder, { recursive: true });
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writeFileSync(join(own, "gitdir"), `${join(tree, ".git")}\n`);
		writeFileSync(join(own, "commondir"), "../..\n");
		writeFileSync(
			join(records, "tree.json"),
			JSON.stringify({
				identity: { key: "tree", shareable: false },
				path: tree,
				providerId: "git-worktree",
				sessions: ["s1"],
			}),
		);
		symlinkSync(tree, join(base, "link"));
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const vouch = (session: string) => (folder: string) =>
		heldTree(folder, home, session, records);

	it("runs the call in a tree the session holds", () => {
		const text = letOut(`cd ${tree} && nix-offload there --changed`, {
			heldTree: vouch("s1"),
		});
		expect(text, "a held tree is refused").toBeDefined();
		expect(
			text?.startsWith(`cd '${tree}' && exec -a env`),
			"the call runs from the tree",
		).toBe(true);
	});

	it("holds git to the tree's own git folder, read once", () => {
		const text = letOut(`cd ${tree} && nix-offload there --changed`, {
			heldTree: vouch("s1"),
		});
		const own = join(base, "repo", "worktrees", "tree");
		for (const set of [
			`GIT_DIR=${own}`,
			`GIT_WORK_TREE=${tree}`,
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=core.fsmonitor",
			"GIT_CONFIG_VALUE_0=false",
		]) {
			expect(text, set).toContain(`'${set}'`);
		}
		expect(text, "no other git folder").not.toContain(NO_GIT_DIR);
	});

	it("refuses a tree another session holds, or none", () => {
		expect(
			letOut(`cd ${tree} && nix-offload there --changed`, {
				heldTree: vouch("s2"),
			}),
			"another session's tree",
		).toBeUndefined();
		expect(
			letOut(`cd ${home} && nix-offload there --changed`, {
				heldTree: vouch("s1"),
			}),
			"a folder no record names",
		).toBeUndefined();
		expect(
			letOut(`cd ${tree} && nix-offload there --changed`),
			"nothing to vouch for it",
		).toBeUndefined();
	});

	it("holds a bare call in a held tree to the tree's own git folder", () => {
		const text = letOut("nix-offload there --changed", {
			cwd: tree,
			folderGit: (folder) => folderGit(folder, home, "s1", records),
		});
		const own = join(base, "repo", "worktrees", "tree");
		expect(text, "the tree's git").toContain(`'GIT_DIR=${own}'`);
		expect(text, "the tree's files").toContain(`'GIT_WORK_TREE=${tree}'`);
	});

	it("refuses a held tree named through a link", () => {
		expect(
			letOut(`cd ${join(base, "link")} && nix-offload there --changed`, {
				heldTree: vouch("s1"),
			}),
		).toBeUndefined();
	});

	it("refuses a held tree whose git links don't agree", () => {
		const own = join(base, "repo", "worktrees", "tree");
		writeFileSync(join(own, "commondir"), "../../../elsewhere\n");
		try {
			expect(heldTree(tree, home, "s1", records)).toBeUndefined();
		} finally {
			writeFileSync(join(own, "commondir"), "../..\n");
		}
	});

	it("refuses anything chained, substituted or flagged around it", () => {
		const held = { heldTree: vouch("s1") };
		for (const command of [
			`cd ${tree} && nix-offload there --changed && echo out`,
			`cd ${tree} && cd ${tree} && nix-offload there --changed`,
			`cd ${tree}; nix-offload there --changed`,
			`cd $(echo ${tree}) && nix-offload there --changed`,
			`cd "${tree}" && nix-offload there --changed`,
			`cd ${tree}/* && nix-offload there --changed`,
			"cd trees/tree && nix-offload there --changed",
			`cd ${tree} && nix-offload there --here --changed`,
			`cd ${tree} && echo out`,
			`cd ${tree} &&\nnix-offload there --changed`,
		]) {
			expect(letOut(command, held), command).toBeUndefined();
		}
	});
});

describe("a bare call in the command's folder", () => {
	let home: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "offload-bare-")));
		for (const where of ["src/r/.git", "src/r/sub", "elsewhere/r/.git"]) {
			mkdirSync(join(home, where), { recursive: true });
		}
		mkdirSync(join(home, "src/linked"), { recursive: true });
		symlinkSync(join(home, "elsewhere/r/.git"), join(home, "src/linked/.git"));
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	const bare = (cwd: string) =>
		letOut(`nix-offload there --run --copy ${SCRIPT} -- ${SCRIPT} main`, {
			home,
			cwd,
			folderGit: (folder) =>
				folderGit(folder, home, "s1", join(home, "elsewhere", "records")),
		});

	it("holds a run in a guarded checkout to that checkout's git", () => {
		const checkout = join(home, "src/r");
		const text = bare(checkout);
		expect(text, "its git folder").toContain(
			`'GIT_DIR=${join(checkout, ".git")}'`,
		);
		expect(text, "its files").toContain(`'GIT_WORK_TREE=${checkout}'`);
		expect(text, "no other git folder").not.toContain(NO_GIT_DIR);
	});

	it("gives git no folder at all anywhere else", () => {
		for (const cwd of [
			join(home, "elsewhere/r"),
			join(home, "src/r/sub"),
			join(home, "src/linked"),
			home,
		]) {
			expect(bare(cwd), cwd).toContain(`'GIT_DIR=${NO_GIT_DIR}'`);
		}
	});
});

describe("the fence's guarded git folders", () => {
	let home: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "guarded-git-")));
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("are the ones the walk lists in src and world, told apart one at a time", () => {
		const places = [
			"top",
			".hidden-top",
			"src/a",
			"src/github.com/org/repo",
			"src/w/x/y/z",
			"src/v/w/x/y/z",
			"src/.hidden/r",
			"src/a/inner",
			"world/r",
			"world/r2/deeper",
			"elsewhere/r",
		];
		for (const where of places) {
			mkdirSync(join(home, where, ".git"), { recursive: true });
		}
		const bareRepository = join(home, "src/bare.git");
		mkdirSync(join(bareRepository, "objects"), { recursive: true });
		writeFileSync(join(bareRepository, "HEAD"), "ref: refs/heads/main\n");

		const listed = new Set(gitFolders(home));
		const candidates = [
			...places.map((where) => join(home, where, ".git")),
			bareRepository,
		];
		// A repository in another entry of the home folder is guarded by
		// the fence but counts for nothing: a command can make one there.
		const kept = (git: string) =>
			["src", "world"].some((top) => git.startsWith(join(home, top, "/")));
		for (const git of candidates) {
			expect(guardsGitFolder(git, home), git).toBe(
				listed.has(git) && kept(git),
			);
		}
		expect(
			[...listed],
			"the walk still finds one in the home folder",
		).toContain(join(home, "top/.git"));
		expect(listed.size, "the walk found some and missed some").toBeLessThan(
			candidates.length,
		);
		expect([...listed]).toContain(join(home, "src/a/.git"));
	});
});
