/**
 * The mesh as a session meets it: messages reach it as context at the
 * attention they bear, never as a prompt that stops what it is doing,
 * and never not at all.
 *
 * What pins that here is what pi is handed: the delivery options, and
 * the digest a glance arrives in. pi's own rules decide the rest:
 * without a turn, a message sent mid-run is appended once the current
 * step's tool results are in, one sent while idle is appended with no
 * turn, and one returned from before_agent_start opens the next run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADVISORY,
	ASKS,
	GLANCE,
	GLANCES,
	MOST_GLANCES,
	NOTED,
} from "../../../extensions/mesh-workflow/delivery.ts";
import {
	type MeshPaths,
	meshWorkflow,
} from "../../../extensions/mesh-workflow/index.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Draft, Message } from "../../../lib/mesh/message.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

const session = "01a15f3a-2255-7463-9909-afa624b025fe";
let root: string;
let paths: MeshPaths;
let stops: (() => Promise<void>)[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-workflow-"));
	paths = {
		mesh: join(root, "mesh"),
		legacy: join(root, "pi-mailbox"),
		sessions: join(root, "sessions"),
		quests: join(root, "quests"),
	};
	mkdirSync(paths.sessions, { recursive: true });
	writeFileSync(
		join(paths.sessions, `${session}.json`),
		JSON.stringify({ quest: "QEST-20261021-7M6JKG" }),
		"utf8",
	);
	stops = [];
});

afterEach(async () => {
	for (const stop of stops) await stop();
	rmSync(root, { recursive: true, force: true });
});

type Sent = {
	message: {
		customType: string;
		content: string;
		display?: boolean;
		details?: unknown;
	};
	options: unknown;
};
type Handler = (event: unknown, ctx: unknown) => unknown;

/** Start a session on the extension, with just enough of pi to run it. */
async function startSession(
	env: NodeJS.ProcessEnv = {},
	ctx: Record<string, unknown> = {},
	branch: unknown[] = [],
) {
	const sent: Sent[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const lifecycle = new Map<string, Handler>();
	const tools = new Map<
		string,
		{
			execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
		}
	>();
	const pi = {
		on: (event: string, handler: Handler) => lifecycle.set(event, handler),
		registerTool: (tool: { name: string }) =>
			tools.set(tool.name, tool as never),
		sendMessage: (message: Sent["message"], options?: unknown) =>
			sent.push({ message, options }),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerEntryRenderer: () => {},
	};
	meshWorkflow(paths, env)(pi as never);
	await lifecycle.get("session_start")?.(
		{ reason: "startup" },
		{
			hasUI: false,
			cwd: root,
			sessionManager: {
				getSessionId: () => session,
				getSessionFile: () => join(root, `${session}.jsonl`),
				getBranch: () => branch,
			},
			...ctx,
		},
	);
	stops.push(async () => {
		await lifecycle.get("session_shutdown")?.({}, {});
	});
	const fire = (event: string) => lifecycle.get(event)?.({}, {});
	return { sent, tools, entries, fire };
}

/** A model registry holding one classifier that answers `about` so. */
function judging(about: unknown, calls: unknown[] = []) {
	return {
		modelRegistry: {
			getAvailableOfType: async () => [
				{ provider: "typesafe", id: "jev-latest" },
			],
			classify: async (_model: unknown, context: unknown) => {
				calls.push(context);
				if (about instanceof Error) throw about;
				return { stopReason: "stop", answers: { about } };
			},
		},
	};
}

const notYours = {
	type: "choice",
	choice: "other",
	probabilities: { other: 0.93, receiver: 0.05, machine: 0.02 },
};

/** A message from another peer, sent the way it sends one. */
function fromElsewhere(over: Partial<Draft> = {}): Message {
	return folderTransport(join(paths.mesh, "messages")).send({
		from: "WCJQSG",
		to: [ALL],
		intent: "fyi",
		text: "hold heavy builds until I say done",
		pid: process.pid + 1,
		...over,
	});
}

/** Send through the tool, and hand back what it answered. */
async function send(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	to: string,
	intent: string,
	text: string,
): Promise<string> {
	const answer = await tools
		.get("mesh_send")
		?.execute("call-1", { to, intent, text });
	return answer?.content[0]?.text ?? "";
}

/** Another peer's presence, as it would have published it. */
function peer(session: string, addresses: string[], groups: string[]) {
	createPresences(join(paths.mesh, "presence")).publish({
		session,
		addresses,
		groups,
		worksOn: "",
		owns: [],
		at: new Date().toISOString(),
	});
}

describe("a message as context", () => {
	it("is put in without starting or extending a turn", async () => {
		const { sent } = await startSession();

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message).toMatchObject({
			customType: NOTED,
			display: true,
		});
	});

	it("tells the model it is for awareness, not a task", async () => {
		// Said with the message, because the note in front of a model is
		// what it takes as its next instruction.
		const { sent } = await startSession();

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const content = sent[0]?.message.content ?? "";
		expect(content).toContain("Mesh message (fyi) from WCJQSG to #all");
		expect(content).toContain("hold heavy builds until I say done");
		expect(content.endsWith(ADVISORY)).toBe(true);
	});

	it("catches up on what arrived before it started, once, without a turn", async () => {
		// Starting with messages waiting once asked pi for a second turn
		// while the first prompt was about to run, which pi refuses.
		fromElsewhere({ text: "one" });
		await new Promise((wake) => setTimeout(wake, 2));
		fromElsewhere({ text: "two" });

		const first = await startSession();
		await vi.waitFor(() => expect(first.sent).toHaveLength(1));
		expect(first.sent[0]?.options).toEqual({ triggerTurn: false });
		expect(first.sent[0]?.message.content).toMatch(/one[\s\S]*two/);

		// A reload is a fresh start that has read them already.
		const again = await startSession();
		await new Promise((wake) => setTimeout(wake, 20));
		expect(again.sent).toEqual([]);
	});

	it("hands over nothing meant for another group, and none of its own", async () => {
		const { sent, tools } = await startSession();

		fromElsewhere({ to: ["@OVAE1I"], text: "not for you" });
		await send(tools, "all", "fyi", "from me");
		fromElsewhere({ to: ["@7M6JKG"], text: "for you" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("for you");
		expect(sent[0]?.message.content).not.toContain("not for you");
	});

	it("says only what the intents delivered ask", async () => {
		const { sent } = await startSession();

		fromElsewhere({ intent: "hold", text: "hold heavy builds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const content = sent[0]?.message.content ?? "";
		expect(content).toContain(ASKS.hold);
		expect(content).not.toContain(ASKS.question);
		expect(content).not.toContain(ASKS.fyi);
	});
});

describe("a glance", () => {
	it("is shown at once and kept out of context until the next turn", async () => {
		const calls: unknown[] = [];
		const { sent, entries } = await startSession({}, judging(notYours, calls));

		fromElsewhere({ text: "merging core.nix#330 now" });

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0]?.type).toBe(GLANCE);
		expect(sent).toEqual([]);
		// The classifier is told who is receiving, not just what was said.
		expect(JSON.stringify(calls[0])).toContain("7M6JKG");
	});

	it("reaches the model as one line at the end of the current step", async () => {
		const { sent, entries, fire } = await startSession({}, judging(notYours));
		const glanced = fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		await fire("turn_end");

		expect(sent).toHaveLength(1);
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message).toMatchObject({
			customType: GLANCES,
			display: false,
			details: { glanced: [glanced.id] },
		});
		const lines = sent[0]?.message.content.split("\n") ?? [];
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(
			/^- \d\d:\d\d fyi from WCJQSG to #all: merging core\.nix#330 now$/,
		);

		// Handed over once.
		await fire("turn_end");
		expect(sent).toHaveLength(1);
	});

	it("opens the next run while the session is idle", async () => {
		const { entries, fire } = await startSession({}, judging(notYours));
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		const opened = (await fire("before_agent_start")) as {
			message?: { customType: string; content: string };
		};

		expect(opened?.message?.customType).toBe(GLANCES);
		expect(opened?.message?.content).toContain("merging core.nix#330 now");
		expect(await fire("before_agent_start")).toBeUndefined();
	});

	it("rides along with the next message noted in full", async () => {
		const { sent, entries } = await startSession({}, judging(notYours));
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		fromElsewhere({ intent: "hold", text: "hold heavy builds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.customType).toBe(NOTED);
		expect(sent[0]?.message.content).toContain("hold heavy builds");
		expect(sent[0]?.message.content).toContain("merging core.nix#330 now");
	});

	it("spells out a few and counts the rest", async () => {
		const { sent, entries, fire } = await startSession({}, judging(notYours));
		for (let n = 0; n < MOST_GLANCES + 3; n++) {
			fromElsewhere({ text: `progress ${n}` });
		}
		await vi.waitFor(() => expect(entries).toHaveLength(MOST_GLANCES + 3));

		await fire("turn_end");

		const content = sent[0]?.message.content ?? "";
		expect(content.split("\n")).toHaveLength(MOST_GLANCES + 2);
		expect(content.endsWith("- and 3 more")).toBe(true);
	});

	it("is cut to one line however long it was", async () => {
		const { sent, entries, fire } = await startSession({}, judging(notYours));
		fromElsewhere({ text: `${"word ".repeat(80)}\nsecond line` });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		await fire("turn_end");

		const glance = sent[0]?.message.content.split("\n")[1] ?? "";
		expect(glance.length).toBeLessThanOrEqual(160);
		expect(glance.endsWith("…")).toBe(true);
	});

	it("still reaches the model after a reload, and only once", async () => {
		// A glance shown but not yet delivered when the session reloads.
		const waiting = fromElsewhere({ text: "waiting" });
		const carried = fromElsewhere({ text: "carried" });
		const branch = [
			{ type: "custom", customType: GLANCE, data: { message: carried } },
			{
				type: "custom_message",
				customType: GLANCES,
				details: { messages: [], glanced: [carried.id] },
			},
			{ type: "custom", customType: GLANCE, data: { message: waiting } },
		];
		// Both were read before the reload.
		folderTransport(join(paths.mesh, "messages")).markRead(
			"7M6JKG",
			waiting.id,
		);

		const { sent, fire } = await startSession({}, {}, branch);
		await fire("turn_end");

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("waiting");
		expect(sent[0]?.message.content).not.toContain("carried");
	});

	it("is noted in full when the classifier fails", async () => {
		const { sent, entries } = await startSession(
			{},
			judging(new Error("network gone")),
		);

		fromElsewhere({ text: "merging core.nix#330 now" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(entries).toEqual([]);
	});

	it("asks no classifier when it is switched off", async () => {
		const calls: unknown[] = [];
		const { sent } = await startSession(
			{ PI_MESH_CLASSIFIER: "off" },
			judging(notYours, calls),
		);

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(calls).toEqual([]);
	});
});

describe("a wake", () => {
	it("starts a turn for a question to an idle peer, and only then", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });

		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.options).toEqual({ triggerTurn: false });
	});

	it("never starts a turn for what it catches up on at start", async () => {
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });

		const { sent } = await startSession({}, { isIdle: () => true });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
	});
});

