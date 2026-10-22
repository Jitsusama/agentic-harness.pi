/**
 * The legacy edge: peers on the mesh and sessions still on the old
 * mailbox hear each other, and the move from one to the other hands
 * nothing over twice.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	bridgePresences,
	bridgeTransport,
	legacyGlance,
} from "../../../lib/mesh/legacy.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let root: string;
let legacy: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-legacy-"));
	legacy = join(root, "pi-mailbox");
	mkdirSync(join(legacy, ".members"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const bridged = () =>
	bridgeTransport(folderTransport(join(root, "messages")), legacy);

/** Mail as a session on the old mailbox wrote it. */
function oldMail(file: string, over: Record<string, unknown> = {}) {
	writeFileSync(
		join(legacy, file),
		JSON.stringify({
			at: "2026-10-21T22:00:00.000Z",
			from: "P9R1KI",
			to: ["ALL", "#optimus", "LUQ49E"],
			text: "switching optimus now",
			kind: "hold",
			pid: 7,
			...over,
		}),
	);
}

describe("messages across the edge", () => {
	it("mirrors every mesh message into the old mailbox in its old shape", () => {
		const sent = bridged().send({
			from: "LUQ49E",
			to: [ALL, "@5GV2AH", "#harness"],
			intent: "question",
			text: "does reload read the mailbox?",
			pid: 3,
		});

		const mirrored = JSON.parse(
			readFileSync(join(legacy, `${sent.id}.json`), "utf8"),
		);
		expect(mirrored).toEqual({
			at: sent.at,
			from: "LUQ49E",
			to: ["ALL", "5GV2AH", "#harness"],
			text: "does reload read the mailbox?",
			kind: "question",
			pid: 3,
			mesh: sent.id,
		});
	});

	it("reads old mail as mesh messages", () => {
		oldMail("100-P9R1KI-7-aaaa.json");

		expect(bridged().read("100-P9R1KI-7-aaaa")).toMatchObject({
			id: "100-P9R1KI-7-aaaa",
			from: "P9R1KI",
			to: [ALL, "#optimus", "@LUQ49E"],
			intent: "hold",
			text: "switching optimus now",
		});
	});

	it("lists a mirrored message once", () => {
		const transport = bridged();
		const sent = transport.send({
			from: "LUQ49E",
			to: [ALL],
			intent: "fyi",
			text: "once",
			pid: 3,
		});
		oldMail("100-P9R1KI-7-aaaa.json");

		expect(transport.ids()).toEqual(["100-P9R1KI-7-aaaa", sent.id]);
	});

	it("carries over how far a peer had read the old mailbox", () => {
		// Otherwise the first reload onto the mesh hands the last hour of
		// old mail over again.
		writeFileSync(join(legacy, ".read-LUQ49E"), "300-P9R1KI-7-aaaa.json");

		const transport = bridged();
		expect(transport.lastRead(["LUQ49E"])).toBe("300-P9R1KI-7-aaaa");

		transport.markRead("LUQ49E", "400-X-1-bbbb");
		expect(transport.lastRead(["LUQ49E"])).toBe("400-X-1-bbbb");
	});

	it("shows a glance an old session recorded", () => {
		const glance = legacyGlance({
			mail: {
				at: "2026-10-21T22:00:00.000Z",
				from: "2HN63P",
				to: ["ALL"],
				text: "merging core.nix#330",
				kind: "fyi",
				pid: 1,
			},
			why: "about another session's work",
		});
		expect(glance).toMatchObject({ from: "2HN63P", to: [ALL] });
	});
});

describe("presence across the edge", () => {
	const presences = () =>
		bridgePresences(createPresences(join(root, "presence")), legacy);

	it("takes the channels an old membership listed as groups", () => {
		writeFileSync(
			join(legacy, ".members", "s-1.json"),
			JSON.stringify({
				session: "s-1",
				names: ["LUQ49E"],
				channels: ["harness"],
			}),
		);

		expect(presences().of("s-1")?.groups).toEqual(["#harness"]);
	});

	it("counts sessions still on the old mailbox as peers, once each", () => {
		writeFileSync(
			join(legacy, ".members", "s-old.json"),
			JSON.stringify({ session: "s-old", names: ["P9R1KI"], channels: [] }),
		);
		const both = presences();
		both.publish({
			session: "s-new",
			addresses: ["LUQ49E"],
			groups: ["#harness", "@P9R1KI"],
			worksOn: "",
			owns: [],
			at: "",
		});

		expect(
			both
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["s-new", "s-old"]);
	});

	it("keeps a peer's groups as an old membership, for old senders to see", () => {
		presences().publish({
			session: "s-new",
			addresses: ["LUQ49E"],
			groups: ["#harness", "@P9R1KI"],
			worksOn: "",
			owns: [],
			at: "",
		});

		expect(readdirSync(join(legacy, ".members"))).toContain("s-new.json");
		expect(
			JSON.parse(readFileSync(join(legacy, ".members", "s-new.json"), "utf8")),
		).toEqual({ session: "s-new", names: ["LUQ49E"], channels: ["harness"] });
	});
});
