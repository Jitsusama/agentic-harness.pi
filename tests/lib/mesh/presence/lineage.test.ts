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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { session, surroundingsAt } from "./support/presences.ts";

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
		expect(read.get("from-a-cell")).toEqual({ split_from: "OSPREY" });
		expect(read.get("from-no-address")).toBeUndefined();
		expect(read.get("from-no-record")).toBeUndefined();
	});
});
