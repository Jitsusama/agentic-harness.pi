/**
 * Whether a quest has ended, as the look list asks it each minute, so a
 * look outlives no quest that ended in another session.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questEnded } from "../../../lib/mesh/presence.ts";

let quests: string;
beforeEach(() => {
	quests = mkdtempSync(join(tmpdir(), "quest-ended-"));
});
afterEach(() => rmSync(quests, { recursive: true, force: true }));

/** A quest under `quests` standing at `status`. */
function quest(id: string, status: string): void {
	mkdirSync(join(quests, id), { recursive: true });
	writeFileSync(
		join(quests, id, "README.md"),
		`---\nid: ${id}\nkind: quest\nparent: null\nstatus: ${status}\npriority: active\nrank: 1\nstarted: 2026-11-11\nupdated: 2026-11-11\n---\n# ${id}\n`,
	);
}

describe("whether a quest has ended", () => {
	it("says so of a concluded or retired quest, and not of a live one", () => {
		quest("QEST-20261111-AAAAAA", "concluded");
		quest("QEST-20261111-BBBBBB", "retired");
		quest("QEST-20261111-CCCCCC", "active");

		expect(questEnded(quests, "QEST-20261111-AAAAAA"), "concluded").toBe(true);
		expect(questEnded(quests, "QEST-20261111-BBBBBB"), "retired").toBe(true);
		expect(questEnded(quests, "QEST-20261111-CCCCCC"), "active").toBe(false);
	});

	it("doesn't call a quest it can't read ended", () => {
		expect(questEnded(quests, "QEST-20261111-DDDDDD"), "no README").toBe(false);
	});
});
