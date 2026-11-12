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
} from "../../../extensions/quest-workflow/standing-rules.ts";

const MISSION = "QEST-20260101-MISSON";
const CHILD = "QEST-20260101-CHILDQ";
const GRANDCHILD = "QEST-20260101-GRANDC";
const LONER = "QEST-20260101-LONERQ";
const ROUTER = "QEST-20260101-ROUTER";
const HERMIT = "QEST-20260101-HERMIT";
const KEEPER = "QEST-20260101-KEEPER";

const ROUTER_BODY = "\n## 🏰 Context\n\nRoute each line to its owner.\n";

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
	[ROUTER]: readme(
		ROUTER,
		{ parent: MISSION, "context-stands": true },
		ROUTER_BODY,
	),
	[HERMIT]: readme(HERMIT, { "context-stands": true }, ROUTER_BODY),
	[KEEPER]: readme(KEEPER, { parent: MISSION }, ROUTER_BODY),
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

	it("carry the quest's own Context after them when its README says it stands", () => {
		const rules = standingRulesFor(ROUTER, read) ?? "";

		expect([
			rules.includes("Canadian spelling."),
			rules.includes("Route each line to its owner."),
			rules.indexOf("Canadian") < rules.indexOf("Route each"),
		]).toEqual([true, true, true]);
	});

	it("carry its own Context alone when it stands with no orchestrator above", () => {
		const rules = standingRulesFor(HERMIT, read) ?? "";

		expect(rules).toContain("Route each line to its owner.");
		expect(rules).not.toContain("Canadian spelling.");
	});

	it("leave its own Context out when its README doesn't say it stands", () => {
		expect(standingRulesFor(KEEPER, read)).not.toContain("Route each line");
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

	it("follow an edit to the quest's own standing Context", () => {
		const rulesFor = standingRules(() => root);
		expect(rulesFor(ROUTER)).toContain("Route each line to its owner.");

		const path = join(root, ROUTER, "README.md");
		writeFileSync(
			path,
			readme(
				ROUTER,
				{ parent: MISSION, "context-stands": true },
				ROUTER_BODY.replace("its owner", "whoever owns it"),
			),
		);
		const later = new Date(Date.now() + 5_000);
		utimesSync(path, later, later);

		expect(rulesFor(ROUTER)).toContain("Route each line to whoever owns it.");
	});

	it("follow the quest moving out from under its orchestrator", () => {
		const rulesFor = standingRules(() => root);
		expect(rulesFor(CHILD)).toContain("Canadian spelling.");

		const path = join(root, CHILD, "README.md");
		writeFileSync(path, readme(CHILD, {}));
		const later = new Date(Date.now() + 5_000);
		utimesSync(path, later, later);

		expect(rulesFor(CHILD)).toBeNull();
	});

	it("are none with no quest loaded", () => {
		expect(standingRules(() => root)(null)).toBeNull();
	});
});
