/**
 * A fenced command git refused the shared folder's packed-refs is told
 * why and where to go, and the refusal is counted (ISXEG8 [753f43b4]).
 */

import { describe, expect, it, vi } from "vitest";
import {
	PACKED_REFS_ROUTE,
	routedPackedRefs,
	routedUnheldTree,
	UNHELD_TREE_ROUTE,
} from "../../../lib/internal/fence-git-route.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("a fenced command refused the shared folder's packed-refs", () => {
	it("is told why and the route, and counted once", () => {
		const record = vi.fn();
		for (const said of [
			"error: unable to create lock file /h/src/r/.git/packed-refs.lock: Read-only file system",
			"fatal: Unable to create '/h/src/r/.git/packed-refs.lock': Read-only file system",
		]) {
			record.mockClear();
			const routed = routedPackedRefs(text(said), record);
			expect(routed, `${said} wasn't routed`).toEqual(
				text(`${said}\n\n${PACKED_REFS_ROUTE}`),
			);
			expect(record, "it wasn't counted").toHaveBeenCalledTimes(1);
		}
		expect(PACKED_REFS_ROUTE, "the route isn't named").toContain("work tool");
	});

	it("leaves any other output as it is, uncounted", () => {
		const record = vi.fn();
		for (const said of [
			"Deleted branch gone (was 1234567).",
			"touch: cannot touch '/h/src/r/.git/config': Read-only file system",
			"packed-refs rewritten",
		]) {
			expect(routedPackedRefs(text(said), record), said).toBeUndefined();
		}
		expect(routedPackedRefs([], record), "no output").toBeUndefined();
		expect(record, "other output was counted").not.toHaveBeenCalled();
	});
});

// ISXEG8 [0804813d], 15 November: git in a tree the session didn't
// hold said only "Read-only file system", naming no way through.
describe("a fenced command git refused a tree's own git folder", () => {
	it("is told to hold the tree with the work tool, and counted once", () => {
		const record = vi.fn();
		for (const said of [
			"fatal: Unable to create '/h/src/r/.git/worktrees/t/index.lock': Read-only file system",
			"error: cannot open '/h/world/git/worktrees/src221/FETCH_HEAD': Read-only file system",
			"fatal: Unable to create '/h/src/r/.git/index.lock': Read-only file system",
		]) {
			record.mockClear();
			expect(routedUnheldTree(text(said), record), said).toEqual(
				text(`${said}\n\n${UNHELD_TREE_ROUTE}`),
			);
			expect(record, "it wasn't counted").toHaveBeenCalledTimes(1);
		}
		expect(UNHELD_TREE_ROUTE, "the route isn't named").toContain("work tool");
	});

	it("leaves packed-refs to its own route, and other output as it is", () => {
		const record = vi.fn();
		for (const said of [
			"fatal: Unable to create '/h/src/r/.git/packed-refs.lock': Read-only file system",
			"touch: cannot touch '/h/notes/x': Read-only file system",
			"[main 1234567] x",
		]) {
			expect(routedUnheldTree(text(said), record), said).toBeUndefined();
		}
		expect(record, "other output was counted").not.toHaveBeenCalled();
	});
});
