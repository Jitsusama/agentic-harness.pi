/**
 * Stamping the quests made before `realm` existed, once, from the realm
 * folder each lives in: a dry run says what it would do, and only a
 * second run with `write` changes a file.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatStamp,
	stampQuestRealms,
} from "../../scripts/stamp-quest-realms.ts";

let root: string;

function quest(
	quests: string,
	path: string,
	fields: { parent?: string; status?: string; realm?: string } = {},
) {
	const id = path.split("/").at(-1) ?? path;
	mkdirSync(join(quests, path), { recursive: true });
	writeFileSync(
		join(quests, path, "README.md"),
		[
			"---",
			`id: ${id}`,
			...(fields.realm ? [`realm: ${fields.realm}`] : []),
			`kind: ${fields.parent ? "subquest" : "quest"}`,
			`parent: ${fields.parent ?? "null"}`,
			`status: ${fields.status ?? "active"}`,
			"priority: active",
			"rank: 1",
			"started: 2026-11-01",
			"updated: 2026-11-01",
			"---",
			"",
			`# ${id}`,
			"",
		].join("\n"),
	);
	return join(quests, path, "README.md");
}

const HOME = () => join(root, "quest-workflow", "quests");
const OTHER = () => join(root, "realms", "home", "quest-workflow", "quests");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "stamp-"));
	quest(HOME(), "QEST-20261101-AAAAAA");
	quest(HOME(), "QEST-20261101-AAAAAA/QEST-20261101-BBBBBB", {
		parent: "QEST-20261101-AAAAAA",
	});
	quest(HOME(), "QEST-20261101-CCCCCC", { status: "concluded" });
	quest(HOME(), "QEST-20261101-DDDDDD", { realm: "work" });
	// Kept in the other realm's folder, its parent in home's.
	quest(OTHER(), "QEST-20261101-EEEEEE", { parent: "QEST-20261101-AAAAAA" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stamping open quests with their realm", () => {
	it("says per realm what it would stamp, changing nothing", () => {
		const before = readFileSync(
			join(HOME(), "QEST-20261101-AAAAAA", "README.md"),
			"utf8",
		);
		const report = stampQuestRealms({
			roots: [
				{ realm: "work", quests: HOME() },
				{ realm: "home", quests: OTHER() },
			],
			write: false,
		});
		expect(
			[
				report.realms.map((r) => [r.realm, r.stamped, r.marked, r.closed]),
				report.disagreements.map((d) => [d.id, d.realm, d.parentRealm]),
				readFileSync(join(HOME(), "QEST-20261101-AAAAAA", "README.md"), "utf8"),
			],
			"two to stamp at work, one at home whose parent is at work",
		).toEqual([
			[
				["work", 2, 1, 1],
				["home", 1, 0, 0],
			],
			[["QEST-20261101-EEEEEE", "home", "work"]],
			before,
		]);
		expect(formatStamp(report), "the printout").toContain(
			"QEST-20261101-EEEEEE is kept in home but its parent, QEST-20261101-AAAAAA, in work",
		);
	});

	it("writes each realm by its folder, once, leaving updated alone", () => {
		const roots = [
			{ realm: "work", quests: HOME() },
			{ realm: "home", quests: OTHER() },
		];
		stampQuestRealms({ roots, write: true });
		const again = stampQuestRealms({ roots, write: true });
		const readme = (quests: string, path: string) =>
			readFileSync(join(quests, path, "README.md"), "utf8");
		const sub = readme(HOME(), "QEST-20261101-AAAAAA/QEST-20261101-BBBBBB");
		expect(
			[
				/^realm: work$/m.test(sub),
				/^updated: 2026-11-01$/m.test(sub),
				/^realm: home$/m.test(readme(OTHER(), "QEST-20261101-EEEEEE")),
				readme(HOME(), "QEST-20261101-CCCCCC").includes("realm:"),
				again.realms.map((r) => r.stamped),
			],
			"stamped by folder, updated kept, closed left, nothing the second time",
		).toEqual([true, true, true, false, [0, 0]]);
	});
});
