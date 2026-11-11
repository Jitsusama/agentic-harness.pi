/**
 * What the nix-offload exemption lets out of the fence beyond a bare
 * call: never a flag that works on this machine, a `--run` only of the
 * store's own, and one `cd` only into a tree the work tool holds for the
 * session, as ISXEG8's review of 11 November set out.
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
import {
	type OffloadPlace,
	offloadedOutside,
} from "../../../lib/internal/fence.ts";
import { heldTree } from "../../../lib/internal/sandbox.ts";

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