describe("sending", () => {
	it("signs with the quest the session has loaded, and the mesh stamps it", async () => {
		const { tools } = await startSession();

		const answer = await send(tools, "p9r1ki, all", "fyi", "hello");

		expect(answer).toContain("Sent as 7M6JKG");
		const transport = folderTransport(join(paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(id && transport.read(id)).toMatchObject({
			v: 1,
			from: "7M6JKG",
			to: ["@P9R1KI", ALL],
			text: "hello",
			intent: "fyi",
			pid: process.pid,
		});
	});

	it("says who it reaches, and which addresses nobody goes by", async () => {
		// A typo once sent a message nowhere without a word.
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "p9r1ki, p9rlki", "question", "ready?");

		expect(answer).toContain("It reaches P9R1KI.");
		expect(answer).toContain("No peer goes by P9RLKI");
	});

	it("refuses a group nobody else is in, and sends nothing", async () => {
		const { tools } = await startSession();

		const answer = await send(tools, "#skynet", "fyi", "site is up");

		expect(answer).toContain("Not sent: nobody else is in #skynet");
		expect(folderTransport(join(paths.mesh, "messages")).ids()).toEqual([]);
	});

	it("reaches a session still on the old mailbox", async () => {
		// Sessions keep the harness they started with until they reload.
		mkdirSync(join(paths.legacy, ".members"), { recursive: true });
		writeFileSync(
			join(paths.legacy, ".members", "old.json"),
			JSON.stringify({
				session: "old",
				names: ["WCJQSG"],
				channels: ["optimus"],
			}),
		);
		const { tools } = await startSession();

		const answer = await send(tools, "#optimus", "hold", "hold builds");

		expect(answer).toContain("It reaches WCJQSG.");
	});
});

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
			expect(
				again.sent.some((one) =>
					one.message.content.includes("for the harness"),
				),
			).toBe(true),
		);
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
			"This peer is in #harness, its home group and #all.",
		);
		expect(text).toContain("#harness: 7M6JKG");
		expect(text).toContain("#optimus/power: P9R1KI");
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

describe("a pi that keeps no session", () => {
	it("stays off the mesh, as a reload's load check does", async () => {
		// Seen live: every reload's load check showed up as a peer named for
		// its session id, working on a temporary folder.
		const { sent, tools } = await startSession(
			{},
			{
				sessionManager: {
					getSessionId: () => session,
					getSessionFile: () => undefined,
				},
			},
		);
		fromElsewhere({ text: "for everyone" });

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toEqual([]);
		expect(createPresences(join(paths.mesh, "presence")).all()).toEqual([]);
		const answer = await send(tools, "all", "fyi", "hello");
		expect(answer).toContain("not on the mesh");
	});
});

describe("a fleet's subagent", () => {
	it("stays off the mesh entirely", async () => {
		// It works inside another session's turn and answers to it alone.
		const { sent, tools } = await startSession({
			SUBAGENT_SUPERVISOR: "1",
			SUBAGENT_RUN_ID: "run-1",
		});
		fromElsewhere({ text: "for everyone" });

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toEqual([]);
		expect(tools.size).toBe(0);
		expect(createPresences(join(paths.mesh, "presence")).all()).toEqual([]);
	});
});
