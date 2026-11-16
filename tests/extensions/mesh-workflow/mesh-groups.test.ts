/**
 * Groups: joining, leaving and listing them with who is in each, the
 * scopes a peer hears, the groups it joins by writing to them, and an
 * invitation into one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeRefusedWake } from "../../../lib/internal/session/refused-wake.ts";
import { clock } from "../../../lib/mesh/message.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	onQuest,
	peer,
	send,
	session,
	startSession,
} from "./support/mesh.ts";

describe("groups", () => {
	it("hears a group it joined, and the groups it is part of, and no other", async () => {
		const { sent, tools } = await startSession();
		await tools
			.get("mesh_join")
			?.execute("call-1", { group: "#optimus/power" });

		fromElsewhere({ to: ["#skynet"], text: "not yours" });
		fromElsewhere({ to: ["#optimus"], text: "the whole" });
		fromElsewhere({ to: ["#optimus/power"], text: "the part" });

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		const all = sent.map((one) => one.message.content).join("\n");
		expect(all).toContain("the whole");
		expect(all).toContain("the part");
		expect(all).not.toContain("not yours");
	});

	it("keeps what it joined across a reload", async () => {
		const first = await startSession();
		await first.tools
			.get("mesh_join")
			?.execute("call-1", { group: "#harness" });

		const again = await startSession();
		fromElsewhere({ to: ["#harness"], text: "for the harness" });

		await vi.waitFor(() =>
			expect(again.sent.map((one) => one.message.content)).toContainEqual(
				expect.stringContaining("for the harness"),
			),
		);
	});

	it("says on joining a group what was said there lately", async () => {
		for (let n = 0; n < 12; n += 1) {
			fromElsewhere({ to: ["#harness"], text: `harness ${n}` });
		}
		fromElsewhere({ to: ["#stick"], text: "elsewhere" });
		const { tools } = await startSession();

		const joined = await tools
			.get("mesh_join")
			?.execute("call-1", { group: "#harness" });
		const again = await tools
			.get("mesh_join")
			?.execute("call-2", { group: "#harness" });

		const text = joined?.content[0]?.text ?? "";
		const lately = text.split("Said in #harness lately, oldest first")[1] ?? "";
		const said = lately.split("\n").slice(1);
		expect(said).toHaveLength(10);
		expect(said.filter((one) => !one.includes("#harness"))).toEqual([]);
		expect(lately).not.toContain("elsewhere");
		expect(again?.content[0]?.text ?? "").not.toContain("Said in");
	});

	it("stops hearing a group it left", async () => {
		const { sent, tools } = await startSession();
		await tools.get("mesh_join")?.execute("call-1", { group: "#harness" });
		await tools.get("mesh_leave")?.execute("call-2", { group: "#harness" });

		fromElsewhere({ to: ["#harness"], text: "gone" });
		fromElsewhere({ to: ["@7M6JKG"], text: "still here" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("still here");
	});

	it("follows another peer by joining its home group", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { sent, tools } = await startSession();
		await tools.get("mesh_join")?.execute("call-1", { group: "p9r1ki" });

		fromElsewhere({ to: ["@P9R1KI"], text: "to P9R1KI" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
	});

	it("lists the groups and who is in them", async () => {
		peer("session-p", ["P9R1KI"], ["#optimus/power"]);
		const { tools } = await startSession();
		await tools.get("mesh_join")?.execute("call-1", { group: "harness" });

		const listed = await tools.get("mesh_groups")?.execute("call-2", {});

		const text = listed?.content[0]?.text ?? "";
		expect(text).toContain(
			"This peer has joined #harness; it is also in its home group and #machine.",
		);
		expect(text).toContain("#harness: 7M6JKG");
		expect(text).toContain("#optimus/power: P9R1KI");
	});

	it("says which peers are waiting on their person, and for what", async () => {
		// Today, so the listing gives the time alone: a fixed day began
		// failing the moment it was no longer today, as the listing then
		// names the day too.
		const since = new Date().toISOString();
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		const waiting = (session: string, address: string, ended: boolean) =>
			presences.publish({
				session,
				addresses: [address],
				groups: ["#optimus"],
				worksOn: "",
				owns: [],
				busy: false,
				wants: {
					id: `approval@${since}`,
					kind: "approval",
					since,
					said: "Push to main?",
				},
				...(ended ? { owner: { pid: process.pid, startedAt: 1 } } : {}),
				at: new Date().toISOString(),
			});
		waiting("session-w", "WCJQSG", false);
		waiting("session-p", "P9R1KI", true);
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-1", {});

		const text = listed?.content[0]?.text ?? "";
		const at = new Date(since).toTimeString().slice(0, 5);
		expect(text).toContain(
			`Waiting on their person:\nWCJQSG: held at an approval since ${at}: Push to main?`,
		);
		expect(text).not.toContain("P9R1KI: held");

		const sentTo = async (to: string) =>
			(
				await tools
					.get("mesh_send")
					?.execute("call-s", { to, intent: "question", text: "which qemu?" })
			)?.content[0]?.text ?? "";
		expect(await sentTo("WCJQSG")).toContain(
			`WCJQSG (held at an approval since ${at}) is waiting on its person, so it may be slow to take this up.`,
		);
		expect(await sentTo("#optimus")).not.toContain("waiting on");
	});

	it("says a parked peer's host refused its last wake, and why, wherever it is named", async () => {
		// A day gone by, so each says its date and time whenever this runs.
		const refusedAt = "2026-11-01T12:00:00.000Z";
		const at = clock({ at: refusedAt });
		const wake = join(fixture.paths.mesh, "parked-r", "wake");
		mkdirSync(join(fixture.paths.mesh, "parked-r"), { recursive: true });
		writeRefusedWake(wake, {
			messageId: "2f95756a",
			reason: "the host is stopping",
			at: refusedAt,
		});
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-r",
			addresses: ["REFUSD"],
			groups: ["#optimus"],
			state: "parked",
			wake,
			worksOn: "the launcher",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
		const { tools } = await startSession();

		const sent = await send(tools, "REFUSD", "question", "Which qemu?");
		expect(sent, "the send says it").toContain(
			`REFUSD is parked, and its host refused its last wake at ${at}: the host is stopping. If that still holds, it reads this at its next start.`,
		);

		const listed =
			(await tools.get("mesh_groups")?.execute("call-g", {}))?.content[0]
				?.text ?? "";
		expect(listed, "mesh_groups names it parked").toContain(
			"REFUSD, parked: the launcher",
		);
		expect(listed, "mesh_groups says why it sleeps on").toContain(
			`Parked, their last wake refused:\nREFUSD at ${at}: the host is stopping.`,
		);

		const open =
			(await tools.get("mesh_read")?.execute("call-u", { unanswered: true }))
				?.content[0]?.text ?? "";
		expect(open, "the unanswered list says it").toContain(
			`waiting on REFUSD (parked, its last wake refused at ${at}): Which qemu?`,
		);
	});

	it("says an fyi or finding to an idle peer starts no turn, and what would", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		const publish = (
			session: string,
			address: string,
			busy: boolean,
			orchestratedBy?: string,
		) =>
			presences.publish({
				session,
				addresses: [address],
				groups: [],
				worksOn: "",
				owns: [],
				busy,
				...(orchestratedBy ? { orchestratedBy } : {}),
				at: new Date().toISOString(),
			});
		publish("session-i", "Q1IDLE", false);
		publish("session-b", "Q2BUSY", true);
		publish("session-o", "5GV2AH", false);
		publish("session-l", "Q3LED", false, "7M6JKG");
		const { tools } = await startSession();
		const idle = "is idle, and an fyi starts no turn";

		expect(await send(tools, "Q1IDLE", "fyi", "Merged.")).toContain(
			"Q1IDLE is idle, and an fyi starts no turn, so it reads this only when something else starts its next. Send a question if it should act on it now.",
		);
		expect(await send(tools, "Q1IDLE", "finding", "Broken.")).toContain(
			"Q1IDLE is idle, and a finding starts no turn",
		);
		expect(await send(tools, "Q3LED", "fyi", "Go on.")).toContain(
			"Send a question or a pivot if it should act on it now.",
		);
		expect(await send(tools, "Q1IDLE", "question", "Which?")).not.toContain(
			"starts no turn",
		);
		expect(await send(tools, "Q2BUSY", "fyi", "Merged.")).not.toContain(idle);
		// The orchestrator above this peer acts on what it sends, idle or not.
		expect(await send(tools, "5GV2AH", "fyi", "Landed.")).not.toContain(idle);
		// An answer to the peer's own question starts its turn, however sent.
		const asked = fromElsewhere({
			from: "Q1IDLE",
			to: ["@85PKB2"],
			intent: "question",
			text: "Does it read right?",
		});
		const answered = await tools.get("mesh_send")?.execute("call-1", {
			to: "Q1IDLE",
			intent: "fyi",
			text: "Yes.",
			re: asked.id,
		});
		expect(answered?.content[0]?.text ?? "").not.toContain(idle);
	});

	it("lists each other peer still there, whether it is in a run, and its work", async () => {
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		const publish = (
			session: string,
			address: string,
			worksOn: string,
			busy: boolean,
			ended = false,
		) =>
			presences.publish({
				session,
				addresses: [address],
				groups: [],
				worksOn,
				owns: [],
				busy,
				...(ended ? { owner: { pid: process.pid, startedAt: 1 } } : {}),
				at: new Date().toISOString(),
			});
		publish(
			"session-p",
			"P9R1KI",
			`Optimus: ${"memory floors ".repeat(10)}`,
			true,
		);
		publish("session-w", "WCJQSG", "the  launcher", false);
		publish("session-e", "ENDEDP", "gone", false, true);
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-1", {});

		const text = listed?.content[0]?.text ?? "";
		const lines = text.split("\nPeers:\n")[1]?.split("\n") ?? [];
		expect(lines).toEqual([
			`P9R1KI, busy: Optimus: ${"memory floors ".repeat(10).slice(0, 88)}...`,
			"WCJQSG, idle: the launcher",
		]);
	});

	it("says what a busy peer's step is once it has gone on a minute", async () => {
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		const MINUTE = 60_000;
		const HOUR = 60 * MINUTE;
		const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
		const publish = (
			address: string,
			stepDetail?: {
				kind: "tool" | "thinking" | "waiting";
				name: string;
				since: string;
			},
		) =>
			presences.publish({
				session: `session-${address}`,
				addresses: [address],
				groups: [],
				worksOn: "work",
				owns: [],
				busy: true,
				...(stepDetail ? { stepDetail: { ...stepDetail, detail: "" } } : {}),
				at: new Date().toISOString(),
			});
		publish("LOOPER", { kind: "tool", name: "codemode", since: ago(3 * HOUR) });
		publish("MULLER", { kind: "thinking", name: "", since: ago(5 * MINUTE) });
		publish("ASKING", {
			kind: "waiting",
			name: "gate",
			since: ago(2 * MINUTE),
		});
		publish("QUICKR", { kind: "tool", name: "bash", since: ago(10_000) });
		publish("OLDERP");
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-1", {});

		const text = listed?.content[0]?.text ?? "";
		const lines = text.split("\nPeers:\n")[1]?.split("\n") ?? [];
		expect([...lines].sort()).toEqual([
			"ASKING, busy, waiting on its person for 2 min: work",
			"LOOPER, busy, in codemode for 3 h: work",
			"MULLER, busy, thinking for 5 min: work",
			"OLDERP, busy: work",
			"QUICKR, busy: work",
		]);
	});

	it("leaves out a peer whose session has ended, and says so", async () => {
		peer("session-p", ["P9R1KI"], ["#optimus/power"], true);
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-1", {});

		const text = listed?.content[0]?.text ?? "";
		expect(text).not.toContain("#optimus/power: P9R1KI");
		expect(text).toContain("Ended, so left out until restored: P9R1KI.");
	});

	it("lists an ended address once, and not while a live session answers to it", async () => {
		peer("session-x-old", ["X7FXPL"], ["#optimus"], true);
		peer("session-x-new", ["X7FXPL"], ["#optimus"]);
		peer("session-p-one", ["P9R1KI"], ["#optimus/power"], true);
		peer("session-p-two", ["P9R1KI"], ["#optimus/power"], true);
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-1", {});

		const text = listed?.content[0]?.text ?? "";
		expect(text).toContain("#optimus: X7FXPL");
		expect(text).toContain("Ended, so left out until restored: P9R1KI.");
	});

	it("refuses what is not a group to join", async () => {
		const { tools } = await startSession();

		const answer = await tools
			.get("mesh_join")
			?.execute("call-1", { group: "#Not A Group" });

		expect(answer?.content[0]?.text).toContain("is not a group to join");
	});

	it("reads back only what this peer hears", async () => {
		const { tools } = await startSession();
		fromElsewhere({ to: ["@OVAE1I"], text: "someone else's" });
		fromElsewhere({ text: "everyone's" });

		const read = await tools.get("mesh_read")?.execute("call-1", {});

		const text = read?.content[0]?.text ?? "";
		expect(text).toContain("everyone's");
		expect(text).not.toContain("someone else's");
	});
});

describe("scopes", () => {
	it("hear what is sent to the quest above this peer's", async () => {
		onQuest();
		const { sent } = await startSession();

		fromElsewhere({ to: ["#quest/5gv2ah"], text: "to the whole quest" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("to the whole quest");
	});

	it("cannot be left while the work is there", async () => {
		onQuest();
		const { tools } = await startSession();

		const answer = await tools
			.get("mesh_leave")
			?.execute("call-1", { group: "#quest/5gv2ah/7m6jkg" });

		const text = answer?.content[0]?.text ?? "";
		expect(text).toContain("is one of this peer's scopes");
		expect(text).toContain("is in #quest/5gv2ah/7m6jkg by its work");
	});
});

describe("a peer reads what it writes to", () => {
	it("joins a named group it sends to", async () => {
		// Skynet's peers posted into spaces they never read.
		peer("session-p", ["P9R1KI"], ["#optimus"]);
		const { sent, tools } = await startSession();

		const answer = await send(tools, "#optimus", "question", "who has qemu?");
		fromElsewhere({ from: "P9R1KI", to: ["#optimus"], text: "I do" });

		expect(answer).toContain("This peer is in #optimus now");
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("I do");
	});

	it("joins nothing for a group it already hears, or the machine's", async () => {
		peer("session-p", ["P9R1KI"], ["#optimus"]);
		const { tools } = await startSession();
		await tools
			.get("mesh_join")
			?.execute("call-1", { group: "#optimus/power" });

		const answer = await send(tools, "#optimus, all", "fyi", "rebooting");

		expect(answer).not.toContain("now, so it hears");
	});
});

describe("an invitation", () => {
	it("brings the peers named into a group, telling them why", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		const answer = await tools.get("mesh_join")?.execute("call-1", {
			group: "#jobs",
			invite: "p9r1ki",
			why: "where heavy work is placed",
		});

		expect(answer?.content[0]?.text).toContain("In #jobs. Invited P9R1KI.");
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id = ""] = transport.ids();
		expect(transport.read(id)).toMatchObject({
			to: ["@P9R1KI"],
			invite: "#jobs",
			text: expect.stringContaining("into #jobs: where heavy work is placed"),
		});
	});

	it("puts this peer in the group when it is sent to its home", async () => {
		const { sent } = await startSession();

		fromElsewhere({
			from: "P9R1KI",
			to: ["@7M6JKG"],
			text: "P9R1KI brings this peer into #jobs.",
			invite: "#jobs",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(
			createPresences(join(fixture.paths.mesh, "presence")).of(session)?.joined,
		).toEqual(["#jobs"]);
	});

	it("is not taken from a message sent to everyone", async () => {
		const { sent } = await startSession();

		fromElsewhere({ from: "P9R1KI", text: "come along", invite: "#jobs" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(
			createPresences(join(fixture.paths.mesh, "presence")).of(session)?.joined,
		).toEqual([]);
	});
});
