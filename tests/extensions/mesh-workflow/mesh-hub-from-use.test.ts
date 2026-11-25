/**
 * `orchestrator` on a quest with no orchestrator mark: it reaches the
 * hub from use, the live cell on a quest above this one that it talks
 * with most, and says so; with no such cell it refuses, naming
 * the quest, and never sends wider.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import { TIES_PATIENCE_MS } from "../../../lib/mesh/node.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	noNode,
	onQuest,
	send,
	session,
	startSession,
} from "./support/mesh.ts";
import { closeNodes, node, nodeAsked } from "./support/node.ts";

afterEach(closeNodes);

/** The fixture's session, 7M6JKG, as the node keeps it. */
const asker = { key: "cell:7M6JKG", title: "QEST-20261021-7M6JKG" };

/** A tie from the fixture's session to `other`, heard just now. */
const tieTo = (other: string, strength: number) => ({
	key: `tie:7M6JKG~${other}`,
	strength,
	heard: Date.now(),
	hour: [1, 1],
	today: [strength, strength],
});

/**
 * A live peer whose work puts it in these groups, as a presence written
 * today says it: none of them joined, and on its own quest when given.
 */
function cellIn(
	session: string,
	address: string,
	groups: string[],
	quest?: string,
) {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		session,
		addresses: [address],
		groups,
		joined: [],
		...(quest ? { quest } : {}),
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

/** The fixture's parent quest, 5GV2AH, given the orchestrator mark. */
function markedParent() {
	writeFileSync(
		join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
		"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
	);
}

/**
 * Wait until the session keeps 5GV2AH as its hub, as seen by a quest's
 * ending reaching it, which the mesh tells only the hub it keeps.
 */
async function untilHubKept(
	emit: (event: string, payload: unknown) => void,
	timeout = 5_000,
) {
	await vi.waitFor(
		() => {
			emit(QUEST_CONCLUDED, {
				how: "concluded",
				ids: ["PLAN-20261021-AAAAAA"],
				said: "Now concluded on plan PLAN-20261021-AAAAAA (The Plan).",
			});
			expect(lastSent()).toMatchObject({
				to: ["@5GV2AH"],
				intent: "fyi",
				text: expect.stringContaining("PLAN-20261021-AAAAAA concluded"),
			});
		},
		{ timeout },
	);
}

/** The last message on the mesh, as the transport keeps it. */
function lastSent() {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport.read(transport.ids().at(-1) ?? "");
}

/** Every message's text on the mesh, oldest first, as one. */
function everyText() {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport
		.ids()
		.map((id) => transport.read(id)?.text ?? "")
		.join("\n");
}

/** A quest's ending, as the quest tool says one, for plan `id`. */
const ending = (id: string) => ({
	how: "concluded",
	ids: [`PLAN-20261021-${id}`],
	said: `Now concluded on plan PLAN-20261021-${id} (The Plan).`,
});

describe("orchestrator, on a quest with no mark", () => {
	it("reaches the hub from use above this peer's quest, and says it was read so", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		cellIn("session-h", "HARN01", ["#harness"]);
		const env = await node(
			[asker, { key: "cell:5GV2AH" }, { key: "cell:HARN01" }],
			[tieTo("HARN01", 9), tieTo("5GV2AH", 2)],
		);
		const { tools } = await startSession(env);

		const answer = await send(tools, "orchestrator", "question", "May I?");

		expect(answer).toContain(
			"`orchestrator` was read as 5GV2AH, this peer's hub from use",
		);
		expect(lastSent()).toMatchObject({ to: ["@5GV2AH"], text: "May I?" });
	});

	it("counts the person's acts in a question for his hands put to the hub", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		const env = await node([asker], [tieTo("5GV2AH", 2)]);
		const { tools } = await startSession(env);

		const refused = await send(
			tools,
			"orchestrator",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(lastSent()).toBeUndefined();
	});

	// A send reads the address upper-cased, and no session goes by it in
	// that case, so a question never reaches such a hub past its checks.
	it("sends nothing to a hub whose presence spells its address in lower case", async () => {
		onQuest();
		cellIn("session-q", "5gv2ah", ["#quest/5gv2ah"]);
		const env = await node([asker], [tieTo("5gv2ah", 2)]);
		const { tools } = await startSession(env);

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: no session in this realm goes by 5GV2AH",
		);
		expect(lastSent()).toBeUndefined();
	});

	// This pins the order too: a question for the person's hands is
	// refused as the hub's own before any session is looked for by the
	// address, so its refusal is the hands one, not the missing session.
	it("refuses a question for the person's hands to a lower-case hub before looking for the session", async () => {
		onQuest();
		cellIn("session-q", "5gv2ah", ["#quest/5gv2ah"]);
		const env = await node([asker], [tieTo("5gv2ah", 2)]);
		const { tools } = await startSession(env);

		const refused = await send(
			tools,
			"orchestrator",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(lastSent()).toBeUndefined();
	});

	// The mark names the orchestrator in upper case; its presence may list
	// it otherwise, and every address it lists is still the orchestrator's.
	it("counts the person's acts in a question put to the marked orchestrator by another address, whatever case its presence lists", async () => {
		onQuest();
		markedParent();
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-q",
			addresses: ["5gv2ah", "OLD001"],
			groups: ["#quest/5gv2ah"],
			joined: [],
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
		const { tools } = await startSession(noNode());

		const refused = await send(
			tools,
			"OLD001",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(lastSent()).toBeUndefined();
	});

	// A hub from use is checked by every address its presence lists, as
	// the marked orchestrator is, whatever case it lists them in.
	it("counts the person's acts in a question put to the hub from use by another address", async () => {
		onQuest();
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-q",
			addresses: ["5gv2ah", "OLD001"],
			groups: ["#quest/5gv2ah"],
			joined: [],
			quest: "QEST-20261021-5GV2AH",
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
		const env = await node([asker], [tieTo("5GV2AH", 2)]);
		const { tools } = await startSession(env);

		const refused = await send(
			tools,
			"OLD001",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(lastSent()).toBeUndefined();
	});

	// A presence lists what addresses it likes, so one listing the
	// orchestrator's beside its own hides none of the real one's, in
	// whichever order the census reads them; and it fails closed, so the
	// impostor's own address is checked as the orchestrator's too. A
	// folder lists its files by name on one file system and as they were
	// written on another, so the impostor comes first by both or last by
	// both.
	it.each([
		{
			order: "the impostor first",
			impostor: "session-a",
			real: "session-q",
			impostorFirst: true,
		},
		{
			order: "the impostor last",
			impostor: "session-z",
			real: "session-b",
			impostorFirst: false,
		},
	])(
		"counts the person's acts in a question to any address listed beside the marked orchestrator's, $order",
		async ({ impostor, real, impostorFirst }) => {
			onQuest();
			markedParent();
			const presences = createPresences(join(fixture.paths.mesh, "presence"));
			const cell = (session: string, addresses: string[]) =>
				presences.publish({
					session,
					addresses,
					groups: ["#quest/5gv2ah"],
					joined: [],
					worksOn: "",
					owns: [],
					busy: false,
					at: new Date().toISOString(),
				});
			const publishing = [
				() => cell(impostor, ["EVIL01", "5gv2ah"]),
				() => cell(real, ["5GV2AH", "OLD001"]),
			];
			for (const publish of impostorFirst
				? publishing
				: [...publishing].reverse()) {
				publish();
			}
			const { tools } = await startSession(noNode());

			for (const to of ["OLD001", "EVIL01"]) {
				const refused = await send(
					tools,
					to,
					"question",
					"May Joel touch the key at 02:00?",
				);

				expect(refused, to).toContain(
					"Not sent: this asks for the person's hands",
				);
			}
			expect(lastSent()).toBeUndefined();
		},
	);

	// Its owner is this process under another start, so it has ended.
	it("never picks a cell whose session has ended", async () => {
		onQuest();
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-q",
			addresses: ["5GV2AH"],
			groups: ["#quest/5gv2ah"],
			joined: [],
			worksOn: "",
			owns: [],
			busy: false,
			owner: { pid: process.pid, startedAt: 1 },
			at: new Date().toISOString(),
		});
		const env = await node([asker], [tieTo("5GV2AH", 9)]);
		const { tools } = await startSession(env);

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain("has a tie to this peer yet");
		expect(lastSent()?.text).not.toBe("May I?");
	});

	it("still reaches the marked orchestrator over a stronger tie, without asking the node", async () => {
		onQuest();
		markedParent();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		cellIn("session-w", "WIDE01", ["#quest/5gv2ah"]);
		const env = await node(
			[asker, { key: "cell:5GV2AH" }, { key: "cell:WIDE01" }],
			[tieTo("WIDE01", 9)],
		);
		const { tools } = await startSession(env);
		nodeAsked.length = 0;

		const answer = await send(tools, "orchestrator", "fyi", "Landed.");

		expect(lastSent()).toMatchObject({ to: ["@5GV2AH"] });
		expect(answer).not.toContain("hub from use");
		expect(nodeAsked).not.toContain("tie");
	});

	it("refuses, naming the quest, when no live cell above is tied to this peer", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		cellIn("session-h", "HARN01", ["#harness"]);
		const env = await node([asker], [tieTo("HARN01", 9)]);
		const { tools } = await startSession(env);

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest, QEST-20261021-7M6JKG, and no live cell on a quest above it has a tie to this peer yet",
		);
		expect(lastSent()).toBeUndefined();
	});

	it("refuses when no node answers, rather than sending wider", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		const { tools } = await startSession(noNode());

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"no ties came from the node (none answered in time, or it keeps none)",
		);
		expect(lastSent()).toBeUndefined();
	});

	// The session's own find was answered as it started; the send's is
	// held past the node's patience, as a slow node would.
	it("reaches the hub it last found when the node gives the send no answer in time", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return asks === 1 ? Promise.resolve() : new Promise(() => {});
			},
		);
		const { tools } = await startSession(env);
		await vi.waitFor(() => expect(asks).toBe(1));

		const answer = await send(tools, "orchestrator", "fyi", "Landed.");

		expect(answer).toContain(
			"`orchestrator` was read as 5GV2AH, the hub from use this peer last found",
		);
		expect(lastSent()).toMatchObject({ to: ["@5GV2AH"], text: "Landed." });
	}, 15_000);

	// Reaching the kept hub is still reaching the hub, so the checks that
	// hold a question for the person's hands there hold here too.
	it("counts the person's acts in a question for his hands put to the hub it last found", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return asks === 1 ? Promise.resolve() : new Promise(() => {});
			},
		);
		const { tools } = await startSession(env);
		await vi.waitFor(() => expect(asks).toBe(1));

		const refused = await send(
			tools,
			"orchestrator",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(lastSent()).toBeUndefined();
	}, 15_000);

	// The node answered the send, and its answer is that no cell above is
	// tied any more: the hub it last found is no fallback for an answer.
	it("refuses, not reaching the hub it last found, when the node answers the send with no tie", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		const ties = [tieTo("5GV2AH", 2)];
		const env = await node([asker, { key: "cell:5GV2AH" }], ties);
		const started = await startSession(env);
		await untilHubKept(started.emit);
		ties.length = 0;

		const refused = await send(started.tools, "orchestrator", "fyi", "Landed.");

		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest, QEST-20261021-7M6JKG, and no live cell on a quest above it has a tie to this peer yet",
		);
		expect(refused).not.toContain("last found");
		expect(lastSent()?.text).not.toBe("Landed.");
	}, 15_000);

	// The hub's process went away after this session's find kept it,
	// writing no ending; the send's own census sees it gone, and the node
	// is too slow to say anything else.
	it("refuses, not reaching the hub it last found, when the send's own census judged it gone", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return asks === 1 ? Promise.resolve() : new Promise(() => {});
			},
		);
		const started = await startSession(env);
		await untilHubKept(started.emit);
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-q",
			addresses: ["5GV2AH"],
			groups: ["#quest/5gv2ah"],
			joined: [],
			quest: "QEST-20261021-5GV2AH",
			worksOn: "",
			owns: [],
			busy: false,
			// This process under another start, so a census reads it gone.
			owner: { pid: process.pid, startedAt: 1 },
			at: new Date().toISOString(),
		});

		const refused = await send(started.tools, "orchestrator", "fyi", "Landed.");

		// The find was left unfinished by the node, and the kept hub, read
		// for it, was refused.
		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest, QEST-20261021-7M6JKG, and no ties came from the node",
		);
		expect(lastSent()?.text).not.toBe("Landed.");
	}, 15_000);

	// The node was down when the session's own find asked, so its keeping
	// backs off for a long while; the send that hears it back up says so,
	// and the hub is kept now rather than at the keeping's next find.
	it("keeps the hub at once once a send hears the node answer, though its keeping was backing off", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return asks === 1 ? new Promise(() => {}) : Promise.resolve();
			},
		);
		const started = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 600_000, retry: 300_000, spread: () => 0 },
		);
		await vi.waitFor(() => expect(asks).toBe(1));

		// Sent while the keeping's find still waits on the node: that find
		// misses, and its next would wait a retry no test outlasts, but told
		// the node answered it finds again at once.
		await send(started.tools, "orchestrator", "fyi", "Landed.");

		await untilHubKept(started.emit, TIES_PATIENCE_MS + 3_000);
	}, 15_000);

	// A send the node gave no answer to says nothing of it, so the keeping
	// backs off as it was: a nudge on every send would ask a node that is
	// down once a send.
	it("asks the node nothing more for its keeping when a send's own find gets no answer", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return new Promise(() => {});
			},
		);
		const started = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 600_000, retry: 300_000, spread: () => 0 },
		);
		await vi.waitFor(() => expect(asks).toBe(1));

		await send(started.tools, "orchestrator", "fyi", "Landed.");
		// Long enough for a find the send started to have asked the node.
		await new Promise((done) => setTimeout(done, 500));

		expect(asks, "the keeping's and the send's own").toBe(2);
	}, 15_000);

	// What the mesh says by itself had nobody to go to while no hub was
	// kept, as after the node was down: it waits for the next find that
	// keeps one, rather than going nowhere.
	it("tells a quest's ending once a hub is kept, though none was when it ended", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return asks === 1 ? new Promise(() => {}) : Promise.resolve();
			},
		);
		const started = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 600_000, retry: 100, spread: () => 0 },
		);
		await vi.waitFor(() => expect(asks).toBe(1));

		started.emit(QUEST_CONCLUDED, {
			how: "concluded",
			ids: ["PLAN-20261021-BBBBBB"],
			said: "Now concluded on plan PLAN-20261021-BBBBBB (The Plan).",
		});
		expect(lastSent()?.text ?? "", "nobody kept to tell yet").not.toContain(
			"PLAN-20261021-BBBBBB",
		);

		await vi.waitFor(
			() =>
				expect(lastSent()).toMatchObject({
					to: ["@5GV2AH"],
					intent: "fyi",
					text: expect.stringContaining("PLAN-20261021-BBBBBB concluded"),
				}),
			{ timeout: TIES_PATIENCE_MS + 3_000 },
		);
	}, 15_000);

	it("tells no hub an ending kept from a quest the session has since left", async () => {
		onQuest();
		mkdirSync(join(fixture.paths.quests, "QEST-20261021-8ABCDE"));
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-8ABCDE", "README.md"),
			"---\nid: QEST-20261021-8ABCDE\nkind: quest\nparent: QEST-20261021-5GV2AH\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# QEST-20261021-8ABCDE\n",
		);
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		const env = await node(
			[
				asker,
				{ key: "cell:8ABCDE", title: "QEST-20261021-8ABCDE" },
				{ key: "cell:5GV2AH" },
			],
			[tieTo("5GV2AH", 2), { ...tieTo("5GV2AH", 2), key: "tie:8ABCDE~5GV2AH" }],
			() => {
				asks += 1;
				return asks === 1 ? new Promise(() => {}) : Promise.resolve();
			},
		);
		const started = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 600_000, retry: 100, spread: () => 0 },
		);
		await vi.waitFor(() => expect(asks).toBe(1));

		started.emit(QUEST_CONCLUDED, ending("BBBBBB"));
		writeFileSync(
			join(fixture.paths.sessions, `${session}.json`),
			JSON.stringify({ quest: "QEST-20261021-8ABCDE" }),
		);
		await send(started.tools, "5GV2AH", "fyi", "On another quest now.");
		// One ending after the hub is found, not one per retry as
		// untilHubKept sends, which would push BBBBBB out of the ten kept.
		await vi.waitFor(() => expect(asks).toBe(2), {
			timeout: TIES_PATIENCE_MS + 3_000,
		});
		await vi.waitFor(() => {
			started.emit(QUEST_CONCLUDED, ending("AAAAAA"));
			expect(everyText()).toContain("PLAN-20261021-AAAAAA concluded");
		});

		expect(everyText()).not.toContain("PLAN-20261021-BBBBBB");
	}, 15_000);

	it("keeps only the newest ten endings while nobody is kept to tell", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		let asks = 0;
		let answer = () => {};
		const env = await node(
			[asker, { key: "cell:5GV2AH" }],
			[tieTo("5GV2AH", 2)],
			() => {
				asks += 1;
				return asks === 1
					? new Promise<void>((resolve) => {
							answer = resolve;
						})
					: Promise.resolve();
			},
		);
		const started = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 600_000, retry: 100, spread: () => 0 },
		);
		await vi.waitFor(() => expect(asks).toBe(1));
		const ids = Array.from(
			{ length: 11 },
			(_, at) => `${String.fromCharCode(65 + at)}AAAAA`,
		);
		for (const id of ids) started.emit(QUEST_CONCLUDED, ending(id));

		answer();

		await vi.waitFor(
			() => expect(everyText()).toContain(`PLAN-20261021-${ids[10]} concluded`),
			{ timeout: TIES_PATIENCE_MS + 3_000 },
		);
		const told = everyText();
		expect(told).not.toContain(`PLAN-20261021-${ids[0]}`);
		for (const id of ids.slice(1)) {
			expect(told).toContain(`PLAN-20261021-${id} concluded`);
		}
	}, 15_000);

	// Root writes through a read-only folder, so the tell would not fail.
	it.skipIf(process.getuid?.() === 0)(
		"keeps the endings a failed tell left, without failing the ending's own listener, and tells them with the next",
		async () => {
			onQuest();
			cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
			const env = await node(
				[asker, { key: "cell:5GV2AH" }],
				[tieTo("5GV2AH", 2)],
			);
			const started = await startSession(
				env,
				{},
				[],
				undefined,
				undefined,
				undefined,
				undefined,
				{ every: 600_000, retry: 100, spread: () => 0 },
			);
			await vi.waitFor(() => {
				started.emit(QUEST_CONCLUDED, ending("AAAAAA"));
				expect(everyText()).toContain("PLAN-20261021-AAAAAA concluded");
			});
			const messages = join(fixture.paths.mesh, "messages");
			chmodSync(messages, 0o555);
			try {
				expect(() => {
					started.emit(QUEST_CONCLUDED, ending("CCCCCC"));
					started.emit(QUEST_CONCLUDED, ending("DDDDDD"));
				}).not.toThrow();
				expect(
					everyText(),
					"no tell got through the locked folder",
				).not.toContain("PLAN-20261021-CCCCCC");
			} finally {
				chmodSync(messages, 0o755);
			}

			started.emit(QUEST_CONCLUDED, ending("EEEEEE"));

			const told = everyText();
			for (const id of ["CCCCCC", "DDDDDD", "EEEEEE"]) {
				expect(told).toContain(`PLAN-20261021-${id} concluded`);
			}
		},
		15_000,
	);

	it("refuses for the head of an orchestration, without asking the node", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
			"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: QEST-20261021-5GV2AH\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-7M6JKG\n",
		);
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		const env = await node([asker], [tieTo("5GV2AH", 9)]);
		const { tools } = await startSession(env);
		nodeAsked.length = 0;

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: this peer heads its own orchestration",
		);
		expect(lastSent()).toBeUndefined();
		expect(nodeAsked).not.toContain("tie");
	});

	it("refuses for another session on a quest heading an orchestration, naming its head", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
			"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: QEST-20261021-5GV2AH\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-7M6JKG\n",
		);
		// The head already signs as the quest, so this session leaves the
		// address to it and plays no role.
		cellIn(
			"session-h",
			"7M6JKG",
			["#quest/5gv2ah/7m6jkg"],
			"QEST-20261021-7M6JKG",
		);
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		const env = await node([asker], [tieTo("5GV2AH", 9)]);
		const { tools } = await startSession(env);
		nodeAsked.length = 0;

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: this peer's quest heads its own orchestration, whose head is 7M6JKG",
		);
		// The mesh's own note that two sessions share the quest is on the
		// mesh already; only the refused question must not be.
		expect(lastSent()?.text).not.toBe("May I?");
		expect(nodeAsked).not.toContain("tie");
	});

	it("refuses when all that is beside the word cannot be a group", async () => {
		onQuest();
		const { tools } = await startSession(noNode());

		const refused = await send(
			tools,
			"orchestrator, not a group!",
			"question",
			"May I?",
		);

		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest",
		);
		expect(lastSent()).toBeUndefined();
	});
});
