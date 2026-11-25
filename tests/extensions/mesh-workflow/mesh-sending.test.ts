/**
 * Sending on the mesh: how a send is signed, where it goes and what it
 * refuses, how a message that names no group finds one, and reading
 * back what was sent. Long because its cases follow send.ts's one
 * path from `to` to a delivery, and split apart they would each build
 * the same session and quests.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NOTED } from "../../../extensions/mesh-workflow/delivery.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import { shortId } from "../../../lib/mesh/message.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	judging,
	noNode,
	onQuest,
	peer,
	send,
	session,
	startSession,
} from "./support/mesh.ts";

/** A peer signing with the fixture's quest, as it has since `since`. */
function holding(holder: string, since: string) {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		session: holder,
		addresses: ["7M6JKG"],
		signsSince: since,
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

describe("sending", () => {
	it("signs with the quest the session has loaded, and the mesh stamps it", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "p9r1ki, #optimus", "fyi", "hello");

		expect(answer).toContain("Sent as 7M6JKG");
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(id && transport.read(id)).toMatchObject({
			v: 1,
			from: "7M6JKG",
			to: ["@P9R1KI", "#optimus"],
			text: "hello",
			intent: "fyi",
			pid: process.pid,
		});
	});

	it("answers with the message's id and where it went, not its text again", async () => {
		// The sender wrote the text a moment ago, and it is still in its
		// context; said back, it cost about 830 characters a send, 9.3
		// million a day on 10 November 2026.
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		const answer = await send(
			tools,
			"p9r1ki",
			"fyi",
			"the long text the sender already holds",
		);

		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		const short = id?.slice(id.lastIndexOf("-") + 1);
		expect(answer).toContain(`[${short}] fyi from 7M6JKG to @P9R1KI.`);
		expect(answer).not.toContain("the long text the sender already holds");
	});

	it("signs as its session while another live peer has its quest, and both are told", async () => {
		// Two sessions on one quest both signed with its address, so each
		// took the other's messages for its own and heard none of them.
		peer("session-x", ["7M6JKG"], []);
		peer("session-p", ["P9R1KI"], []);
		const { sent, tools } = await startSession();

		expect(await send(tools, "p9r1ki", "fyi", "hello")).toContain(
			"Sent as 24B025FE",
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const told = transport
			.ids()
			.map((id) => transport.read(id))
			.find((one) => one?.to.includes("@7M6JKG"));
		expect(told).toMatchObject({ from: "24B025FE", intent: "fyi" });
		expect(told?.text).toContain("has quest 7M6JKG loaded too");
		expect(sent.map(({ message }) => message.content)).toContainEqual(
			expect.stringMatching(/^Another live session, 7M6JKG/),
		);

		fromElsewhere({ from: "7M6JKG", to: ["@24B025FE"], text: "which part?" });
		await vi.waitFor(() =>
			expect(sent.map(({ message }) => message.content)).toContainEqual(
				expect.stringContaining("which part?"),
			),
		);
	});

	it("does not tell the peer holding its quest again after a reload", async () => {
		peer("session-x", ["7M6JKG"], []);
		const said = {
			type: "custom_message",
			customType: NOTED,
			details: { messages: [], glanced: [], leftTo: "session-x" },
		};
		const { sent } = await startSession({}, {}, [said]);

		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toHaveLength(0);
		expect(sent.map(({ message }) => message.content)).not.toContainEqual(
			expect.stringMatching(/^Another live session/),
		);
	});

	it("gives its quest's address back to a peer heard later that has held it longer", async () => {
		// On 25 November a session resumed before the holder on another
		// machine was heard, took the quest's address, and kept it once
		// the holder was heard, for having the lower session id.
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		expect(await send(tools, "p9r1ki", "fyi", "first")).toContain(
			"Sent as 7M6JKG",
		);

		holding("session-x", "2026-11-21T20:47:00.000Z");

		// Given back once the holder is counted live, at the next count.
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		await vi.waitFor(() =>
			expect(presences.of(session)?.addresses[0]).toBe("24B025FE"),
		);
		expect(await send(tools, "p9r1ki", "fyi", "second")).toContain(
			"Sent as 24B025FE",
		);
	});

	it("keeps its quest's address through its own restart, over a peer that took it since", async () => {
		holding(session, "2026-11-21T20:47:00.000Z");
		holding("session-x", "2026-11-25T13:53:49.000Z");
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		expect(await send(tools, "p9r1ki", "fyi", "hello")).toContain(
			"Sent as 7M6JKG",
		);
	});

	it("keeps its quest's address from a peer that held it and ended", async () => {
		peer("session-x", ["7M6JKG"], [], true);
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		expect(await send(tools, "p9r1ki", "fyi", "hello")).toContain(
			"Sent as 7M6JKG",
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toHaveLength(1);
	});

	it("takes its quest's address back once the peer holding it ends", async () => {
		peer("session-x", ["7M6JKG"], []);
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		expect(await send(tools, "p9r1ki", "fyi", "one")).toContain(
			"Sent as 24B025FE",
		);

		peer("session-x", ["7M6JKG"], [], true);

		// Taken back while idle, with nothing sent or heard to look again.
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		await vi.waitFor(() =>
			expect(presences.of(session)?.addresses[0]).toBe("7M6JKG"),
		);
	});

	it("says who it reaches, and which addresses nobody goes by", async () => {
		// A typo once sent a message nowhere without a word.
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "p9r1ki, p9rlki", "question", "ready?");

		expect(answer).toContain("It goes to P9R1KI;");
		expect(answer).toContain(
			"Not written to @P9RLKI: no session in this realm goes by P9RLKI",
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(id && transport.read(id)?.to).toEqual(["@P9R1KI"]);
	});

	it("refuses a send no session in this realm goes by, writing nothing", async () => {
		// On 2026-11-01 a methuselah session's findings for the work
		// realm were written where nobody reads them, and it waited on them.
		const { tools } = await startSession();

		const answer = await send(tools, "16v6f4", "finding", "the link");

		expect(answer).toContain(
			"Not sent: no session in this realm goes by 16V6F4, there or ended. Realms are kept apart",
		);
		expect(folderTransport(join(fixture.paths.mesh, "messages")).ids()).toEqual(
			[],
		);
	});

	it("still answers a message whose sender has no presence here", async () => {
		// The machine's crossing holds come from an address no session
		// here goes by, and a peer answers them once it has parked.
		const { tools } = await startSession();
		const hold = fromElsewhere({ from: "MACHINE", intent: "hold" });

		const answer = await tools
			.get("mesh_send")
			?.execute("call-1", { intent: "fyi", text: "parked", re: hold.id });

		expect(answer?.content[0]?.text).toContain("Sent as");
	});

	it("reaches a peer that once held this peer's quest", async () => {
		// Its presence still lists the address this peer signs with.
		peer("session-s", ["5GV2AH", "7M6JKG"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "all", "hold", "installing");

		expect(answer).toContain("It goes to 5GV2AH;");
	});

	// A paused presence may name no address, and still hears its groups.
	it("counts a peer it reaches that names no address, never saying it reached nobody", async () => {
		peer("session-n", [], ["#optimus"]);
		const { tools } = await startSession();

		const alone = await send(tools, "#optimus", "fyi", "built");
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		const shared = await send(tools, "#optimus", "fyi", "built again");

		expect(alone).toContain(
			"It goes to a peer naming no address; mesh_read says when each has it.",
		);
		expect(alone).not.toContain("No peer on the mesh is reached");
		expect(shared).toContain(
			"It goes to WCJQSG and a peer naming no address; mesh_read",
		);
	});

	it("says when a peer it was addressed to has ended, and reaches no one there", async () => {
		// A dead session was once sent work for six hours.
		peer("session-w", ["WCJQSG"], ["#optimus"], true);
		const { tools } = await startSession();

		const answer = await send(tools, "wcjqsg", "question", "ready?");

		expect(answer).toContain("WCJQSG has ended");
		expect(answer).toContain("No peer on the mesh is reached by it yet.");
		expect(answer).not.toContain("No peer goes by");
		const group = await send(tools, "#optimus", "hold", "hold builds");
		expect(group).toContain("Nobody else is in #optimus yet");
	});

	it("sends to a group nobody else is in, saying so", async () => {
		const { tools } = await startSession();

		const answer = await send(tools, "#skynet", "fyi", "site is up");

		expect(answer).toContain("Sent as");
		expect(answer).toContain(
			"Nobody else is in #skynet yet; mesh_read shows it to whoever joins",
		);
		expect(
			folderTransport(join(fixture.paths.mesh, "messages")).ids(),
		).toHaveLength(1);
	});

	it("sends a message opening with peers' names to them alone, not the group", async () => {
		// Seen live: questions for P9R1KI alone went to #optimus/work, and
		// three other sessions read each of them.
		peer("session-p", ["P9R1KI"], ["#optimus/work"]);
		peer("session-w", ["WCJQSG"], ["#optimus/work"]);
		const { tools } = await startSession();

		const answer = await send(
			tools,
			"#optimus/work",
			"question",
			"P9R1KI: may I write the queue?",
		);
		const unaddressed = await send(tools, "", "fyi", "@WCJQSG schema is in");

		expect(answer).toContain(
			"It opens by naming P9R1KI, so it goes to that peer alone rather than #optimus/work;",
		);
		expect(unaddressed).toContain(
			"It opens by naming WCJQSG, so it goes to that peer alone;",
		);
		const messages = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(messages.ids().map((id) => messages.read(id)?.to)).toEqual([
			["@P9R1KI"],
			["@WCJQSG"],
		]);
	});

	it("leaves an answer naming its asker where it was sent, for the group to see", async () => {
		peer("session-w", ["WCJQSG"], ["#optimus/work"]);
		const asked = fromElsewhere({
			intent: "question",
			to: ["#optimus/work"],
			text: "which file?",
		});
		const { tools } = await startSession();

		await tools.get("mesh_send")?.execute("call-1", {
			to: "#optimus/work",
			intent: "fyi",
			text: "WCJQSG: queue.json",
			re: shortId(asked),
		});

		const messages = folderTransport(join(fixture.paths.mesh, "messages"));
		const sent = messages.ids().filter((id) => id !== asked.id);
		expect(sent.map((id) => messages.read(id)?.to)).toEqual([
			["#optimus/work"],
		]);
	});

	it("reads the latest it hears, oldest first, as many as asked", async () => {
		const { tools } = await startSession();
		fromElsewhere({ text: "first" });
		fromElsewhere({ text: "second" });
		fromElsewhere({ text: "third" });
		fromElsewhere({ text: "not ours", to: ["#optimus"] });

		const read = await tools.get("mesh_read")?.execute("call-1", { count: 2 });
		const text = read?.content[0]?.text ?? "";

		expect(text).not.toContain("first");
		expect(text).not.toContain("not ours");
		expect(text.indexOf("second")).toBeGreaterThan(-1);
		expect(text.indexOf("third")).toBeGreaterThan(text.indexOf("second"));
	});

	it("keeps the newest that fit its budget, and says how to read on", async () => {
		const { tools } = await startSession();
		const sent = Array.from({ length: 10 }, (_, at) =>
			fromElsewhere({ text: `message ${at} ${"long words ".repeat(200)}` }),
		);

		const read = await tools.get("mesh_read")?.execute("call-1", {});
		const text = read?.content[0]?.text ?? "";
		const cut =
			/(\d+) older messages left out to keep this short; mesh_read with before (\w+) reads on\./.exec(
				text,
			);

		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(13_000);
		expect(text).toContain("message 9 ");
		expect(text).not.toContain("message 0 ");
		const left = Number(cut?.[1]);
		expect(cut?.[2]).toBe(sent[left]?.id.slice(-8));

		const on = await tools
			.get("mesh_read")
			?.execute("call-2", { before: cut?.[2] });
		const older = on?.content[0]?.text ?? "";
		expect(older).toContain(`message ${left - 1} `);
		expect(older).not.toContain(`message ${left} `);
	});

	it("says so when asked to read before a message nobody sent", async () => {
		const { tools } = await startSession();
		fromElsewhere({ text: "only" });

		const read = await tools
			.get("mesh_read")
			?.execute("call-1", { before: "ffffffff" });

		expect(read?.content[0]?.text).toBe(
			"No message has the id ffffffff, so there is nothing to read before it. mesh_read shows each message's id in brackets.",
		);
	});

	it("lists every question on the mesh still waiting on a peer it named", async () => {
		const { tools } = await startSession();
		peer("session-y", ["Y2YBTS"], []);
		const stuck = fromElsewhere({
			intent: "question",
			to: ["@5FWIUS", "@Y2YBTS"],
			text: "what does the disk guard say?",
		});
		fromElsewhere({
			from: "Y2YBTS",
			to: ["@WCJQSG"],
			re: stuck.id,
			text: "the launcher reads it",
		});
		const settled = fromElsewhere({
			intent: "question",
			to: ["@Y2YBTS"],
			text: "ready?",
		});
		fromElsewhere({ from: "Y2YBTS", to: ["@WCJQSG"], re: settled.id });

		const read = await tools
			.get("mesh_read")
			?.execute("call-1", { unanswered: true });
		const text = read?.content[0]?.text ?? "";

		expect(text).toMatch(
			/^1 question is waiting on an answer, oldest first:\n/,
		);
		expect(text).toContain(
			`[${stuck.id.slice(-8)}] from WCJQSG, 0 min, waiting on 5FWIUS (gone): what does the disk guard say?`,
		);
		expect(text).not.toContain("ready?");
	});

	it("reads back who has a message it sent, and who not yet", async () => {
		peer("session-p", ["P9R1KI"], ["#harness"]);
		peer("session-o", ["OVAE1I"], ["#harness"]);
		const { tools } = await startSession();
		await send(tools, "#harness", "finding", "the bridge is in");
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id = ""] = transport.ids();
		transport.markRead("P9R1KI", id);

		const read = await tools.get("mesh_read")?.execute("call-1", {});

		expect(read?.content[0]?.text).toContain(
			"the bridge is in\n  P9R1KI has it; not yet OVAE1I",
		);
	});

	it("refuses a send to an orchestrator nobody is, and drops the word beside other groups", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah/7m6jkg", "#harness"]);
		const { tools } = await startSession(noNode());
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		const refused = await send(tools, "orchestrator", "question", "May I?");
		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest",
		);
		expect(transport.ids()).toEqual([]);

		const narrowed = await send(
			tools,
			"orchestrator, #harness",
			"question",
			"Who has the stick?",
		);
		expect(transport.read(transport.ids().at(-1) ?? "")?.to).toEqual([
			"#harness",
		]);
		expect(narrowed).toContain("`orchestrator` reached nobody");
	});

	it("sends `person` to the person's steward, counting his acts as an orchestrator would", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\nsteward: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-s", ["5GV2AH"], []);
		const { tools } = await startSession(noNode());
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const asking = "May Joel touch the key at 02:00?";

		expect(await send(tools, "person", "question", asking)).toContain(
			"Not sent: this asks for the person's hands",
		);
		const sent = await send(
			tools,
			"person",
			"question",
			`${asking} His acts: 1; the fewest: 1.`,
		);

		expect(transport.ids()).toHaveLength(1);
		expect(transport.read(transport.ids()[0] ?? "")?.to).toEqual(["@5GV2AH"]);
		expect(sent).toContain(
			"`person` was read as 5GV2AH, the person's steward, which carries only what needs the person",
		);
	});

	it("reads `person` as `orchestrator` where no steward is set", async () => {
		onQuest();
		const { tools } = await startSession(noNode());

		expect(await send(tools, "person", "question", "May I?")).toContain(
			"Not sent: no orchestrator is above this peer's quest",
		);
	});

	// With a mark to another quest, nothing but the steward's own clause
	// counts a question to the steward's address as for the person's hands.
	it("counts the person's acts on a question to the steward, apart from any orchestrator", async () => {
		onQuest();
		const readme = (id: string, extra: string) =>
			`---\nid: ${id}\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n${extra}---\n# ${id}\n`;
		const write = (id: string, text: string) =>
			writeFileSync(join(fixture.paths.quests, id, "README.md"), text);
		write(
			"QEST-20261021-5GV2AH",
			readme("QEST-20261021-5GV2AH", "steward: true\n"),
		);
		mkdirSync(join(fixture.paths.quests, "QEST-20261021-0RCHST"), {
			recursive: true,
		});
		write(
			"QEST-20261021-0RCHST",
			readme("QEST-20261021-0RCHST", "orchestrator: true\n"),
		);
		write(
			"QEST-20261021-7M6JKG",
			readme(
				"QEST-20261021-7M6JKG",
				"orchestratedBy: QEST-20261021-0RCHST\n",
			).replace("parent: null", "parent: QEST-20261021-5GV2AH"),
		);
		peer("session-s", ["5GV2AH"], []);
		const { tools } = await startSession(noNode());

		expect(
			await send(
				tools,
				"person",
				"question",
				"May Joel touch the key at 02:00?",
			),
		).toContain("Not sent: this asks for the person's hands");
	});

	// The note reaches the steward only through the peer's roles, so it is
	// read off a message as delivered rather than off the note alone.
	it("names the person's steward in the note a delivered message carries", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\nsteward: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-s", ["5GV2AH"], []);
		const { sent } = await startSession();

		fromElsewhere({ intent: "hold", text: "hold heavy builds" });

		await vi.waitFor(() =>
			expect(sent.map(({ message }) => message.content)).toContainEqual(
				expect.stringContaining("hold heavy builds"),
			),
		);
		expect(sent.map(({ message }) => message.content)).toContainEqual(
			expect.stringContaining(
				"otherwise to the person's steward, 5GV2AH, as a question (mesh_send to: person)",
			),
		);
	});

	// A steward whose window closed carries nothing, so `person` falls
	// back as if none were set, rather than reaching nobody; nor does one
	// that only lists the steward's address among older ones, not signing.
	it("reads `person` as `orchestrator` while no live session signs with the steward's address", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\nsteward: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		// One that ended, and one that only ran the steward's quest earlier.
		peer("session-s", ["5GV2AH"], [], true);
		peer("session-q", ["P9R1KI", "5GV2AH"], []);
		const { tools } = await startSession(noNode());

		expect(await send(tools, "person", "question", "May I?")).toContain(
			"Not sent: no orchestrator is above this peer's quest",
		);
	});

	// The steward's own session tells the person in its reply, so the
	// word reaches nobody from it, never its orchestrator.
	it("sends nothing to `person` from the steward's own session", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
			"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: QEST-20261021-5GV2AH\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\nsteward: true\n---\n# QEST-20261021-7M6JKG\n",
		);
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-o", ["5GV2AH"], []);
		const { tools } = await startSession(noNode());
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		const alone = await send(tools, "person", "question", "May I?");
		const mixed = await send(tools, "person, #harness", "fyi", "Landed.");

		expect(
			[alone, mixed, transport.ids().map((id) => transport.read(id)?.to)],
			"refused, then only the group",
		).toEqual([
			expect.stringContaining(
				"Not sent: your quest is the person's steward, so `person` names nobody past you.",
			),
			expect.stringContaining("`person` was left out"),
			[["#harness"]],
		]);
		const unnamed = await tools
			.get("mesh_send")
			?.execute("call-2", { intent: "fyi", text: "Landed." });
		const unspaced = await send(tools, "#harness,#ops", "fyi", "Landed.");
		expect(
			[unnamed?.content[0]?.text ?? "", unspaced],
			"no `to` and one never naming `person` go as written",
		).not.toContainEqual(
			expect.stringMatching(/person's steward|`person` was left out/),
		);
		expect(unspaced, "one never naming `person` is sent").toContain("Sent as");
		expect(transport.read(transport.ids().at(-1) ?? "")?.to).toEqual([
			"#harness",
			"#ops",
		]);

		peer("session-w", ["WCJQSG"], []);
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "Landed where?",
		});
		const replied = await tools.get("mesh_send")?.execute("call-3", {
			intent: "fyi",
			re: asked.id,
			text: "On main.",
		});
		expect(replied?.content[0]?.text, "a reply naming no `to`").toContain(
			"Sent as",
		);
		const reply = transport
			.ids()
			.map((id) => transport.read(id))
			.find((one) => one?.re === asked.id);
		expect(reply?.to, "goes back to its asker").toEqual(["@WCJQSG"]);
	});

	// CADENCE's miss of 15 November [9a1c301e]: a sitting asked of the
	// person spread one paste over four approvals, uncounted.
	it("refuses a question asking the orchestrator for the person's hands until it counts his acts", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-o", ["5GV2AH"], []);
		const { tools } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const asking = "May Joel touch the key at 02:00?";

		for (const to of ["orchestrator", "5GV2AH"]) {
			expect(await send(tools, to, "question", asking), to).toContain(
				'Not sent: this asks for the person\'s hands ("May Joel touch the key at 02:00?") without a line saying "his acts: N; the fewest: M"',
			);
		}
		expect(transport.ids()).toEqual([]);

		await send(
			tools,
			"orchestrator",
			"question",
			`${asking} His acts: 1; the fewest: 1.`,
		);
		await send(tools, "orchestrator", "fyi", asking);
		expect(transport.ids()).toHaveLength(2);
	});

	// WCJQSG's miss of 16 November at 19:24: Joel was asked for an act
	// he had already done at 19:18, since nothing read the record first.
	it("refuses a question asking the orchestrator for an act its record says is done", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-o", ["5GV2AH"], []);
		const merged = new Date(Date.now() - 60_000).toISOString();
		const asked: string[][] = [];
		fixture.exec = async (command, args) => {
			asked.push([command, ...args]);
			const open = args.some((arg) => arg.includes("number: 8"));
			const pull = open
				? { reviews: { nodes: [] } }
				: { mergedAt: merged, reviews: { nodes: [] } };
			return {
				code: 0,
				stdout: JSON.stringify({
					data: {
						viewer: { login: "joel" },
						repository: { pullRequest: pull },
					},
				}),
				stderr: "",
			};
		};
		const { tools } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const asking = (number: number) =>
			`Can you ask Joel to merge https://github.com/acme/widgets/pull/${number}? His acts: 1; the fewest: 1.`;

		expect(await send(tools, "orchestrator", "question", asking(7))).toContain(
			"Not sent: already done at",
		);
		expect(transport.ids()).toEqual([]);
		expect(asked[0]?.slice(0, 3)).toEqual(["gh", "api", "graphql"]);

		await send(tools, "orchestrator", "question", asking(8));
		await send(tools, "orchestrator", "fyi", asking(7));
		expect(transport.ids()).toHaveLength(2);
	});

	it("refuses a pivot from a session that heads no orchestration", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah/7m6jkg", "#harness"]);
		const { tools } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		const refused = await send(tools, "5GV2AH", "pivot", "Drop it.");

		expect(refused).toContain("Not sent: only an orchestrator sends a pivot");
		expect(transport.ids()).toEqual([]);
	});

	it("keeps the machine's group for holds and the answers that end them", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah/7m6jkg", "#harness"]);
		const { tools } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const last = () => transport.read(transport.ids().at(-1) ?? "");

		const refused = await send(tools, "#machine", "fyi", "Going to lunch.");
		expect(refused).toContain("Not sent: #machine takes only holds");
		expect(refused).toContain("#quest/5gv2ah/7m6jkg");
		expect(transport.ids()).toEqual([]);

		const narrowed = await send(
			tools,
			"#all, #harness",
			"question",
			"Who has the stick?",
		);
		expect(last()?.to).toEqual(["#harness"]);
		expect(narrowed).toContain("Not written to #machine");

		await send(tools, "#machine", "hold", "Rebooting in ten minutes.");
		const hold = last();
		expect(hold?.to).toEqual([ALL]);
		const over = await tools.get("mesh_send")?.execute("call-9", {
			to: "#machine",
			intent: "fyi",
			text: "The reboot is done.",
			re: hold?.id.slice(-8),
			endsHold: true,
		});
		expect(over?.content[0]?.text).not.toContain("Not sent");
		expect(last()?.to).toEqual([ALL]);
	});
});

