/**
 * pi's state inside the agent fence: the steer inboxes, the mesh's
 * store, the session records and the rest, which sessions trust for who
 * wrote them, kept from fenced commands and pi's file tools alike, with
 * the work broker's trees the session holds still its own to write.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs, fenceRefusesWrite } from "../../../lib/internal/fence.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";

/** A disk holding exactly the folders `folders` and every one above them. */
function foldersOf(folders: readonly string[]): Disk {
	const kinds = new Set<string>();
	for (const folder of folders) {
		for (let up = folder; up.lastIndexOf("/") > 0; ) {
			kinds.add(up);
			up = up.slice(0, up.lastIndexOf("/"));
		}
	}
	return {
		kind: (path) => (kinds.has(path) ? "folder" : undefined),
		entries: (folder) =>
			[...kinds]
				.filter((path) => path.slice(0, path.lastIndexOf("/")) === folder)
				.map((path) => path.slice(folder.length + 1)),
	};
}

describe("pi's state, which says who wrote it", () => {
	// A fenced command wrote a steer saying it was Joel's, or a mesh
	// message under another peer's address (KP0L6A, DJT4LK, 13 November);
	// or a session record saying PI_SANDBOX=off, which its session would
	// start with when reopened (85PKB2, 14 November).
	const home = "/home/someone";
	const pi = `${home}/.local/state/pi`;
	const state = `${pi}/agentic-harness.pi`;
	const trees = `${state}/work/trees`;
	const disk = foldersOf([
		`${state}/steer/0RF7H9`,
		`${state}/mesh-workflow/messages`,
		`${state}/quest-workflow/sessions`,
		`${state}/realms/personal/mesh-workflow`,
		`${state}/work/cut`,
		`${trees}/held`,
		`${trees}/other`,
	]);
	const place = {
		home,
		runtimeDir: undefined,
		cwd: `${home}/.cache/work`,
		trees: {
			root: trees,
			records: `${state}/work/cut`,
			held: [`${trees}/held`],
		},
	};

	it("binds pi's state read-only, and the session's own tree writable after it", () => {
		const args = fenceArgs(place, disk);
		const readOnly = args.indexOf(pi);
		expect(args[readOnly - 1], "pi's state stayed writable").toBe("--ro-bind");
		const held = args.lastIndexOf(`${trees}/held`);
		expect(args[held - 2], "the session's own tree isn't writable").toBe(
			"--bind",
		);
		expect(
			held > readOnly,
			"the session's tree is bound before pi's state",
		).toBe(true);
	});

	it("refuses pi's file tools there, and not in the session's own tree", () => {
		const refuses = (path: string) => fenceRefusesWrite(path, place, disk);
		for (const path of [
			`${state}/steer/0RF7H9/1-a.json`,
			`${state}/steer/NEW123/1-a.json`,
			`${state}/mesh-workflow/messages/forged.json`,
			`${state}/quest-workflow/sessions/someone.json`,
			`${state}/realms/personal/mesh-workflow/forged.json`,
			`${state}/away-workflow/away.json`,
			`${pi}/reboot-reopen.json`,
			`${trees}/other/file.ts`,
		]) {
			expect(refuses(path), `${path} was writable`).toBe(true);
		}
		expect(
			refuses(`${trees}/held/file.ts`),
			"the session's own tree was refused",
		).toBe(false);
	});
});
