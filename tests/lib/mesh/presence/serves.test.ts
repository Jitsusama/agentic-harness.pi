/**
 * This session's peer says the needs its quest took from other cells, as
 * mycelium's node reads a cell's `serves`, so its forage shows what it
 * serves: whose need, about what, since when.
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
	root = mkdtempSync(join(tmpdir(), "mesh-serves-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const LOOP = "QEST-20261121-SRVQST";
const readme = (extra = "") =>
	`---\nid: ${LOOP}\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-11-21\nupdated: 2026-11-21\n${extra}---\n# ${LOOP}\n`;
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
const kept = (): { serves?: unknown } | undefined => {
	try {
		return JSON.parse(
			readFileSync(join(root, "presence", `${session}.json`), "utf8"),
		);
	} catch {
		return undefined;
	}
};

const TAKEN = [
	"serves:",
	"  - cell: IKQ63G",
	"    need: I-5 fails at the candidate",
	"    since: 2026-11-21T11:00:00Z",
	"    id: IKQ63G/1763722800.ab12",
	"",
].join("\n");

describe("the needs this session's peer says it serves", () => {
	it("says each need its quest took, in the shape the node reads", () => {
		write(readme(TAKEN));
		localPeer(surroundingsAt(root));

		expect(kept()?.serves, "the need taken, as its README holds it").toEqual([
			{
				cell: "IKQ63G",
				need: "I-5 fails at the candidate",
				since: "2026-11-21T11:00:00.000Z",
				id: "IKQ63G/1763722800.ab12",
			},
		]);
	});

	it("says none while its quest took none", () => {
		write(readme());
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.serves, "no serves at all").toBeUndefined();
	});

	it("passes over an entry the node would, keeping the rest", () => {
		write(
			readme(
				[
					"serves:",
					"  - cell: not an address",
					"    need: anything",
					"    since: 2026-11-21T11:00:00Z",
					"  - cell: Q9",
					"    need: '   '",
					"    since: 2026-11-21T11:00:00Z",
					"  - cell: P5",
					"    need: dated at no time",
					"    since: yesterday",
					"  - cell: L26",
					"    need: leg 26 is red",
					"    since: 2026-11-21T12:00:00-05:00",
					"",
				].join("\n"),
			),
		);
		localPeer(surroundingsAt(root));

		expect(kept()?.serves, "only the well-formed entry").toEqual([
			{ cell: "L26", need: "leg 26 is red", since: "2026-11-21T17:00:00.000Z" },
		]);
	});

	it("reads back what a presence says it serves", () => {
		write(readme(TAKEN));
		localPeer(surroundingsAt(root));

		const read = createPresences(join(root, "presence"))
			.all()
			.find((one) => one.session === session);
		expect(read?.serves, "read back as said").toEqual([
			{
				cell: "IKQ63G",
				need: "I-5 fails at the candidate",
				since: "2026-11-21T11:00:00.000Z",
				id: "IKQ63G/1763722800.ab12",
			},
		]);
	});
});
