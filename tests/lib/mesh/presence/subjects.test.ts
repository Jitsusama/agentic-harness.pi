/**
 * This session's peer says the subjects it works on, so mycelium's node
 * serves them on its cell and a need finds it by them: the owner lines
 * naming its address, then its quest's own list.
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
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { sessionAddress } from "../../../../lib/mesh/address.ts";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-subjects-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const LOOP = "QEST-20261025-QCXZEB";
const readme = (extra = "") =>
	`---\nid: ${LOOP}\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-25\nupdated: 2026-10-25\n${extra}---\n# ${LOOP}\n`;
const write = (text: string) => {
	mkdirSync(join(root, "quests", LOOP), { recursive: true });
	writeFileSync(join(root, "quests", LOOP, "README.md"), text);
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(
		join(root, "sessions", `${session}.json`),
		JSON.stringify({ quest: LOOP }),
	);
};
/** The presence file as the node reads it, not read back through presence. */
const kept = (): { subjects?: unknown } | undefined => {
	try {
		return JSON.parse(
			readFileSync(join(root, "presence", `${session}.json`), "utf8"),
		);
	} catch {
		return undefined;
	}
};

describe("the subjects this session's peer says", () => {
	it("says its quest's own subjects, as its README lists them", () => {
		write(readme("subjects: [needs, 'mycelium:hubs']\n"));
		localPeer(surroundingsAt(root));

		expect(kept()?.subjects).toEqual(["needs", "mycelium:hubs"]);
	});

	it("says the owner prefixes naming its address first, longest first", () => {
		write(readme("subjects: [needs]\n"));
		localPeer({
			...surroundingsAt(root),
			owners: () => [
				"health.=80ECO2",
				"health.agents.=QCXZEB",
				"unit:pi-host-=QCXZEB",
			],
		});

		expect(kept()?.subjects).toEqual([
			"health.agents.",
			"unit:pi-host-",
			"needs",
		]);
	});

	it("says an owner's prefixes with no quest loaded, by its session's own address", () => {
		mkdirSync(join(root, "sessions"), { recursive: true });
		localPeer({
			...surroundingsAt(root),
			owners: () => ["oom.=80ECO2", `pressure.=${sessionAddress(session)}`],
		});

		expect(kept()?.subjects).toEqual(["pressure."]);
	});

	it("owns nothing by an older quest's address it still answers to", () => {
		write(readme());
		const older = "QEST-20261001-OLDQST";
		mkdirSync(join(root, "quests", older), { recursive: true });
		writeFileSync(
			join(root, "quests", older, "README.md"),
			`---\nid: ${older}\n---\n# ${older}\n\n- ${session}\n`,
		);
		const peer = localPeer({
			...surroundingsAt(root),
			owners: () => ["old.=OLDQST", "loop.=QCXZEB"],
		});

		expect([peer.addresses.includes("OLDQST"), kept()?.subjects]).toEqual([
			true,
			["loop."],
		]);
	});

	it("owns nothing by its quest's address once it leaves that address to the peer signing with it", () => {
		write(readme("subjects: [needs]\n"));
		createPresences(join(root, "presence")).publish({
			session: "00-holder",
			addresses: ["QCXZEB"],
			groups: [],
			worksOn: "the loop",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
		const peer = localPeer({
			...surroundingsAt(root),
			owners: () => ["loop.=QCXZEB"],
		});

		expect([peer.yieldedTo?.session, kept()?.subjects]).toEqual([
			"00-holder",
			["needs"],
		]);
	});

	it("writes only what the node serves: twelve, plain, each once", () => {
		const owned = Array.from({ length: 4 }, (_, at) => `owned${at}.=QCXZEB`);
		const declared = [
			"owned0.",
			"zero\u200bwidth",
			...Array.from({ length: 12 }, (_, at) => `declared${at}`),
		];
		write(readme(`subjects: ${JSON.stringify(declared)}\n`));
		localPeer({ ...surroundingsAt(root), owners: () => owned });

		expect(kept()?.subjects).toEqual([
			"owned0.",
			"owned1.",
			"owned2.",
			"owned3.",
			...Array.from({ length: 8 }, (_, at) => `declared${at}`),
		]);
	});

	it("leaves the key out while it declares none", () => {
		write(readme());
		localPeer({ ...surroundingsAt(root), owners: () => ["oom.=80ECO2"] });

		expect(Object.keys(kept() ?? {})).not.toContain("subjects");
	});

	it("says what the owner lines and README say now at its next refresh", () => {
		write(readme());
		let lines: string[] = [];
		const peer = localPeer({ ...surroundingsAt(root), owners: () => lines });
		const before = kept()?.subjects;
		lines = ["switch.=QCXZEB"];
		write(readme("subjects: [needs]\n"));
		peer.refresh();

		expect([before, kept()?.subjects]).toEqual([
			undefined,
			["switch.", "needs"],
		]);
	});

	it("still says its quest's subjects after the workflow rewrites its README", () => {
		const parsed = parseQuestFrontMatter(readme("subjects: [needs, hubs]\n"));
		if (!parsed) throw new Error("the README should parse");
		write(`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`);
		localPeer(surroundingsAt(root));

		expect(kept()?.subjects).toEqual(["needs", "hubs"]);
	});

	it("reads back only the plain strings a presence on disk says", () => {
		mkdirSync(join(root, "presence"), { recursive: true });
		const presences = createPresences(join(root, "presence"));
		presences.publish({
			session: "s-1",
			addresses: ["7M6JKG"],
			groups: [],
			worksOn: "the mesh",
			owns: [],
			busy: false,
			subjects: ["needs", 7, "hubs"] as unknown as string[],
			at: "2026-11-19T07:00:00.000Z",
		});

		expect(presences.of("s-1")?.subjects).toEqual(["needs", "hubs"]);
	});
});
