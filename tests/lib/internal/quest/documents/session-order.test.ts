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
 * orders them, so an order no code makes is written alike too.
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

	it("is written in the order every build writes", () => {
		// Builds on different machines share the README, so this order is
		// what they agree on: changing it brings the churn back while
		// machines run builds either side of the change.
		const text = serializeQuestFrontMatter(questWith([attached]));

		expect(
			text.slice(text.indexOf("sessions:")),
			"a session is written in the order every machine writes it",
		).toBe(
			[
				"sessions:",
				"  - id: s1",
				"    cwd: /home/joel/src",
				"    status: active",
				"    instanceId: i1",
				"    process:",
				"      hostId: optimus",
				"      pid: 953146",
				"      startToken: Sun Nov 22 22:02:03 2026",
				"      bootToken: 34c96fb4",
				"      startTicks: 12928447",
				"      hosted:",
				"        host: work-background",
				"        session: s1",
				"        owner:",
				"          pid: 953146",
				"          startedAt: 1795402923470",
				"          bootId: 34c96fb4",
				"          startTicks: 12928447",
				"    terminal:",
				"      driverId: kitty",
				'      value: "7"',
				"      scope: s",
				"      hostId: optimus",
				"---",
			].join("\n"),
		);
	});

	it("keeps fields it doesn't know, after the known ones, by name", () => {
		// Another build may stamp a hosted process or its owner with more
		// than this one knows; both are read whole, so those fields come back.
		const written = serializeQuestFrontMatter(questWith([attached]))
			.replace("        owner:\n", "        zeta: z\n        owner:\n")
			.replace(
				"startTicks: 12928447\n    terminal:",
				"startTicks: 12928447\n          zulu: z\n          alpha: a\n    terminal:",
			);
		expect(written, "the fixture took the later fields").toContain("zeta: z");
		expect(written, "the fixture's owner took them too").toContain("zulu: z");
		const parsed = parseQuestFrontMatter(`${written}\n# A quest\n`);
		if (!parsed) throw new Error("the README reads back");

		const again = serializeQuestFrontMatter(parsed.frontMatter);

		expect(
			keysAt(again, "      hosted:", 8),
			"a hosted process's unknown field follows its known ones",
		).toEqual(["host", "session", "owner", "zeta"]);
		expect(
			keysAt(again, "        owner:", 10),
			"an owner's unknown fields follow its known ones, by name",
		).toEqual(["pid", "startedAt", "bootId", "startTicks", "alpha", "zulu"]);
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
			again,
			"the key is written back as a key, not lost to a prototype",
		).toContain("polluted: yes");
		const owner = parseQuestFrontMatter(`${again}\n# A quest\n`)?.frontMatter
			.sessions[0]?.process?.hosted?.owner;
		if (!owner) throw new Error("the rewritten README reads back");
		expect(
			Object.hasOwn(owner, "__proto__"),
			"the owner read back holds __proto__ as its own key",
		).toBe(true);
		expect(
			Object.getPrototypeOf(owner),
			"the owner read back keeps an ordinary prototype",
		).toBe(Object.prototype);
	});
});

/**
 * The keys of the map under the line `heading` in `text`, written at
 * `indent` spaces, in the order they are written.
 */
function keysAt(text: string, heading: string, indent: number): string[] {
	const lines = text.slice(text.indexOf(heading) + heading.length).split("\n");
	const keys: string[] = [];
	for (const line of lines.slice(1)) {
		const depth = line.length - line.trimStart().length;
		if (depth < indent) break;
		if (depth === indent) keys.push(line.trim().split(":")[0] ?? "");
	}
	return keys;
}
