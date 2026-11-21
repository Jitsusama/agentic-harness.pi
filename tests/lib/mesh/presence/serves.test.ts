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
const NEED = "IKQ63G/mi8z0a1.0123456789ab";
const readme = (extra = "", status = "active") =>
	`---\nid: ${LOOP}\nkind: quest\nparent: null\nstatus: ${status}\npriority: active\nrank: 1\nstarted: 2026-11-21\nupdated: 2026-11-21\n${extra}---\n# ${LOOP}\n`;
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
	`    id: ${NEED}`,
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
				id: NEED,
			},
		]);
	});

	it("says none while its quest is sealed, since it serves nobody now", () => {
		write(readme(TAKEN, "concluded"));
		localPeer(surroundingsAt(root));

		expect(kept(), "a presence was written").toBeDefined();
		expect(kept()?.serves, "a sealed quest serves none").toBeUndefined();
	});

	it("says none in an ended session's last word", () => {
		write(readme(TAKEN));
		const peer = localPeer(surroundingsAt(root));
		peer.end();

		expect(kept(), "the last word says it ended").toHaveProperty("ended");
		expect(kept()?.serves, "an ended session serves none").toBeUndefined();
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
				id: NEED,
			},
		]);
	});

	it("reads another peer's serves as the node would, passing over what it would", () => {
		write(readme());
		localPeer(surroundingsAt(root));
		const other = "another-session";
		writeFileSync(
			join(root, "presence", `${other}.json`),
			JSON.stringify({
				...kept(),
				session: other,
				serves: [
					{ cell: "a cell", need: "spaced", since: "2026-11-21T11:00:00Z" },
					{ cell: "TERN02", need: "undated", since: "today" },
					"not an entry",
					{
						cell: "TERN02",
						need: "another's id",
						since: "2026-11-21T11:00:00Z",
						id: NEED,
					},
				],
			}),
		);

		const read = createPresences(join(root, "presence"))
			.all()
			.find((one) => one.session === other);
		expect(read, "the other peer is read").toBeDefined();
		expect(
			read?.serves,
			"only the entry the node would read, its foreign id left off",
		).toEqual([
			{
				cell: "TERN02",
				need: "another's id",
				since: "2026-11-21T11:00:00.000Z",
			},
		]);
	});
});
