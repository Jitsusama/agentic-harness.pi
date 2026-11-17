/**
 * A fenced command git refused the shared folder's packed-refs, a tree
 * it doesn't hold or a signature is told why and where to go, and the
 * refusal is counted (ISXEG8 [753f43b4], [0804813d], [2fc080c2]).
 */

import { describe, expect, it, vi } from "vitest";
import {
	DELTA_ROUTE,
	PACKED_REFS_ROUTE,
	routedDelta,
	routedPackedRefs,
	routedSigning,
	routedUnheldTree,
	SIGNING_ROUTE,
	UNHELD_TREE_ROUTE,
} from "../../../../lib/internal/fence/fence-git-route.ts";

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

// ISXEG8 [2fc080c2], 15 November: a bash commit in a held tree couldn't
// sign, since the signing agent stays outside, and git named no route.
describe("a fenced command git couldn't sign with", () => {
	it("is told to commit and rebase with the work tool, and counted once", () => {
		const record = vi.fn();
		for (const said of [
			'error: No private key found for public key "/h/.ssh/agent-signing.pub"?\n\nfatal: failed to write commit object',
			"error: gpg failed to sign the data:\nCould not commit staged changes.",
			"error: gpg failed to sign the data\nerror: unable to sign the tag",
		]) {
			record.mockClear();
			expect(routedSigning(text(said), record), said).toEqual(
				text(`${said}\n\n${SIGNING_ROUTE}`),
			);
			expect(record, "it wasn't counted").toHaveBeenCalledTimes(1);
		}
		for (const route of ["work record", "work rebase"])
			expect(SIGNING_ROUTE, `the route doesn't name ${route}`).toContain(route);
	});

	it("leaves a signed commit and other output as it is", () => {
		const record = vi.fn();
		for (const said of [
			"[main 1234567] x\n 1 file changed",
			'Good "git" signature for joel.gerber@shopify.com',
			"fatal: Unable to create '/h/src/r/.git/index.lock': Read-only file system",
		]) {
			expect(routedSigning(text(said), record), said).toBeUndefined();
		}
		expect(record, "other output was counted").not.toHaveBeenCalled();
	});
});

// ISXEG8 [3b8dd276], 15 November: a bash fetch of World failed, its
// Delta credential out of reach inside, and nothing named a route.
describe("a fenced command git couldn't reach World's Delta with", () => {
	it("is told to fetch and push with the work tool, and counted once", () => {
		const record = vi.fn();
		for (const said of [
			"dev: unable to obtain a Delta credential from Mint or gcloud\nfatal: could not read Username for 'https://delta.shopify.io': terminal prompts disabled",
			"git credential-cache: unable to connect to cache daemon: Permission denied",
			"fatal: unable to connect to cache daemon: Permission denied",
		]) {
			record.mockClear();
			expect(routedDelta(text(said), record), said).toEqual(
				text(`${said}\n\n${DELTA_ROUTE}`),
			);
			expect(record, "it wasn't counted").toHaveBeenCalledTimes(1);
		}
		for (const route of ["work rebase", "work tree", "work push"])
			expect(DELTA_ROUTE, `the route doesn't name ${route}`).toContain(route);
	});

	it("leaves a fetch that worked, and a GitHub one, as they are", () => {
		const record = vi.fn();
		for (const said of [
			"From https://delta.shopify.io/shop/world\n * branch main -> FETCH_HEAD",
			"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
		]) {
			expect(routedDelta(text(said), record), said).toBeUndefined();
		}
		expect(record, "other output was counted").not.toHaveBeenCalled();
	});
});
