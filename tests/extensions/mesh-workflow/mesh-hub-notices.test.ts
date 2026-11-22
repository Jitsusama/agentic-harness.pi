/**
 * What the mesh says by itself on a quest with no orchestrator mark: an
 * ending and a session on no model are told to the hub from use this
 * peer keeps, the second once one is found if none was yet; a send
 * finds the hub afresh rather than reading the kept one; and a question
 * for the person's hands sent to the hub by its address is counted as
 * one sent with the word, whether or not a hub was kept, and when no
 * node answers to say whether it is the hub, the word beside it or not;
 * one by address to a peer that isn't the hub goes as any question.
 * Every delivery names the hub as where the person's asks go, and a
 * session that starts again in the same process leaves no search for
 * the hub running from the one that ended.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import { SESSION_ON_NO_MODEL } from "../../../lib/internal/session/no-model.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	noNode,
	onQuest,
	send,
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
 * The parent quest's cell, 5GV2AH, live above the fixture's quest, or
 * on `chain` instead.
 */
function parentLive(chain = "5gv2ah") {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		session: "session-q",
		addresses: ["5GV2AH"],
		groups: [`#quest/${chain}`],
		joined: [],
		quest: `QEST-20261021-${chain.split("/").at(-1)?.toUpperCase()}`,
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

/** What has been sent on the mesh, oldest first. */
function sent() {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport.ids().map((id) => transport.read(id));
}

/**
 * Start the fixture's session, tied to the live parent cell, and wait
 * until the ending it is told proves the hub is kept: each try before
 * then sends nothing, as nobody is above yet.
 */
async function keptHub(
	ctx: Record<string, unknown> = {},
	settling?: { settleMs: number; spreadMs: number },
) {
	onQuest();
	parentLive();
	const env = await node([asker], [tieTo("5GV2AH", 4)]);
	const started = await startSession(env, ctx, [], settling);
	await vi.waitFor(() => {
		started.emit(QUEST_CONCLUDED, {
			how: "concluded",
			ids: ["PLAN-20261021-AAAAAA"],
			said: "Now concluded on plan PLAN-20261021-AAAAAA (The Plan).",
		});
		expect(sent().at(-1)).toMatchObject({ to: ["@5GV2AH"], intent: "fyi" });
	});
	return started;
}

describe("the mesh's own word, on a quest with no mark", () => {
	it("tells the hub from use when a quest or document ends", async () => {
		await keptHub();

		expect(sent()).toHaveLength(1);
		expect(sent()[0]?.text).toContain("PLAN-20261021-AAAAAA concluded");
	});

	it("tells the hub from use, as a finding, that its session is on no model", async () => {
		const { emit } = await keptHub();

		emit(SESSION_ON_NO_MODEL, { when: "before a turn" });

		expect(sent().at(-1)).toMatchObject({
			to: ["@5GV2AH"],
			intent: "finding",
		});
		expect(sent().at(-1)?.text).toContain("on no model");
	});

	it("counts the person's acts in a question for his hands sent to the hub by its address", async () => {
		const { tools } = await keptHub();

		const refused = await send(
			tools,
			"5GV2AH",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(sent()).toHaveLength(1);
	});

	// The kept hub is minutes old by the time a send reads it, and a send
	// can wait for the node, so it finds the hub as things stand.
	it("finds the hub afresh for a send, rather than the one it keeps", async () => {
		const { tools } = await keptHub();
		parentLive("zz9zzz");

		const answer = await send(tools, "orchestrator", "fyi", "The run ended.");

		expect(answer).toContain("Not sent:");
		expect(answer).toContain("no live cell on a quest above it");
		expect(sent()).toHaveLength(1);
	});

	it("counts the person's acts in a question to the hub by address with no hub kept yet", async () => {
		onQuest();
		const env = await node([asker], [tieTo("5GV2AH", 4)]);
		const { tools } = await startSession(env);
		// Live only once the first find has come up empty, so none is kept.
		parentLive();

		const refused = await send(
			tools,
			"5GV2AH",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(sent()).toHaveLength(0);
	});

	// No answer can't say the address isn't the hub's, so the check is
	// made rather than skipped.
	it("counts the person's acts in a question to the hub by address when no node answers", async () => {
		onQuest();
		parentLive();
		const { tools } = await startSession(noNode());

		const refused = await send(
			tools,
			"5GV2AH",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(sent()).toHaveLength(0);
	});

	// Naming the word asks the node too, and its silence leaves
	// `orchestrator` out, but the address beside it may still be the hub.
	it("counts the person's acts in a question to orchestrator and the hub's address when no node answers", async () => {
		onQuest();
		parentLive();
		const { tools } = await startSession(noNode());

		const refused = await send(
			tools,
			"orchestrator, 5GV2AH",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(sent()).toHaveLength(0);
	});

	// Only the hub takes his hands to him, so a peer that isn't it is
	// asked as any peer is.
	it("sends a question for his hands by address to a peer that isn't the hub", async () => {
		const { tools } = await keptHub();
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-o",
			addresses: ["OTHER1"],
			groups: ["#quest/other1"],
			joined: [],
			quest: "QEST-20261021-OTHER1",
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});

		await send(tools, "OTHER1", "question", "May Joel touch the key at 02:00?");

		expect(sent().at(-1)).toMatchObject({
			to: ["@OTHER1"],
			text: "May Joel touch the key at 02:00?",
		});
	});

	it("tells nobody of a session on no model once a model is chosen, though a hub is found after", async () => {
		onQuest();
		parentLive();
		let answerTies: () => void = () => undefined;
		const tiesHeld = new Promise<void>((done) => {
			answerTies = done;
		});
		const env = await node([asker], [tieTo("5GV2AH", 4)], tiesHeld);
		const { emit, fire } = await startSession(env);

		emit(SESSION_ON_NO_MODEL, { when: "before a turn" });
		await fire("model_select", { source: "set" });
		answerTies();

		await vi.waitFor(() => {
			emit(QUEST_CONCLUDED, {
				how: "concluded",
				ids: ["PLAN-20261021-AAAAAA"],
				said: "Now concluded on plan PLAN-20261021-AAAAAA (The Plan).",
			});
			expect(sent().at(-1)).toMatchObject({ to: ["@5GV2AH"], intent: "fyi" });
		});
		expect(sent().filter((one) => one?.intent === "finding")).toHaveLength(0);
	});

	// The person's asks go where the note says, and a quest with no mark
	// has its hub there, by either road a message reaches the model.
	it("names the hub from use in a delivery handed over by itself", async () => {
		const { sent: handed } = await keptHub();

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });

		await vi.waitFor(() =>
			expect(
				handed.find(({ message }) =>
					String(message.content).includes("merged #950"),
				)?.message.content,
			).toContain("otherwise to your hub from use as a question"),
		);
		// Room for finding the hub first on a busy machine.
	}, 15_000);

	it("names the hub from use in a delivery a run something else starts takes", async () => {
		// Settling long enough that the run comes first and takes it.
		const { fire } = await keptHub(
			{ isIdle: () => true },
			{ settleMs: 10_000, spreadMs: 0 },
		);

		// Named in a message to everyone, so it waits to act rather than
		// taking a turn of its own at once.
		fromElsewhere({ intent: "question", text: "7M6JKG: why?" });

		// Long enough for the question to be waiting, well short of its 10 s
		// settle; a run started sooner would take nothing and hear it mid-run.
		await new Promise((done) => setTimeout(done, 2_000));
		const opened = (await fire("before_agent_start")) as
			| { message?: { content?: unknown } }
			| undefined;

		const taken = String(opened?.message?.content ?? "");
		expect(taken).toContain("why?");
		expect(taken).toContain("otherwise to your hub from use as a question");
		// Room for the pause above, and for finding the hub first on a busy machine.
	}, 15_000);

	// Either stop keeps this: the ending's, and the next start's guard.
	// The ending's alone can't be seen, since an ended session has no
	// peer for its search to read; the next test holds the guard alone.
	it("leaves no search for its hub running beside the next session's, once one ends", async () => {
		// One search never asks twice at once, since each find waits for the
		// last, so two asks out together mean an ended session's search
		// went on beside the next one's.
		let out = 0;
		let most = 0;
		const answerLate = () => {
			out += 1;
			most = Math.max(most, out);
			// Long enough that a second search's ask lands while one is out.
			return new Promise<void>((answered) =>
				setTimeout(() => {
					out -= 1;
					answered();
				}, 60),
			);
		};
		const tieAsks = () => nodeAsked.filter((kind) => kind === "tie").length;
		onQuest();
		parentLive();
		const env = await node([asker], [tieTo("5GV2AH", 4)], answerLate);
		const { fire, restart } = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 20, retry: 20, spread: () => 0 },
		);
		await vi.waitFor(() => expect(tieAsks()).toBeGreaterThanOrEqual(2));

		await fire("session_shutdown");
		await restart();
		const restarted = tieAsks();
		// The next search's second ask follows its first one's answer, which
		// came after the answer to the ask the ended search had out, since
		// every answer waits the same 60 ms and that ask went first: so by
		// then only an ask the ended search made after it ended can be out.
		await vi.waitFor(() =>
			expect(tieAsks()).toBeGreaterThanOrEqual(restarted + 2),
		);
		most = out;
		// Several of the next search's finds, each 60 ms out and 20 ms apart.
		await new Promise((done) => setTimeout(done, 400));

		expect(most).toBeLessThanOrEqual(1);
	}, 15_000);

	// A start with no ending before it, as a reload that skipped the
	// ending gives, leaves the last search with a peer to read: only the
	// start's own guard stops it.
	it("stops the last search for its hub when a session starts again without ending", async () => {
		let out = 0;
		let most = 0;
		const answerLate = () => {
			out += 1;
			most = Math.max(most, out);
			// Long enough that a second search's ask lands while one is out.
			return new Promise<void>((answered) =>
				setTimeout(() => {
					out -= 1;
					answered();
				}, 60),
			);
		};
		const tieAsks = () => nodeAsked.filter((kind) => kind === "tie").length;
		onQuest();
		parentLive();
		const env = await node([asker], [tieTo("5GV2AH", 4)], answerLate);
		const { restart } = await startSession(
			env,
			{},
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{ every: 20, retry: 20, spread: () => 0 },
		);
		await vi.waitFor(() => expect(tieAsks()).toBeGreaterThanOrEqual(2));

		await restart();
		const restarted = tieAsks();
		// As above: past the next search's second ask, only a search the
		// start left running can have one out beside it.
		await vi.waitFor(() =>
			expect(tieAsks()).toBeGreaterThanOrEqual(restarted + 2),
		);
		most = out;
		// Several of the next search's finds, each 60 ms out and 20 ms apart.
		await new Promise((done) => setTimeout(done, 400));

		expect(most).toBeLessThanOrEqual(1);
	}, 15_000);

	it("tells a session on no model to the hub once one is found, when it came first", async () => {
		onQuest();
		parentLive();
		const env = await node([asker], [tieTo("5GV2AH", 4)]);
		const { emit } = await startSession(env);

		emit(SESSION_ON_NO_MODEL, { when: "before a turn" });

		await vi.waitFor(() =>
			expect(sent().at(-1)).toMatchObject({
				to: ["@5GV2AH"],
				intent: "finding",
			}),
		);
		expect(sent()).toHaveLength(1);
	});
});
