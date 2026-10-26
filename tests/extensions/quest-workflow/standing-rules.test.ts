/**
 * An orchestrator's standing rules, flowing down to the quests below it.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	standingRules,
	standingRulesFor,
} from "../../../extensions/quest-workflow/standing-rules";

const MISSION = "QEST-20260101-MISSON";
const CHILD = "QEST-20260101-CHILDQ";
const GRANDCHILD = "QEST-20260101-GRANDC";
const LONER = "QEST-20260101-LONERQ";

function readme(
	id: string,
	fields: Record<string, string | boolean>,
	body = "",
): string {
	const lines = Object.entries(fields).map(
		([key, value]) => `${key}: ${value}`,
	);
	return `---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-01-01\nupdated: 2026-01-01\n${lines.join("\n")}\n---\n\n# ${id}\n${body}`;
}

const MISSION_BODY = [
	"",
	"## 🧭 Purpose",
	"",
	"Replace the laptop.",
	"",
	"## 🏰 Context",
	"",
	"**Rules.** Canadian spelling. Never send Slack messages.",
	"",
	"## 🌄 Journey",
	"",
	"See attachments/journey.md.",
].join("\n");

const store: Record<string, string> = {
	[MISSION]: readme(MISSION, { orchestrator: true }, MISSION_BODY),
	[CHILD]: readme(CHILD, { parent: MISSION }),
	[GRANDCHILD]: readme(GRANDCHILD, { parent: CHILD }),
	[LONER]: readme(LONER, {}, "\n## 🏰 Context\n\nMine alone.\n"),
};
const read = (id: string) => store[id];

describe("the standing rules a quest's session starts with", () => {
	it("are its orchestrator's Context section, and nothing else of it", () => {
		const rules = standingRulesFor(GRANDCHILD, read);

		expect(rules).toContain(MISSION);
		expect(rules).toContain("Canadian spelling. Never send Slack messages.");
		expect(rules).not.toContain("Replace the laptop.");
		expect(rules).not.toContain("journey.md");
	});

	it("are none for a quest with no orchestrator, or the orchestrator itself", () => {
		expect(standingRulesFor(LONER, read)).toBeNull();
		expect(standingRulesFor(MISSION, read)).toBeNull();
	});
});

describe("the standing rules for the loaded quest", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "standing-rules-"));
		for (const [id, text] of Object.entries(store)) {
			mkdirSync(join(root, id));
			writeFileSync(join(root, id, "README.md"), text);
		}
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("follow an edit to the orchestrator's Context", () => {
		const rulesFor = standingRules(() => root);
		expect(rulesFor(CHILD)).toContain("Canadian spelling.");

		const path = join(root, MISSION, "README.md");
		writeFileSync(
			path,
			readme(
				MISSION,
				{ orchestrator: true },
				MISSION_BODY.replace("Canadian", "British"),
			),
		);
		const later = new Date(Date.now() + 5_000);
		utimesSync(path, later, later);

		expect(rulesFor(CHILD)).toContain("British spelling.");
	});

	it("are none with no quest loaded", () => {
		expect(standingRules(() => root)(null)).toBeNull();
	});
});
