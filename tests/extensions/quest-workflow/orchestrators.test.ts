/**
 * The list of orchestrators the desktop reads, kept from the quests.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	orchestratorsIn,
	writeOrchestrators,
} from "../../../extensions/quest-workflow/orchestrators";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../lib/internal/quest/discovery";

const MISSION = "QEST-20260101-MISSON";
const NESTED = "QEST-20260101-NESTED";
const PLAIN = "QEST-20260101-PLAINQ";
const OLD = "QEST-20260101-OLDONE";

let root: string;

function quest(
	id: string,
	fields: Record<string, string | number | boolean>,
	title = id,
): void {
	const all = { status: "active", rank: 1, ...fields };
	const lines = Object.entries(all).map(([key, value]) => `${key}: ${value}`);
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(
		join(root, id, "README.md"),
		`---\nid: ${id}\nkind: quest\npriority: active\nstarted: 2026-01-01\nupdated: 2026-01-01\n${lines.join("\n")}\n---\n\n# ${title}\n`,
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orchestrators-"));
	clearDiscoveryCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("the orchestrators the desktop lists", () => {
	it("are the open marked quests, parents first, with what it shows of each", () => {
		quest(
			MISSION,
			{ orchestrator: true, short: "Optimus" },
			"Bootstrap optimus",
		);
		quest(NESTED, { orchestrator: true, parent: MISSION, rank: 2 });
		quest(PLAIN, { parent: MISSION, rank: 1 });
		quest(OLD, { orchestrator: true, status: "concluded" });

		expect(orchestratorsIn(discoverQuests(root).index)).toEqual([
			{
				quest: MISSION,
				address: "MISSON",
				short: "Optimus",
				title: "Bootstrap optimus",
			},
			{
				quest: NESTED,
				address: "NESTED",
				title: NESTED,
				parent: MISSION,
			},
		]);
	});

	it("are written whole, and only when the list changed", () => {
		const path = join(root, "state", "orchestrators.json");
		const list = [{ quest: MISSION, address: "MISSON", title: "Mission" }];

		expect(writeOrchestrators(list, path)).toBe(true);
		expect(writeOrchestrators(list, path)).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			orchestrators: list,
		});
		expect(writeOrchestrators([], path)).toBe(true);
	});
});
