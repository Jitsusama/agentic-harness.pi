/**
 * This session's peer says the cell its quest's work split from, as
 * mycelium's node reads a cell's `lineage.split_from`, so the map draws
 * the split from the cell that sprouted it.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateQuestFrontMatter } from "../../../../lib/internal/quest/fields/mutate.ts";
import { questAddress, sessionAddress } from "../../../../lib/mesh/address.ts";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { presence, session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-lineage-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const LOOP = "QEST-20261124-SPLITQ";
const readme = (extra = "", status = "active") =>
	`---\nid: ${LOOP}\nkind: quest\nparent: null\nstatus: ${status}\npriority: active\nrank: 1\nstarted: 2026-11-24\nupdated: 2026-11-24\n${extra}---\n# ${LOOP}\n`;
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
const kept = (): { lineage?: unknown } | undefined => {
	try {
		return JSON.parse(
			readFileSync(join(root, "presence", `${session}.json`), "utf8"),
		);
	} catch {
		return undefined;
	}
};

describe("the cell this session's peer says its work split from", () => {
	it("says the cell its quest split from, in the node's own names", () => {
		write(readme("split-from: TERN02\n"));
		localPeer(surroundingsAt(root));

		expect(kept()?.lineage, "as the node reads lineage").toEqual({
			split_from: "TERN02",
		});
	});

	it("still says it once its quest is sealed, since where work came from stays true", () => {
		write(readme("split-from: TERN02\n", "concluded"));
		localPeer(surroundingsAt(root));

		expect(kept()?.lineage).toEqual({ split_from: "TERN02" });
	});

	it("still says it in an ended session's last word", () => {
		write(readme("split-from: TERN02\n"));
		const peer = localPeer(surroundingsAt(root));
		peer.end();

		expect(kept(), "the last word says it ended").toHaveProperty("ended");
		expect(kept()?.lineage).toEqual({ split_from: "TERN02" });
	});

	it("says none while its quest split from no cell", () => {
		write(readme());
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.lineage, "no lineage at all").toBeUndefined();
	});

	it("says none where its quest split from this very cell, which never split from itself", () => {
		write(readme(`split-from: ${sessionAddress(session)}\n`));
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.lineage, "no lineage naming itself").toBeUndefined();
	});

	// The asking cell asked under its old quest's address, then loaded the
	// quest it sprouted; it still answers to the old one.
	it("says none where its quest split from an older quest's address it answers to", () => {
		const old = "QEST-20261123-ASKERQ";
		mkdirSync(join(root, "quests", old), { recursive: true });
		writeFileSync(
			join(root, "quests", old, "README.md"),
			`---\nid: ${old}\nstatus: active\n---\n# ${old}\n\n- ${session}\n`,
		);
		write(readme(`split-from: ${questAddress(old)}\n`));
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.lineage, "no lineage naming its old quest").toBeUndefined();
	});

	// The usual order: the session began on no quest, loaded one and
	// asked under it, then loaded the quest it sprouted; that old quest
	// listed it only after its peer began.
	it("says none where its quest split from a quest it loaded after it began", () => {
		write(readme());
		const peer = localPeer(surroundingsAt(root));

		const old = "QEST-20261123-ASKERQ";
		mkdirSync(join(root, "quests", old), { recursive: true });
		writeFileSync(
			join(root, "quests", old, "README.md"),
			`---\nid: ${old}\nstatus: active\n---\n# ${old}\n\n- ${session}\n`,
		);
		write(readme(`split-from: ${questAddress(old)}\n`));
		peer.refresh();

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.lineage, "no lineage naming its old quest").toBeUndefined();
	});

	// A reload, or a log rolled over from the session that asked: no
	// quest lists this session under the address it asked with, but its
	// own last presence still says it.
	it("says none where its quest split from an address its last presence said", () => {
		const old = questAddress("QEST-20261123-ASKERQ");
		mkdirSync(join(root, "presence"), { recursive: true });
		writeFileSync(
			join(root, "presence", `${session}.json`),
			JSON.stringify(
				presence({ session, addresses: [old], at: new Date().toISOString() }),
			),
		);
		write(readme(`split-from: ${old}\n`));
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(
			kept()?.lineage,
			"no lineage naming its old address",
		).toBeUndefined();
	});

	// A restarted peer remembers what it answered to, so it reads the
	// READMEs off the thread; every sprouted quest names a split, so the
	// split's judgement is read off it too, joining the start's reading
	// rather than sweeping the store beside it, and said once it lands.
	it("judges a split off the thread once it remembers its addresses, and takes it back once read", async () => {
		const remembered = questAddress("QEST-20261122-BEFORE");
		mkdirSync(join(root, "presence"), { recursive: true });
		writeFileSync(
			join(root, "presence", `${session}.json`),
			JSON.stringify(
				presence({
					session,
					addresses: [remembered],
					at: new Date().toISOString(),
				}),
			),
		);
		const old = "QEST-20261123-ASKERQ";
		mkdirSync(join(root, "quests", old), { recursive: true });
		writeFileSync(
			join(root, "quests", old, "README.md"),
			`---\nid: ${old}\nstatus: active\n---\n# ${old}\n\n- ${session}\n`,
		);
		write(readme(`split-from: ${questAddress(old)}\n`));
		const peer = localPeer(surroundingsAt(root));

		try {
			expect(kept()?.lineage, "no README read on the thread").toEqual({
				split_from: questAddress(old),
			});
			// The pool reads behind whatever a loaded machine has queued.
			await vi.waitFor(
				() =>
					expect(
						kept()?.lineage,
						"none once its old quest is read",
					).toBeUndefined(),
				{ timeout: 10_000 },
			);
		} finally {
			peer.dispose();
		}
	}, 15_000);

	// Its start's reading is done by then, so only the split's own
	// reading, off the thread, finds the old quest that listed it since.
	it("judges off the thread a split from a quest that listed it after it began", async () => {
		const remembered = questAddress("QEST-20261122-BEFORE");
		mkdirSync(join(root, "presence"), { recursive: true });
		writeFileSync(
			join(root, "presence", `${session}.json`),
			JSON.stringify(
				presence({
					session,
					addresses: [remembered],
					at: new Date().toISOString(),
				}),
			),
		);
		const listing = "QEST-20261121-LISTED";
		mkdirSync(join(root, "quests", listing), { recursive: true });
		writeFileSync(
			join(root, "quests", listing, "README.md"),
			`---\nid: ${listing}\nstatus: active\n---\n# ${listing}\n\n- ${session}\n`,
		);
		write(readme());
		const peer = localPeer(surroundingsAt(root));

		try {
			// The quest only the start's reading finds marks its end.
			await vi.waitFor(
				() => expect(peer.addresses).toContain(questAddress(listing)),
				{ timeout: 10_000 },
			);
			const old = "QEST-20261123-ASKERQ";
			mkdirSync(join(root, "quests", old), { recursive: true });
			writeFileSync(
				join(root, "quests", old, "README.md"),
				`---\nid: ${old}\nstatus: active\n---\n# ${old}\n\n- ${session}\n`,
			);
			write(readme(`split-from: ${questAddress(old)}\n`));
			peer.refresh();

			expect(kept()?.lineage, "no README read on the thread").toEqual({
				split_from: questAddress(old),
			});
			await vi.waitFor(
				() =>
					expect(
						kept()?.lineage,
						"none once its old quest is read",
					).toBeUndefined(),
				{ timeout: 10_000 },
			);
		} finally {
			peer.dispose();
		}
	}, 25_000);

	// A reading that took back every split would pass the two above.
	it("keeps saying a split from another cell once the readings land", async () => {
		const remembered = questAddress("QEST-20261122-BEFORE");
		mkdirSync(join(root, "presence"), { recursive: true });
		writeFileSync(
			join(root, "presence", `${session}.json`),
			JSON.stringify(
				presence({
					session,
					addresses: [remembered],
					at: new Date().toISOString(),
				}),
			),
		);
		const listing = "QEST-20261121-LISTED";
		mkdirSync(join(root, "quests", listing), { recursive: true });
		writeFileSync(
			join(root, "quests", listing, "README.md"),
			`---\nid: ${listing}\nstatus: active\n---\n# ${listing}\n\n- ${session}\n`,
		);
		write(readme("split-from: TERN02\n"));
		const peer = localPeer(surroundingsAt(root));

		try {
			await vi.waitFor(
				() => expect(peer.addresses).toContain(questAddress(listing)),
				{ timeout: 10_000 },
			);
			peer.refresh();

			expect(kept()?.lineage, "still the split from TERN02").toEqual({
				split_from: "TERN02",
			});
		} finally {
			peer.dispose();
		}
	}, 15_000);

	// A session's address is hex, so it can be all digits, which YAML
	// would read back as a number were it written bare.
	it("says a split from an all-digit address, written and read as the start does", () => {
		write(readme());
		mutateQuestFrontMatter(join(root, "quests", LOOP), (fm) => ({
			...fm,
			_extra: { ...fm._extra, "split-from": "01928374" },
		}));
		localPeer(surroundingsAt(root));

		expect(kept()?.lineage).toEqual({ split_from: "01928374" });
	});

	it("says none where its quest names this cell in other letters", () => {
		write(readme(`split-from: ${sessionAddress(session).toLowerCase()}\n`));
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.lineage, "no lineage naming itself").toBeUndefined();
	});

	it("says a split written after it began at its next refresh, and none once it's gone", () => {
		write(readme());
		const peer = localPeer(surroundingsAt(root));
		expect(kept()?.lineage, "none before the sprout wrote it").toBeUndefined();

		write(readme("split-from: TERN02\n"));
		peer.refresh();
		expect(kept()?.lineage).toEqual({ split_from: "TERN02" });

		write(readme());
		peer.refresh();
		expect(
			kept()?.lineage,
			"cleared once the README says none",
		).toBeUndefined();
	});

	it("says none for a split naming no cell by address", () => {
		write(readme("split-from: not an address\n"));
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.lineage, "the node would read none").toBeUndefined();
	});

	it("reads back another peer's lineage as the node would, passing over what it would", () => {
		write(readme("split-from: TERN02\n"));
		localPeer(surroundingsAt(root));
		const said = (session: string, lineage: unknown) =>
			writeFileSync(
				join(root, "presence", `${session}.json`),
				JSON.stringify({ ...kept(), session, lineage }),
			);
		said("from-a-cell", { split_from: "OSPREY" });
		said("from-no-address", { split_from: "a cell" });
		said("from-no-record", "OSPREY");

		const read = new Map(
			createPresences(join(root, "presence"))
				.all()
				.map((one) => [one.session, one.lineage]),
		);
		expect(read.get(session), "its own, read back").toEqual({
			split_from: "TERN02",
		});
		expect(
			["from-a-cell", "from-no-address", "from-no-record"].filter(
				(one) => !read.has(one),
			),
			"each peer is read, only its lineage passed over",
		).toEqual([]);
		expect(read.get("from-a-cell")).toEqual({ split_from: "OSPREY" });
		expect(read.get("from-no-address")).toBeUndefined();
		expect(read.get("from-no-record")).toBeUndefined();
	});
});
