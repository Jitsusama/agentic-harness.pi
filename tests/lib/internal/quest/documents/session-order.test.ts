import { describe, expect, it } from "vitest";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../../../lib/internal/quest/documents/frontmatter.ts";
import type {
	QuestFrontMatter,
	QuestSession,
} from "../../../../../lib/quest/types.ts";

/** A quest holding `sessions`, as a writer would hand it over. */
function questWith(sessions: QuestSession[]): QuestFrontMatter {
	return {
		id: "QEST-20260101-AAAAAA",
		kind: "quest",
		parent: null,
		status: "active",
		priority: "active",
		rank: 1,
		started: "2026-01-01",
		updated: "2026-01-01",
		aliases: [],
		sessions,
	};
}

const owner = {
	pid: 953_146,
	startedAt: 1_795_402_923_470,
	bootId: "34c96fb4",
	startTicks: 12_928_447,
};

/** A session as attach builds it: the boot stamped after the identity. */
const attached: QuestSession = {
	id: "s1",
	cwd: "/home/joel/src",
	status: "active",
	instanceId: "i1",
	process: {
		hostId: "optimus",
		pid: 953_146,
		startToken: "Sun Nov 22 22:02:03 2026",
		bootToken: "34c96fb4",
		startTicks: 12_928_447,
		hosted: { host: "work-background", session: "s1", owner },
	},
	terminal: { driverId: "kitty", value: "7", hostId: "optimus", scope: "s" },
};

/** The same session as a read builds it: hosted ahead of the boot. */
const reread: QuestSession = {
	id: "s1",
	cwd: "/home/joel/src",
	status: "active",
	instanceId: "i1",
	process: {
		hostId: "optimus",
		pid: 953_146,
		startToken: "Sun Nov 22 22:02:03 2026",
		hosted: {
			owner: {
				startTicks: 12_928_447,
				bootId: "34c96fb4",
				startedAt: 1_795_402_923_470,
				pid: 953_146,
			},
			session: "s1",
			host: "work-background",
		},
		bootToken: "34c96fb4",
		startTicks: 12_928_447,
	},
	terminal: { scope: "s", hostId: "optimus", value: "7", driverId: "kitty" },
};

describe("a session written into a shared quest README", () => {
	it("comes out the same whichever code built it", () => {
		// The README is shared between machines, so a rewrite that only
		// moves keys reaches the other machine as a change of its own, and
		// one there meanwhile leaves the two written apart (315D0071).
		expect(
			serializeQuestFrontMatter(questWith([reread])),
			"a session re-read and one just attached are written alike",
		).toBe(serializeQuestFrontMatter(questWith([attached])));
	});

	it("is written again unchanged once read back", () => {
		const written = `${serializeQuestFrontMatter(questWith([attached]))}\n# A quest\n`;
		const parsed = parseQuestFrontMatter(written);

		expect(parsed, "the written README reads back").toBeDefined();
		if (!parsed) return;
		expect(
			`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
			"reading and writing again changes nothing",
		).toBe(written);
	});

	it("keeps a field it doesn't know, after the ones it does", () => {
		const process = attached.process;
		if (!process) throw new Error("the fixture has a process");
		const withMore = { ...process, laterField: "kept" };
		const later: QuestSession = { ...attached, process: withMore };

		const text = serializeQuestFrontMatter(questWith([later]));

		expect(text, "the unknown field is still written").toContain(
			"laterField: kept",
		);
		expect(
			text.indexOf("laterField"),
			"the unknown field follows the known ones",
		).toBeGreaterThan(text.indexOf("hosted:"));
	});
});
