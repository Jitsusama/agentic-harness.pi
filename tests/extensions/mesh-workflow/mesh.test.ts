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
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
import {
	ROLLOVER_CARRY,
	ROLLOVER_RECORD,
} from "../../../lib/internal/session/rollover.ts";
import { JOBS_FINISHED } from "../../../lib/jobs/index.ts";
import { MOST_TURNS_FROM_ONE } from "../../../lib/mesh/damping.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	createBoard,
	LEASE_EVENT,
	type Lease,
} from "../../../lib/mesh/lease.ts";
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
	settling = { settleMs: 40, spreadMs: 0 },
	waitCheckMs = 60_000,
) {
	const sent: Sent[] = [];
	const bus = new Map<string, ((data: unknown) => void)[]>();
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
		events: {
			on: (channel: string, handler: (data: unknown) => void) =>
				bus.set(channel, [...(bus.get(channel) ?? []), handler]),
			emit: (channel: string, data: unknown) => {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
	};
	meshWorkflow(paths, env, settling, waitCheckMs)(pi as never);
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
	const fire = (event: string, payload: unknown = {}, at: unknown = {}) =>
		lifecycle.get(event)?.(payload, at);
	return { sent, tools, entries, fire, emit: pi.events.emit };
}

/**
 * A model registry holding one classifier that answers `about` so, and
 * a routing question's `to` so when given.
 */
function judging(about: unknown, calls: unknown[] = [], to?: unknown) {
	return {
		modelRegistry: {
			getAvailableOfType: async () => [
				{ provider: "typesafe", id: "jev-latest" },
			],
			classify: async (_model: unknown, context: unknown) => {
				calls.push(context);
				if (about instanceof Error) throw about;
				return {
					stopReason: "stop",
					answers: { about, ...(to === undefined ? {} : { to }) },
				};
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

/**
 * Another peer's presence, as it would have published it. One that has
 * ended names this process with a start time it never had, which is
 * how the machine sees a pid that a new process came to wear.
 */
function peer(
	session: string,
	addresses: string[],
	groups: string[],
	ended = false,
) {
	createPresences(join(paths.mesh, "presence")).publish({
		session,
		addresses,
		groups,
		worksOn: "",
		owns: [],
		busy: false,
		...(ended ? { owner: { pid: process.pid, startedAt: 1 } } : {}),
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
		expect(content).toMatch(
			/Mesh message \[[0-9a-f]{8}\] \(fyi\) from WCJQSG to #all at \d\d:\d\d:/,
		);
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

	it("hears the peer that took over a quest it once held, and not what is sent to it", async () => {
		// Seen live: the session that spawned LUQ49E still answered to it,
		// so it took LUQ49E's messages for its own and dropped them.
		mkdirSync(join(paths.quests, "QEST-20261021-LUQ49E"), { recursive: true });
		writeFileSync(
			join(paths.quests, "QEST-20261021-LUQ49E", "README.md"),
			`sessions:\n  - id: ${session}\n`,
		);
		peer("session-l", ["LUQ49E"], []);
		const { sent } = await startSession();

		fromElsewhere({ from: "LUQ49E", to: ["@LUQ49E"], text: "to LUQ49E" });
		fromElsewhere({ from: "LUQ49E", text: "from LUQ49E" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("from LUQ49E");
		expect(sent[0]?.message.content).not.toContain("to LUQ49E");
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
			/^- \d\d:\d\d \[[0-9a-f]{8}\] fyi from WCJQSG to #all: merging core\.nix#330 now$/,
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
	it("starts a turn at once for a question to an idle peer, and for nothing that asks nothing", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "done here" });
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

describe("an act", () => {
	it("starts one turn for findings to an idle peer once the mesh settles", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "and another" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.message.content).toContain("your bug");
		expect(sent[0]?.message.content).toContain("and another");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toHaveLength(1);
	});

	it("goes with a run something else starts first, and starts none", async () => {
		const { sent, fire } = await startSession({}, { isIdle: () => true }, [], {
			settleMs: 400,
			spreadMs: 0,
		});

		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		// Long enough to be waiting, well short of the turn it waits for.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const opened = (await fire("before_agent_start")) as
			| { message?: Sent["message"] }
			| undefined;

		expect(opened?.message?.customType).toBe(NOTED);
		expect(opened?.message?.content).toContain("your bug");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(sent).toEqual([]);
	});

	it("starts no turn for a group's question another peer answered meanwhile", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		const asked = fromElsewhere({
			intent: "question",
			text: "who can look at 7M6JKG's tests?",
		});
		fromElsewhere({
			from: "P9R1KI",
			to: ["@WCJQSG"],
			re: asked.id,
			text: "on it",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.details).toMatchObject({
			why: ["about this peer's work, answered already"],
		});
	});

	it("asks no classifier about what names this peer", async () => {
		const calls: unknown[] = [];
		const { sent } = await startSession({}, judging(notYours, calls));

		fromElsewhere({ text: "7M6JKG: your reload broke mine" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.customType).toBe(NOTED);
		expect(calls).toEqual([]);
	});
});

describe("an answer", () => {
	it("to this peer's own message wakes it, wherever it went", async () => {
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "all", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(paths.mesh, "messages")).ids();

		fromElsewhere({ intent: "question", re: asked, text: "which version?" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.message.content).toMatch(/answering \[[0-9a-f]{8}\]/);
	});

	it("to this peer's question wakes it however it was sent, whatever the hour spent", async () => {
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "all", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(paths.mesh, "messages")).ids();
		for (let one = 1; one <= MOST_TURNS_FROM_ONE; one += 1) {
			fromElsewhere({
				intent: "question",
				to: ["@7M6JKG"],
				text: `why ${one}?`,
			});
			await vi.waitFor(() => expect(sent).toHaveLength(one));
		}

		fromElsewhere({ intent: "fyi", re: asked, text: "I do, until 03:00." });

		await vi.waitFor(() => expect(sent).toHaveLength(MOST_TURNS_FROM_ONE + 1));
		expect(sent.at(-1)?.options).toEqual({ triggerTurn: true });
	});

	it("goes without its reply when the message it answers is not there", async () => {
		const { tools } = await startSession();
		peer("session-w", ["WCJQSG"], []);

		const answer = await tools.get("mesh_send")?.execute("call-1", {
			to: "WCJQSG",
			intent: "fyi",
			text: "x",
			re: "ffffffff",
		});

		expect(answer?.content[0]?.text).toContain(
			"No message has the id ffffffff, so it answers nothing. mesh_read shows each message's id in brackets.",
		);
		const [id] = folderTransport(join(paths.mesh, "messages")).ids();
		expect(
			folderTransport(join(paths.mesh, "messages")).read(id as string),
		).not.toHaveProperty("re");
	});
});

describe("a withdrawal", () => {
	it("goes wherever what it replaces went, and only from its sender", async () => {
		const { tools } = await startSession();
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		await send(tools, "#optimus", "finding", "the cache is poisoned");
		const transport = folderTransport(join(paths.mesh, "messages"));
		const [said = ""] = transport.ids();

		await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "finding",
			text: "the cache is fine; it was my disk",
			supersedes: said.slice(-8),
		});
		const others = fromElsewhere({ to: ["#optimus"], text: "mine" });
		const refused = await tools.get("mesh_send")?.execute("call-3", {
			to: "#optimus",
			intent: "fyi",
			text: "not yours",
			supersedes: others.id,
		});

		expect(transport.read(transport.ids()[1] ?? "")).toMatchObject({
			to: ["#optimus", "@WCJQSG"],
			supersedes: said,
		});
		expect(refused?.content[0]?.text).toContain(
			"was sent by WCJQSG, and only a message's sender may replace it",
		);
		const read = await tools.get("mesh_read")?.execute("call-4", {});
		expect(read?.content[0]?.text).toMatch(
			/the cache is poisoned\n {2}withdrawn: replaced by \[[0-9a-f]{8}\], so go by that instead/,
		);
	});

	it("takes back a glance not yet handed over, and is noted by whoever heard it", async () => {
		const { sent, fire } = await startSession({}, judging(notYours));

		const said = fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() =>
			expect(
				folderTransport(join(paths.mesh, "messages")).lastRead(["7M6JKG"]),
			).toBe(said.id),
		);
		fromElsewhere({ text: "not merging after all", supersedes: said.id });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.customType).toBe(NOTED);
		expect(sent[0]?.message.content).toContain("which its sender withdraws");
		expect(sent[0]?.message.details).toMatchObject({ glanced: [] });
		await fire("turn_end");
		expect(sent).toHaveLength(1);
	});
});

describe("damping", () => {
	it("starts no more turns for one sender past its share of the hour", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		for (let one = 1; one <= MOST_TURNS_FROM_ONE + 1; one += 1) {
			fromElsewhere({
				intent: "question",
				to: ["@7M6JKG"],
				text: `why ${one}?`,
			});
			await vi.waitFor(() => expect(sent).toHaveLength(one));
		}

		expect(sent.map((one) => one.options)).toEqual([
			...Array.from({ length: MOST_TURNS_FROM_ONE }, () => ({
				triggerTurn: true,
			})),
			{ triggerTurn: false },
		]);
		expect(sent.at(-1)?.message.content).not.toContain("spent");
	});

	it("remembers the hour's turns across a reload", async () => {
		const turns = Array.from({ length: MOST_TURNS_FROM_ONE }, (_, one) => ({
			type: "custom_message",
			customType: NOTED,
			details: {
				messages: [fromElsewhere({ intent: "question", text: `why ${one}?` })],
				glanced: [],
				at: Date.now(),
				turn: true,
			},
		}));
		writeFileSync(
			join(paths.mesh, "messages", ".read-7M6JKG"),
			folderTransport(join(paths.mesh, "messages")).ids().at(-1) ?? "",
		);
		const { sent } = await startSession({}, { isIdle: () => true }, turns);

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "and now?" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
	});

	it("glances at what a sender said already", async () => {
		const { sent, entries } = await startSession();

		fromElsewhere({ to: ["@7M6JKG"], text: "rebooting at 01:00" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		fromElsewhere({ to: ["@7M6JKG"], text: "Rebooting at 01:00" });

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0]).toMatchObject({
			type: GLANCE,
			data: { why: "sent to this peer, said already" },
		});
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

		expect(answer).toContain("It goes to P9R1KI;");
		expect(answer).toContain("No peer goes by P9RLKI");
	});

	it("reaches a peer that once held this peer's quest", async () => {
		// Its presence still lists the address this peer signs with.
		peer("session-s", ["5GV2AH", "7M6JKG"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "all", "finding", "installed");

		expect(answer).toContain("It goes to 5GV2AH;");
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
		expect(folderTransport(join(paths.mesh, "messages")).ids()).toHaveLength(1);
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

		expect(answer).toContain("It goes to WCJQSG;");
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

	it("reads back who has a message it sent, and who not yet", async () => {
		peer("session-p", ["P9R1KI"], ["#harness"]);
		peer("session-o", ["OVAE1I"], ["#harness"]);
		const { tools } = await startSession();
		await send(tools, "#harness", "finding", "the bridge is in");
		const transport = folderTransport(join(paths.mesh, "messages"));
		const [id = ""] = transport.ids();
		transport.markRead("P9R1KI", id);

		const read = await tools.get("mesh_read")?.execute("call-1", {});

		expect(read?.content[0]?.text).toContain(
			"the bridge is in\n  P9R1KI has it; not yet OVAE1I",
		);
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
			"This peer has joined #harness; it is also in its home group and #all.",
		);
		expect(text).toContain("#harness: 7M6JKG");
		expect(text).toContain("#optimus/power: P9R1KI");
	});

	it("leaves out a peer whose session has ended, and says so", async () => {
		peer("session-p", ["P9R1KI"], ["#optimus/power"], true);
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-1", {});

		const text = listed?.content[0]?.text ?? "";
		expect(text).not.toContain("#optimus/power: P9R1KI");
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

/** The fixture's quest, under 5GV2AH, with this worktree's checkout. */
function onQuest() {
	const readme = (id: string, parent: string) =>
		`---\nid: ${id}\nkind: quest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# ${id}\n`;
	for (const [id, parent] of [
		["QEST-20261021-7M6JKG", "QEST-20261021-5GV2AH"],
		["QEST-20261021-5GV2AH", "null"],
	] as const) {
		mkdirSync(join(paths.quests, id), { recursive: true });
		writeFileSync(join(paths.quests, id, "README.md"), readme(id, parent));
	}
}

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
		const transport = folderTransport(join(paths.mesh, "messages"));
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
			createPresences(join(paths.mesh, "presence")).of(session)?.joined,
		).toEqual(["#jobs"]);
	});

	it("is not taken from a message sent to everyone", async () => {
		const { sent } = await startSession();

		fromElsewhere({ from: "P9R1KI", text: "come along", invite: "#jobs" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(
			createPresences(join(paths.mesh, "presence")).of(session)?.joined,
		).toEqual([]);
	});
});

/** Set or lift a stop through the tool, and hand back what it answered. */
async function stopping(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	params: { peer: string; why?: string; lift?: boolean },
): Promise<string> {
	const answer = await tools.get("mesh_stop")?.execute("call-s", params);
	return answer?.content[0]?.text ?? "";
}

/** A peer that has stopped this one, as it would have published it. */
function stopper(address: string, why?: string) {
	createPresences(join(paths.mesh, "presence")).publish({
		session: `session-${address.toLowerCase()}`,
		addresses: [address],
		groups: [],
		stops: [{ address: "7M6JKG", session, at: "", ...(why ? { why } : {}) }],
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

describe("a rollover", () => {
	it("carries the peer on into the fresh session, the same peer", async () => {
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		const first = await startSession();
		await first.tools.get("mesh_join")?.execute("call-1", { group: "#skynet" });
		await first.tools.get("mesh_stop")?.execute("call-2", { peer: "WCJQSG" });
		await send(first.tools, "all", "hold", "Hold builds.");
		const carry = { carried: {} as Record<string, unknown> };
		first.emit(ROLLOVER_CARRY, carry);
		expect(carry.carried.mesh).toEqual({ session });
		await first.fire("session_shutdown");

		// The fresh log's quest record may not be written yet.
		const fresh = "01a20000-0000-7000-8000-00000000f2e5";
		await startSession(
			{},
			{
				sessionManager: {
					getSessionId: () => fresh,
					getSessionFile: () => join(root, `${fresh}.jsonl`),
					getBranch: () => [
						{
							type: "custom",
							id: "r1",
							parentId: null,
							customType: ROLLOVER_RECORD,
							data: {
								parentSession: join(root, `${session}.jsonl`),
								parentLeaf: "a1",
								dropped: 3,
								carried: carry.carried,
							},
						},
					],
				},
			},
		);

		const presences = createPresences(join(paths.mesh, "presence"));
		const now = presences.of(fresh);
		expect(now?.addresses[0]).toBe("7M6JKG");
		expect(now?.joined).toContain("#skynet");
		expect(now?.stops?.map((stop) => stop.address)).toEqual(["WCJQSG"]);
		expect(presences.of(session)).toBeUndefined();
		const board = createBoard(join(paths.mesh, "leases"));
		expect(board.of(fresh)?.leases.map((lease) => lease.kind)).toEqual([
			"hold",
		]);
		expect(board.of(session)).toBeUndefined();
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
		const messages = folderTransport(join(paths.mesh, "messages"));
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

		const sent = await unaddressed(tools, "fyi", "Going to lunch.");

		expect(sent.to).toEqual([ALL]);
		expect(sent.text).toContain("no other peer is on this peer's work");
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

describe("a stop", () => {
	it("leaves a stopped peer's question a glance, starting no turn", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, entries, tools, fire } = await startSession(
			{},
			{ isIdle: () => true },
		);
		await stopping(tools, { peer: "WCJQSG" });

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });

		await vi.waitFor(() =>
			expect(entries).toContainEqual({
				type: GLANCE,
				data: expect.objectContaining({ why: "from a peer this one stopped" }),
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toEqual([]);
		const opened = (await fire("before_agent_start")) as
			| { message?: Sent["message"] }
			| undefined;
		expect(opened?.message?.customType).toBe(GLANCES);
		expect(opened?.message?.content).toContain("why?");
	});

	it("follows the stopped session to an address it signs with since", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { entries, tools } = await startSession();
		await stopping(tools, { peer: "WCJQSG" });
		peer("session-w", ["ZZ9PLZ", "WCJQSG"], []);

		fromElsewhere({ from: "ZZ9PLZ", to: ["@7M6JKG"], intent: "finding" });

		await vi.waitFor(() =>
			expect(entries).toContainEqual({
				type: GLANCE,
				data: expect.objectContaining({ why: "from a peer this one stopped" }),
			}),
		);
	});

	it("turns an act waiting when the stop is set into a glance", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, entries, tools } = await startSession(
			{},
			{ isIdle: () => true },
			[],
			{ settleMs: 300, spreadMs: 0 },
		);

		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await stopping(tools, { peer: "WCJQSG" });

		await vi.waitFor(() =>
			expect(entries).toContainEqual({
				type: GLANCE,
				data: expect.objectContaining({ why: "from a peer this one stopped" }),
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(sent).toEqual([]);
	});

	it("takes no invitation from a stopped peer", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { entries, tools } = await startSession();
		await stopping(tools, { peer: "P9R1KI" });

		fromElsewhere({
			from: "P9R1KI",
			to: ["@7M6JKG"],
			text: "P9R1KI brings this peer into #jobs.",
			invite: "#jobs",
		});

		await vi.waitFor(() =>
			expect(entries.some(({ type }) => type === GLANCE)).toBe(true),
		);
		expect(
			createPresences(join(paths.mesh, "presence")).of(session)?.joined,
		).toEqual([]);
	});

	it("tells the stopped peer, with why, and again when it is lifted", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();
		const transport = folderTransport(join(paths.mesh, "messages"));

		expect(
			await stopping(tools, { peer: "wcjqsg", why: "six in a minute" }),
		).toBe(
			"Stopped WCJQSG: what it sends reaches this peer as one line only, until mesh_stop with lift. It is told, with why.",
		);
		expect(await stopping(tools, { peer: "WCJQSG" })).toBe(
			"WCJQSG is stopped already.",
		);
		expect(
			createPresences(join(paths.mesh, "presence")).of(session)?.stops,
		).toMatchObject([
			{ address: "WCJQSG", session: "session-w", why: "six in a minute" },
		]);
		expect(await stopping(tools, { peer: "WCJQSG", lift: true })).toBe(
			"Lifted the stop on WCJQSG; it is told.",
		);
		expect(await stopping(tools, { peer: "WCJQSG", lift: true })).toBe(
			"WCJQSG is not stopped, so nothing changed.",
		);

		const told = transport.ids().map((id) => transport.read(id));
		expect(told).toMatchObject([
			{
				to: ["@WCJQSG"],
				intent: "fyi",
				text: expect.stringContaining(
					"has stopped this peer reaching it: six in a minute",
				),
			},
			{
				to: ["@WCJQSG"],
				text: expect.stringContaining("has lifted its stop on this peer"),
			},
		]);
		expect(
			createPresences(join(paths.mesh, "presence")).of(session)?.stops,
		).toBeUndefined();
	});

	it("is not set on this peer itself, nor on what is not an address", async () => {
		const { tools } = await startSession();

		for (const named of ["7M6JKG", "#harness", "all"]) {
			expect(await stopping(tools, { peer: named })).toContain(
				"is not another peer's address",
			);
		}
		expect(folderTransport(join(paths.mesh, "messages")).ids()).toEqual([]);
	});

	it("refuses a send to the home of a peer that stopped this one", async () => {
		stopper("P9R1KI", "too much");
		const { tools } = await startSession();

		const answer = await send(tools, "P9R1KI", "question", "but why?");

		expect(answer).toBe(
			"Not sent: P9R1KI stopped this peer reaching it (too much): it sees what this peer sends as one line only. Only it can lift that; until it does, leave it be.",
		);
		expect(folderTransport(join(paths.mesh, "messages")).ids()).toEqual([]);
	});

	it("leaves a stopper's home out of a send that names others too", async () => {
		stopper("P9R1KI");
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "P9R1KI, WCJQSG", "fyi", "done here");

		expect(answer).toContain("It goes to WCJQSG;");
		expect(answer).toContain("Not written to @P9R1KI: P9R1KI stopped");
		const messages = folderTransport(join(paths.mesh, "messages"));
		expect(messages.read(messages.ids()[0] as string)?.to).toEqual(["@WCJQSG"]);
	});

	it("says so when a send to a shared group reaches a peer that stopped this one", async () => {
		stopper("P9R1KI");
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "all", "fyi", "done here");

		expect(answer).toContain(
			"P9R1KI stopped this peer, so it sees this as one line and no more.",
		);
		expect(folderTransport(join(paths.mesh, "messages")).ids()).toHaveLength(1);
	});

	it("is listed by mesh_groups, on both sides", async () => {
		stopper("P9R1KI", "too much");
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();
		await stopping(tools, { peer: "WCJQSG" });

		const listed = await tools.get("mesh_groups")?.execute("call-g", {});

		const text = listed?.content[0]?.text ?? "";
		expect(text).toContain("Stopped by this peer: WCJQSG.");
		expect(text).toContain(
			"P9R1KI stopped this peer reaching it (too much): it sees what this peer sends as one line only.",
		);
	});
});

/** Another peer's lease, written to the board as that peer would. */
function leased(owner: string, over: Partial<Lease>) {
	const now = Date.now();
	createBoard(join(paths.mesh, "leases")).hold({
		session: owner,
		leases: [
			{
				kind: "change",
				subject: join(root, "a.ts"),
				since: new Date(now - 60_000).toISOString(),
				until: new Date(now + 600_000).toISOString(),
				...over,
			},
		],
	});
}

/** This peer's leases on the board. */
function ownBoard(): readonly Lease[] {
	return createBoard(join(paths.mesh, "leases")).of(session)?.leases ?? [];
}

/** An edit as pi asks the mesh about it before running it. */
const editing = (path: string) =>
	[
		"tool_call",
		{ type: "tool_call", toolName: "edit", toolCallId: "t1", input: { path } },
		{ cwd: root },
	] as const;

/** What the mesh sent other peers, as they would read it. */
function sentOut(): Message[] {
	const transport = folderTransport(join(paths.mesh, "messages"));
	return transport
		.ids()
		.map((id) => transport.read(id))
		.filter((one): one is Message => one?.pid === process.pid);
}

describe("a lease", () => {
	it("stops an edit once when another peer is changing the file, and tells it", async () => {
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as {
			block?: boolean;
			reason?: string;
		};
		const again = await fire(...editing("a.ts"));

		expect(first.block).toBe(true);
		expect(first.reason).toMatch(
			/^Not changed yet: WCJQSG \(since \d\d:\d\d\) is changing .*a\.ts\./,
		);
		expect(again).toBeUndefined();
		expect(ownBoard().map(({ kind }) => kind)).toEqual(["change"]);
		const told = sentOut();
		expect(told).toHaveLength(1);
		expect(told[0]).toMatchObject({ to: ["@WCJQSG"], intent: "fyi" });
		expect(told[0]?.text).toContain("reached for");
	});

	it("never stops the peer changing the file, and lapses when its run ends", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { fire } = await startSession();

		expect(await fire(...editing("a.ts"))).toBeUndefined();
		expect(await fire(...editing("a.ts"))).toBeUndefined();
		expect(ownBoard()).toMatchObject([
			{ kind: "change", subject: join(root, "a.ts") },
		]);
		await fire("agent_end");
		expect(ownBoard()).toEqual([]);
	});

	it("lets an edit by a peer that has ended go ahead", async () => {
		peer("session-w", ["WCJQSG"], [], true);
		leased("session-w", {});
		const { fire } = await startSession();

		expect(await fire(...editing("a.ts"))).toBeUndefined();
		expect(sentOut()).toEqual([]);
	});

	it("leaves a group's question another peer is answering to it", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { sent } = await startSession({}, { isIdle: () => true });

		const asked = fromElsewhere({
			intent: "question",
			text: "who can look at 7M6JKG's tests?",
		});
		leased("session-p", { kind: "answer", subject: asked.id });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.details).toMatchObject({
			why: ["about this peer's work, being answered by P9R1KI"],
		});
	});

	it("claims the questions a turn of this peer's answers", async () => {
		const { sent, fire } = await startSession({}, { isIdle: () => true });

		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "why?",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(ownBoard()).toMatchObject([
			{ kind: "answer", subject: asked.id, why: "why?" },
		]);
		await fire("agent_end");
		expect(ownBoard()).toEqual([]);
	});

	it("holds what this peer holds until it answers its own hold", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();

		const said = await send(tools, "all", "hold", "hold heavy builds");
		const [hold = ""] = folderTransport(join(paths.mesh, "messages")).ids();

		expect(said).toContain("It holds for two hours at most");
		expect(ownBoard()).toMatchObject([{ kind: "hold", subject: hold }]);
		await tools.get("mesh_send")?.execute("call-2", {
			to: "all",
			intent: "fyi",
			text: "builds may run again",
			re: hold,
		});
		expect(ownBoard()).toEqual([]);
	});

	it("waits on another's hold it answers, and carries on with a turn when it ends", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		const hold = fromElsewhere({ intent: "hold", text: "hold qemu" });

		const said = await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "my vm test waits on this",
			re: hold.id,
		});
		expect(said?.content[0]?.text).toContain(
			`This peer waits on [${hold.id.slice(-8)}] now`,
		);
		expect(ownBoard()).toMatchObject([{ kind: "wait", subject: hold.id }]);

		// The holder's word can go where this peer does not listen.
		fromElsewhere({
			to: ["#optimus"],
			re: hold.id,
			text: "qemu is free",
		});

		const over = ({ message }: Sent) =>
			message.content.startsWith("The hold [");
		await vi.waitFor(() => expect(sent.find(over)).toBeDefined());
		const resumed = sent.find(over);
		expect(resumed?.options).toEqual({ triggerTurn: true });
		expect(resumed?.message.content).toContain(
			'is over: its holder said "qemu is free". This peer had said: "my vm test waits on this".',
		);
		expect(resumed?.message.content).toContain("Carry on with what it held up");
		expect(ownBoard()).toEqual([]);
	});

	it("carries on when the peer holding it has ended", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession(
			{},
			{ isIdle: () => false },
			[],
			undefined,
			30,
		);
		const hold = fromElsewhere({ intent: "hold", text: "hold qemu" });
		await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "waiting",
			re: hold.id,
		});

		peer("session-w", ["WCJQSG"], [], true);

		await vi.waitFor(() =>
			expect(
				sent.find(({ message }) =>
					message.content.includes("is over: its holder has ended"),
				)?.options,
			).toEqual({ triggerTurn: false }),
		);
		expect(ownBoard()).toEqual([]);
	});

	it("tells both sides, once, when heavy work overlaps", async () => {
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "qemu", why: "vm test" });
		const { sent, emit } = await startSession();

		emit(LEASE_EVENT, { take: { subject: "qemu", why: "flake check" } });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.content).toMatch(
			/^Heavy work on qemu: WCJQSG \(since \d\d:\d\d\) is running it already/,
		);
		expect(sentOut()).toMatchObject([
			{
				to: ["@WCJQSG"],
				text: expect.stringContaining("too (flake check)"),
			},
		]);
		expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "qemu" }]);

		emit(LEASE_EVENT, { take: { subject: "qemu", why: "flake check" } });
		emit(LEASE_EVENT, { release: "qemu" });
		await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		expect(sent).toHaveLength(1);
		expect(sentOut()).toHaveLength(1);
	});

	it("claims a heavy shell command's work until its call answers", async () => {
		const { fire, emit } = await startSession();
		const running = (id: string, command: string) =>
			fire("tool_call", {
				type: "tool_call",
				toolName: "bash",
				toolCallId: id,
				input: { command },
			});
		const answered = (id: string, text = "done") =>
			fire("tool_result", {
				type: "tool_result",
				toolCallId: id,
				content: [{ type: "text", text }],
			});

		expect(await running("b0", "ls")).toBeUndefined();
		expect(ownBoard()).toEqual([]);
		await running("b1", "nice -n 10 nix flake check\necho ok");
		await running("b2", "nix flake check .#vm");
		expect(ownBoard()).toMatchObject([
			{
				kind: "heavy",
				subject: "nix flake check",
				// Two calls on one kind of work: it says the latest, by its first line.
				why: "nix flake check .#vm",
			},
		]);
		await answered("b1");
		expect(ownBoard()).toHaveLength(1);
		await answered("b2");
		expect(ownBoard()).toEqual([]);

		// One handed to a job runs on past its answer.
		await running("b3", "qemu-system-x86_64");
		await answered(
			"b3",
			"Still running after 5 minutes, so it now runs in the background as job 4.",
		);
		expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "qemu" }]);
		// Until its job says it has ended; another job's end is not its.
		const finished = (toolCallId: string) =>
			emit(JOBS_FINISHED, {
				jobId: "4",
				kind: "shell",
				toolCallId,
				failed: false,
			});
		finished("other");
		await new Promise((done) => setTimeout(done, 10));
		expect(ownBoard()).toHaveLength(1);
		finished("b3");
		await new Promise((done) => setTimeout(done, 10));
		expect(ownBoard()).toEqual([]);
	});

	it("lists what the peers still there hold", async () => {
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { why: "a fix" });
		peer("session-x", ["ENDED1"], [], true);
		leased("session-x", { kind: "hold", subject: "0123456789abcdef" });
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-g", {});

		expect(listed?.content[0]?.text).toContain(
			`\nLeases:\nWCJQSG: changing ${join(root, "a.ts")}`,
		);
		expect(listed?.content[0]?.text).not.toContain("ENDED1:");
	});
});

describe("presence", () => {
	it("names this process, so others can ask whether it is still there", async () => {
		await startSession();

		const own = createPresences(join(paths.mesh, "presence")).of(session);

		expect(own?.owner?.pid).toBe(process.pid);
	});

	it("says whether the peer is mid-run", async () => {
		const { fire } = await startSession();
		const own = () =>
			createPresences(join(paths.mesh, "presence")).of(session)?.busy;

		expect(own()).toBe(false);
		await fire("agent_start");
		expect(own()).toBe(true);
		await fire("agent_end");
		expect(own()).toBe(false);
	});
});

describe("retention", () => {
	it("lets go of what is past its time as a session starts", async () => {
		const dir = join(paths.mesh, "messages");
		mkdirSync(dir, { recursive: true });
		const old = `${Date.now() - 8 * 24 * 60 * 60 * 1000}-WCJQSG-1-aaaa`;
		writeFileSync(join(dir, `${old}.json`), "{}");

		await startSession();
		await new Promise((done) => setTimeout(done, 20));

		expect(existsSync(join(dir, `${old}.json`))).toBe(false);
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
