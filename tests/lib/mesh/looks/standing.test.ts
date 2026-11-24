import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearLook,
	looksIn,
	openLook,
	pointAt,
	standingLooksListed,
} from "../../../../lib/mesh/looks/looks.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "standing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const who = { session: "S1", address: "85PKB2", quest: "QEST-1" };

/** A look at page `n`, pointed at minute `n`. */
function point(n: number) {
	return pointAt(
		dir,
		{
			kind: "page",
			target: `https://example.com/${n}`,
			title: `Page ${n}`,
			why: "Worth a read.",
			ask: "Nothing, just to see.",
		},
		who,
		new Date(`2026-11-24T14:0${n}:00Z`),
	);
}

// Joel, 24 November: "any interface i'm in should be directly engagable
// to a meaningful level"; a pi session acts on his list as the launcher does.
describe("the person's list, acted on from a session", () => {
	it("lists only the looks still standing, newest first", async () => {
		const first = point(1);
		const second = point(2);
		const third = point(3);
		clearLook(dir, second.id);

		expect((await standingLooksListed(dir)).map((look) => look.id)).toEqual([
			third.id,
			first.id,
		]);
	});

	it("clears a look as the launcher does, saying he cleared it and when", () => {
		const look = point(1);

		const cleared = clearLook(dir, look.id, new Date("2026-11-24T15:00:00Z"));

		const kept = looksIn(dir).find((one) => one.id === look.id);
		expect(kept).toMatchObject({
			state: "cleared",
			how: "cleared by you",
			resolvedAt: "2026-11-24T15:00:00.000Z",
		});
		expect(cleared).toEqual(kept);
	});

	it("clears nothing that has already left his list, or never was", () => {
		const look = point(1);
		clearLook(dir, look.id, new Date("2026-11-24T15:00:00Z"));
		const before = looksIn(dir);

		expect(clearLook(dir, look.id)).toBeUndefined();
		expect(clearLook(dir, "no-such-look")).toBeUndefined();
		expect(looksIn(dir)).toEqual(before);
	});

	it("marks a waiting look opened, and leaves an opened one as it is", () => {
		const look = point(1);

		expect(openLook(dir, look.id)?.state).toBe("opened");
		expect(looksIn(dir)[0]?.state).toBe("opened");
		expect(openLook(dir, look.id)?.state).toBe("opened");
	});

	it("opens nothing that has left his list", () => {
		const look = point(1);
		clearLook(dir, look.id);

		expect(openLook(dir, look.id)).toBeUndefined();
		expect(looksIn(dir)[0]?.state).toBe("cleared");
	});
});
