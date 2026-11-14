/** Watching a parked peer's steer inboxes: each waking steer is said once, as it lands. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { giveSteer } from "../../../lib/mesh/steer.ts";
import { watchWakingSteers } from "../../../lib/mesh/steer-watch.ts";
import { quietFor, until } from "../../support/until.ts";

/** How long a steer that lands may take to be said. */
const SAID_WITHIN_MS = 100;

let root: string;
beforeEach(async () => {
	root = join(await mkdtemp(join(tmpdir(), "steer-watch-")), "steer");
});
afterEach(async () => {
	await rm(join(root, ".."), { recursive: true, force: true });
});

describe("watching a parked peer's steer inboxes", () => {
	it("says a talk to any of its addresses, once each, and nothing after it closes", async () => {
		const waking = vi.fn();
		const watch = watchWakingSteers({
			root,
			addresses: ["a1b2c3", "QUEST1"],
			waking,
			report: vi.fn(),
		});

		const first = giveSteer(root, "A1B2C3", { text: "one", from: "joel" });
		await until(
			"the first talk to be said",
			() => waking.mock.calls.length > 0,
		);
		const second = giveSteer(root, "QUEST1", { text: "two", from: "joel" });
		await until(
			"the second talk to be said",
			() => waking.mock.calls.length > 1,
		);
		watch.close();
		giveSteer(root, "A1B2C3", { text: "three", from: "joel" });
		await quietFor(SAID_WITHIN_MS, 3);

		expect(waking.mock.calls, "each talk once, in order").toEqual([
			[first],
			[second],
		]);
	});

	it("says one of several already waiting, and none that waits on nothing", async () => {
		giveSteer(root, "A1B2C3", { text: "", act: "pause", from: "joel" });
		const carry = giveSteer(root, "A1B2C3", {
			text: "",
			act: "carry",
			to: "penelope",
			from: "joel",
		});
		giveSteer(root, "A1B2C3", { text: "and this", from: "joel" });
		const waking = vi.fn();

		const watch = watchWakingSteers({
			root,
			addresses: ["A1B2C3"],
			waking,
			report: vi.fn(),
		});
		await quietFor(SAID_WITHIN_MS, 3);
		watch.close();

		expect(waking.mock.calls, "the first that waits on it running").toEqual([
			[carry],
		]);
	});
});
