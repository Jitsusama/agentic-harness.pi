/**
 * The harness's inboxes inside the agent fence: the steer inboxes and
 * the mesh's store, which sessions trust for who wrote them, kept from
 * fenced commands and pi's file tools alike.
 */

import { describe, expect, it } from "vitest";
import {
	type Disk,
	fenceArgs,
	fenceRefusesWrite,
} from "../../../lib/internal/fence.ts";

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

describe("the harness's inboxes, which say who wrote them", () => {
	// A fenced command wrote a steer saying it was Joel's, or a mesh
	// message under another peer's address (KP0L6A, DJT4LK, 13 November).
	const home = "/home/someone";
	const state = `${home}/.local/state/pi/agentic-harness.pi`;
	const disk = foldersOf([
		`${state}/steer/0RF7H9`,
		`${state}/mesh-workflow/messages`,
		`${state}/work/trees/thing`,
	]);
	const place = { home, runtimeDir: undefined, cwd: `${home}/.cache/work` };

	it("binds the steer inboxes and the mesh's store read-only", () => {
		const args = fenceArgs(place, disk);
		const kept = args.flatMap((arg, at) =>
			arg === "--ro-bind" ? [args[at + 1]] : [],
		);
		expect(kept, "the inboxes stayed writable").toEqual(
			expect.arrayContaining([`${state}/steer`, `${state}/mesh-workflow`]),
		);
	});

	it("refuses pi's file tools there, and not in the trees beside them", () => {
		const refuses = (path: string) => fenceRefusesWrite(path, place, disk);
		for (const path of [
			`${state}/steer/0RF7H9/1-a.json`,
			`${state}/steer/NEW123/1-a.json`,
			`${state}/mesh-workflow/messages/forged.json`,
		]) {
			expect(refuses(path), `${path} was writable`).toBe(true);
		}
		expect(
			refuses(`${state}/work/trees/thing/file.ts`),
			"a cut tree beside them was refused",
		).toBe(false);
	});
});
