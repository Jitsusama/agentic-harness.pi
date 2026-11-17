/**
 * A peer as an orchestrator, or as a session one leads: what it is told
 * as its sessions find, land and end, what keeps it from parking, and
 * what wakes it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GLANCE } from "../../../extensions/mesh-workflow/delivery.ts";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import { SESSION_ON_NO_MODEL } from "../../../lib/internal/session/no-model.ts";
import { PARK_ASK } from "../../../lib/internal/session/park.ts";
import { WAKERS_ASK } from "../../../lib/internal/session/wakers.ts";
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

/**
 * This peer as the orchestrator of its quest, 7M6JKG, with 85PKB2 a
 * session it leads, in the state given.
 */
function leading(state: "listening" | "parked" = "listening") {
	orchestratingQuest();
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		session: "session-l",
		addresses: ["85PKB2"],
		groups: ["#orchestration/7m6jkg"],
		orchestratedBy: "7M6JKG",
		state,
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

/** The fixture's quest, 7M6JKG, made one that orchestrates the quests below it. */
function orchestratingQuest() {
	onQuest();
	writeFileSync(
		join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
		"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-7M6JKG\n",
	);
}

describe("an orchestrator", () => {
	it("tells the orchestrator when a quest or document ends", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		const { emit } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		emit(QUEST_CONCLUDED, {
			how: "concluded",
			ids: ["PLAN-20261021-AAAAAA"],
			said: "Now concluded on plan PLAN-20261021-AAAAAA (The Plan).",
		});

		const told = transport.read(transport.ids().at(-1) ?? "");
		expect(told).toMatchObject({ to: ["@5GV2AH"], intent: "fyi" });
		expect(told?.text).toContain("PLAN-20261021-AAAAAA concluded");
		expect(told?.text).toContain("(The Plan)");
	});

	it("tells an orchestrator nothing once it has stopped this peer", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-o",
			addresses: ["5GV2AH"],
			groups: ["#orchestration/5gv2ah"],
			stops: [{ address: "7M6JKG", at: new Date().toISOString() }],
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
		const { emit } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		emit(QUEST_CONCLUDED, { how: "concluded", ids: ["X"], said: "Done." });

		expect(transport.ids()).toEqual([]);
	});

	it("glances, as an orchestrator, at an fyi naming what its sender's presence says it landed", async () => {
		orchestratingQuest();
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-l",
			addresses: ["85PKB2"],
			groups: ["#orchestration/7m6jkg"],
			landings: [
				{
					at: new Date().toISOString(),
					ref: "agentic-harness.pi#920",
					what: "Carry Background Jobs Across a Rollover",
				},
			],
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
		const { sent, entries } = await startSession();

		fromElsewhere({ to: ["@7M6JKG"], from: "85PKB2", text: "#920 is merged." });
		fromElsewhere({ to: ["@7M6JKG"], from: "85PKB2", text: "#921 is merged." });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(JSON.stringify(sent[0]?.message.content)).toContain("#921");
		expect(entries.find((entry) => entry.type === GLANCE)).toMatchObject({
			data: {
				message: { text: "#920 is merged." },
				why: "status its sender's presence already carries",
			},
		});
	});

	it("takes one turn, as an idle orchestrator, for a burst of what its sessions find and land", async () => {
		leading();
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ to: ["@7M6JKG"], from: "85PKB2", text: "#920 is merged." });
		fromElsewhere({
			to: ["@7M6JKG"],
			from: "85PKB2",
			intent: "finding",
			text: "the launcher drops a landing's url",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.message.content).toContain("#920");
		expect(sent[0]?.message.content).toContain("landing's url");
	});

	it("starts no turn for a finding from a session it does not lead", async () => {
		leading();
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({
			to: ["@7M6JKG"],
			from: "4UHC5Q",
			intent: "finding",
			text: "your node socket moved",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
	});

	it("refuses, as an orchestrator, to park while a session it leads is at work", async () => {
		leading();
		const { emit } = await startSession();
		const ask = { session, refusals: [] as string[] };

		emit(PARK_ASK, ask);
		expect(ask.refusals).toEqual(["sessions it leads are at work (85PKB2)"]);

		leading("parked");
		const later = { session, refusals: [] as string[] };
		emit(PARK_ASK, later);
		expect(later.refusals).toEqual([]);
	});

	// WCJQSG, 11 November [0de9accb]: an orchestrator of thirty sessions
	// is never without one at work, so it never took a new install.
	it("lets an orchestrator start again in place while sessions it leads work", async () => {
		leading();
		const { emit } = await startSession();
		const ask = { session, refusals: [] as string[], restart: true };

		emit(PARK_ASK, ask);
		expect(ask.refusals, "a restart loses none of their findings").toEqual([]);
	});

	// The same evening it named RCTRF8 twice, one of its two sessions long
	// crashed, and 6TMMZY, a quest concluded before that morning's boot.
	it("names only the sessions it leads that still run, each once", async () => {
		leading();
		const publish = (name: string, ended: boolean) =>
			createPresences(join(fixture.paths.mesh, "presence")).publish({
				session: name,
				addresses: [ended ? "6TMMZY" : "85PKB2"],
				groups: ["#orchestration/7m6jkg"],
				orchestratedBy: "7M6JKG",
				state: "listening",
				worksOn: "",
				owns: [],
				busy: false,
				at: new Date().toISOString(),
				...(ended ? { owner: { pid: process.pid, startedAt: 1 } } : {}),
			});
		publish("session-l2", false);
		publish("session-gone", true);
		const { emit } = await startSession();
		const ask = { session, refusals: [] as string[] };

		emit(PARK_ASK, ask);
		expect(ask.refusals, "one live address, named once").toEqual([
			"sessions it leads are at work (85PKB2)",
		]);
	});

	it("names, as an orchestrator, the sessions it leads at work as what will wake it", async () => {
		leading();
		const { emit } = await startSession();
		const ask = { session, wakers: [] as string[] };

		emit(WAKERS_ASK, ask);
		expect(ask.wakers).toEqual(["sessions it leads are at work (85PKB2)"]);
	});

	it("tells the orchestrator once, as a finding, when its session is on no model", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		const lost = {
			when: "start",
			model: "proxied/faux-1",
			why: "its provider has no auth configured",
		};
		const { emit } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			(early) => early(SESSION_ON_NO_MODEL, lost),
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		emit(SESSION_ON_NO_MODEL, { ...lost, when: "before a turn" });

		expect(transport.ids()).toHaveLength(1);
		const told = transport.read(transport.ids()[0] ?? "");
		expect(told).toMatchObject({ to: ["@5GV2AH"], intent: "finding" });
		expect(told?.text).toContain("on no model");
		expect(told?.text).toContain(
			"proxied/faux-1, which can't be set back: its provider has no auth configured.",
		);
	});

	it("tells nobody a session is on no model when no orchestrator is above its quest", async () => {
		onQuest();
		const { emit } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		emit(SESSION_ON_NO_MODEL, { when: "before a turn" });

		expect(transport.ids()).toEqual([]);
	});

	// The miss of 16 November at 22:26: the person said "I want it
	// posted", and the review cell was told to post no approval or block,
	// which he never asked (unasked-limits.ts).
	it("refuses a pivot or question narrowing a verdict the person didn't limit, until it says whose limit it is", async () => {
		leading();
		const { tools } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const unasked =
			"Post it in Joel's name. Post no approval or block that Joel didn't ask for: a comment review.";

		for (const intent of ["pivot", "question"]) {
			expect(await send(tools, "85PKB2", intent, unasked), intent).toContain(
				"Not sent: this limits a verdict the person didn't ask to limit (\"Post no approval or block that Joel didn't ask for: a comment review.\")",
			);
		}
		expect(transport.ids()).toEqual([]);

		await send(
			tools,
			"85PKB2",
			"pivot",
			"Post it in Joel's name, approving or blocking as it deserves.",
		);
		await send(
			tools,
			"85PKB2",
			"pivot",
			'Post no approval: Joel said "a comment only on this one".',
		);
		await send(tools, "85PKB2", "fyi", unasked);
		expect(transport.ids()).toHaveLength(3);
	});

	it("lets a led session's question limit a verdict, which is no orchestrator's order", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-o", ["5GV2AH"], []);
		const { tools } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		await send(
			tools,
			"orchestrator",
			"question",
			"Shall I post no approval, only a comment?",
		);

		expect(transport.ids()).toHaveLength(1);
	});

	it("tells nobody of an ending when no orchestrator is above the quest", async () => {
		onQuest();
		const { emit } = await startSession();
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));

		emit(QUEST_CONCLUDED, { how: "retired", ids: ["X"], said: "Retired." });

		expect(transport.ids()).toEqual([]);
	});
});