describe("a message that names no group", () => {
	const unaddressed = async (
		tools: Awaited<ReturnType<typeof startSession>>["tools"],
		intent: string,
		text: string,
		to?: string,
	) => {
		const answer = await tools
			.get("mesh_send")
			?.execute("call-1", { intent, text, ...(to ? { to } : {}) });
		const messages = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = messages.ids();
		return {
			text: answer?.content[0]?.text ?? "",
			to: id ? messages.read(id)?.to : undefined,
		};
	};

	const picking = (choice: string, sure: number) => ({
		type: "choice",
		choice,
		probabilities: { [choice]: sure },
	});

	it("goes where its words point", async () => {
		peer("session-s", ["2HN63P"], ["#stick", "#repo/core-nix"]);
		const { tools } = await startSession();

		const sent = await unaddressed(
			tools,
			"finding",
			"The stick's VM test leaves a qemu process behind.",
		);

		expect(sent.to).toEqual(["#stick"]);
		expect(sent.text).toContain(
			"It named no group, so it goes to #stick: it names #stick.",
		);
	});

	it("goes where the classifier is sure it belongs", async () => {
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		const { tools } = await startSession(
			{},
			judging(undefined, [], picking("g1", 0.95)),
		);

		const sent = await unaddressed(tools, "question", "Is it throttled?");

		expect(sent.to).toEqual(["#optimus"]);
		expect(sent.text).toContain("judged to be about the work there");
	});

	it("goes by rule when the classifier is unsure", async () => {
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		const { tools } = await startSession(
			{},
			judging(undefined, [], picking("g1", 0.5)),
		);

		const sent = await unaddressed(tools, "hold", "Rebooting soon.");

		expect(sent.to).toEqual([ALL]);
		expect(sent.text).toContain("a hold that names nowhere");
		// Anything else the rule would send to the whole machine has
		// nowhere to go from a peer with no work, and is refused.
		const told = await tools
			.get("mesh_send")
			?.execute("call-2", { intent: "fyi", text: "Going to lunch." });
		expect(told?.content[0]?.text).toContain(
			"Not sent: #machine takes only holds",
		);
	});

	it("holds the whole machine when it is a hold, and its work's groups otherwise", async () => {
		// Another peer on this peer's quest, so anything but a hold stays there.
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah/7m6jkg"]);
		const { tools } = await startSession();

		const held = await unaddressed(tools, "hold", "Rebooting in ten minutes.");
		expect(held.to).toEqual([ALL]);

		const said = await tools
			.get("mesh_send")
			?.execute("call-2", { intent: "fyi", text: "Going to lunch." });
		expect(said?.content[0]?.text).toContain(
			"It named no group, so it goes to #quest/5gv2ah/7m6jkg:",
		);
	});

	it("leaves out what cannot be a group, and goes on without it", async () => {
		peer("session-s", ["2HN63P"], ["#stick"]);
		const { tools } = await startSession();

		const sent = await unaddressed(
			tools,
			"finding",
			"The stick boots.",
			"#not a group",
		);

		expect(sent.text).toContain(
			"#not a group cannot be a group, so it was left out",
		);
		expect(sent.to).toEqual(["#stick"]);
	});
});
