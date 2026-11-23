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

/**
 * The same session with its process ordered as a read builds it, hosted
 * ahead of the boot, and its owner and terminal reversed, as no builder
 * orders them, so any order at all is seen written alike.
 */
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

	it("keeps an owner's fields it doesn't know, after the known ones, by name", () => {
		// Another build may stamp an owner with more than this one knows;
		// a hosted process is read whole, so those fields come back.
		const written = serializeQuestFrontMatter(questWith([attached])).replace(
			"startTicks: 12928447\n    terminal:",
			"startTicks: 12928447\n          zulu: z\n          alpha: a\n    terminal:",
		);
		expect(written, "the fixture's owner took the later fields").toContain(
			"zulu: z",
		);
		const parsed = parseQuestFrontMatter(`${written}\n# A quest\n`);
		if (!parsed) throw new Error("the README reads back");

		const again = serializeQuestFrontMatter(parsed.frontMatter);

		const at = (word: string): number => again.indexOf(word);
		expect(at("alpha: a"), "an unknown owner field is kept").toBeGreaterThan(
			at("bootId:"),
		);
		expect(
			at("zulu: z"),
			"unknown fields follow one another by name",
		).toBeGreaterThan(at("alpha: a"));
	});

	it("writes a __proto__ key read from a README as a key", () => {
		// A README is shared, so what it holds is another machine's words;
		// one naming __proto__ must not reach the prototype of what's written.
		const written = serializeQuestFrontMatter(questWith([attached])).replace(
			"startTicks: 12928447\n    terminal:",
			"startTicks: 12928447\n          __proto__:\n            polluted: yes\n    terminal:",
		);
		expect(written, "the fixture's owner took the key").toContain(
			"polluted: yes",
		);
		const parsed = parseQuestFrontMatter(`${written}\n# A quest\n`);
		if (!parsed) throw new Error("the README reads back");

		const again = serializeQuestFrontMatter(parsed.frontMatter);

		expect(
			Object.hasOwn(Object.prototype, "polluted"),
			"nothing reached Object's prototype",
		).toBe(false);
		expect(
			again,
			"the key is written back as a key, not lost to a prototype",
		).toContain("polluted: yes");
	});
});
