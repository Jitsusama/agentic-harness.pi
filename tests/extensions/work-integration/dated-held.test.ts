/**
 * Which trees the work tool dates as it names them: only this
 * session's own, since dating holds a tree and the broker lists every
 * tree recorded on the machine.
 */

import { describe, expect, it } from "vitest";
import { datedHeld } from "../../../extensions/work-integration/tools/listing.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";

/** A held tree at `path`, cut by the test's provider. */
function tree(path: string): HeldTree {
	return {
		identity: { key: path.split("/").pop() ?? path, shareable: true },
		path,
		providerId: "copying",
	};
}

/**
 * A broker whose session holds `ours`, answering `taken` as gone and
 * refusing to date while `refused` is set, keeping what it dated.
 */
function brokerHolding(
	ours: readonly string[],
	taken: readonly string[] = [],
	refused = false,
) {
	const dated: string[] = [];
	return {
		dated,
		heldHere: (trees: readonly HeldTree[]) =>
			Promise.resolve(
				new Set(
					trees.map((one) => one.path).filter((path) => ours.includes(path)),
				),
			),
		used: (held: HeldTree) => {
			if (refused) return Promise.reject(new Error("the lock is held"));
			dated.push(held.path);
			return Promise.resolve(!taken.includes(held.path));
		},
	};
}

describe("dating the trees it names", () => {
	it("dates this session's own and lists another's undated", async () => {
		const broker = brokerHolding(["/trees/ours"]);

		const listed = await datedHeld(broker, [
			tree("/trees/ours"),
			tree("/trees/theirs"),
		]);

		expect(broker.dated, "another session's tree was dated, so held").toEqual([
			"/trees/ours",
		]);
		expect(
			listed.map((one) => one.path),
			"a tree that stands wasn't listed",
		).toEqual(["/trees/ours", "/trees/theirs"]);
	});

	it("leaves out one of ours a sweep took", async () => {
		const broker = brokerHolding(["/trees/ours"], ["/trees/ours"]);

		const listed = await datedHeld(broker, [tree("/trees/ours")]);

		expect(listed, "a taken tree was still listed").toEqual([]);
	});

	it("still lists one of ours whose dating is refused", async () => {
		const broker = brokerHolding(["/trees/ours"], [], true);

		const listed = await datedHeld(broker, [tree("/trees/ours")]);

		expect(
			listed.map((one) => one.path),
			"a refused dating dropped a held tree",
		).toEqual(["/trees/ours"]);
	});
});
