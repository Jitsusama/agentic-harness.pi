/** The reload slot: the process's own on plain pi, each conversation's in a host. */
import { afterEach, describe, expect, it } from "vitest";
import { withSession } from "../../../../lib/core/session/index.ts";
import { reloadSlot } from "../../../../lib/internal/reload/slot.ts";
import { installTestHost } from "../../../support/session-host.ts";

const KEY = Symbol.for("agentic-harness.reload.slot");
const store = globalThis as Record<symbol, unknown>;

describe("the reload slot on plain pi", () => {
	afterEach(() => {
		delete store[KEY];
	});

	it("is the one an older copy left under the process's key", () => {
		const left = { request: { reason: "left by the copy before", by: "self" } };
		store[KEY] = left;
		expect(reloadSlot()).toBe(left);
	});

	it("is made once and kept", () => {
		reloadSlot().performing = true;
		expect(reloadSlot().performing, "the slot made first is the one kept").toBe(
			true,
		);
	});
});

describe("the reload slot in a host of two conversations", () => {
	let installed: ReturnType<typeof installTestHost> | undefined;
	afterEach(() => {
		installed?.dispose();
		installed = undefined;
	});

	it("keeps one conversation's request and rollover from the other's", () => {
		installed = installTestHost();
		withSession("a", () => {
			reloadSlot().request = { reason: "a's own", by: "agent" };
			reloadSlot().rolling = true;
		});
		expect(withSession("b", reloadSlot)).toEqual({});
		expect(withSession("a", () => reloadSlot().request?.reason)).toBe(
			"a's own",
		);
	});

	it("lets a closed conversation's slot go and leaves the other's", async () => {
		installed = installTestHost();
		withSession("a", () => {
			reloadSlot().performing = true;
		});
		withSession("b", () => {
			reloadSlot().performing = true;
		});
		await installed.host.close("a", "done");
		expect(
			withSession("b", () => reloadSlot().performing),
			"b's slot stays",
		).toBe(true);
		expect(KEY in store, "nothing is left under the process's key").toBe(false);
	});
});
