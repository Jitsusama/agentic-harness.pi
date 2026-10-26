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
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADVISORY,
	ASKS,
	type Delivered,
	GLANCE,
	GLANCES,
	MOST_GLANCES,
	NOTED,
} from "../../../extensions/mesh-workflow/delivery.ts";
import {
	HAND_EXTENSION,
	type MeshPaths,
	meshWorkflow,
} from "../../../extensions/mesh-workflow/index.ts";
import { awaitedNow } from "../../../lib/internal/priority/awaited.ts";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/concluded.ts";
import {
	ROLLOVER_CARRY,
	ROLLOVER_RECORD,
} from "../../../lib/internal/session/rollover.ts";
import { SESSION_WANTS } from "../../../lib/internal/session/wants.ts";
import { JOBS_FINISHED } from "../../../lib/jobs/index.ts";
import {
	MOST_CAUGHT_UP,
	MOST_IN_FULL_FROM_ONE,
	MOST_TURNS_FROM_ONE,
} from "../../../lib/mesh/damping.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import { MESH_SESSION_ENV } from "../../../lib/mesh/hand.ts";
import {
	createBoard,
	LEASE_EVENT,
	type Lease,
} from "../../../lib/mesh/lease.ts";
import {
	type Draft,
	type Message,
	shortId,
} from "../../../lib/mesh/message.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
} from "../../../lib/subagent/events.ts";

// The folder's watcher, as a test can have it: deaf, as one is when the
// kernel drops its events, and with a message landing as it is armed.
const watching = vi.hoisted(() => ({
	deaf: false,
	armed: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		watch: ((...args: Parameters<typeof fs.watch>) => {
			watching.armed?.();
			return watching.deaf ? { close() {} } : fs.watch(...args);
		}) as typeof fs.watch,
	};
});

import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

const session = "01a15f3a-2255-7463-9909-afa624b025fe";
let root: string;
let paths: MeshPaths;
let stops: (() => Promise<void>)[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-workflow-"));
	paths = {
		mesh: join(root, "mesh"),
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
	watching.deaf = false;
	watching.armed = undefined;
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
	// Said on the bus once the extension loads, before the session starts.
	early: (emit: (channel: string, data: unknown) => void) => void = () => {},
	lookAgainMs = 60_000,
) {
	const sent: Sent[] = [];
	const emitted: [string, unknown][] = [];
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
				emitted.push([channel, data]);
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
	};
	meshWorkflow(paths, env, settling, waitCheckMs, lookAgainMs)(pi as never);
	early(pi.events.emit);
	await lifecycle.get("session_start")?.(
		{ reason: "startup" },
		{
			hasUI: false,
			cwd: root,
			sessionManager: {
				getSessionId: () => session,
				getSessionFile: () => join(root, `${session}.jsonl`),
				getBranch: () => branch,
				getSessionName: () => undefined,
				getCwd: () => root,
			},
			...ctx,
		},
	);
	stops.push(async () => {
		await lifecycle.get("session_shutdown")?.({}, {});
	});
	const fire = (event: string, payload: unknown = {}, at: unknown = {}) =>
		lifecycle.get(event)?.(payload, at);
	return { sent, tools, entries, fire, emit: pi.events.emit, emitted };
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

	it("hands over a long catch-up in full only for its newest and its own", async () => {
		const dir = join(paths.mesh, "messages");
		mkdirSync(dir, { recursive: true });
		const senders = ["WCJQSG", "P9R1KI", "2HN63P", "OVAE1I", "CV3XVS"];
		const count = MOST_CAUGHT_UP + 5;
		const text = (n: number) => `news-${String(n).padStart(2, "0")}`;
		for (let n = 0; n < count; n += 1) {
			const sent = Date.now() - 60_000 + n * 100;
			const from = senders[n % senders.length] as string;
			const id = `${sent}-${from}-7-aaaaaaaa`;
			writeFileSync(
				join(dir, `${id}.json`),
				JSON.stringify({
					v: 1,
					id,
					at: new Date(sent).toISOString(),
					from,
					to: n === 0 ? ["@7M6JKG"] : [ALL],
					intent: "fyi",
					text: text(n),
					pid: 7,
				}),
			);
		}

		const { sent, entries } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const details = sent[0]?.message.details as Delivered;
		expect(details.messages.map((one) => one.text)).toEqual([
			text(0),
			...Array.from({ length: MOST_CAUGHT_UP }, (_, n) => text(n + 5)),
		]);
		expect(
			entries
				.filter((entry) => entry.type === GLANCE)
				.map((entry) => (entry.data as { message: Message }).message.text),
		).toEqual([text(1), text(2), text(3), text(4)]);
	});

	it("glances at a sender's fyi once it has had the hour's in full", async () => {
		const { sent, entries } = await startSession({}, { isIdle: () => false });
		for (let n = 0; n < MOST_IN_FULL_FROM_ONE; n += 1) {
			fromElsewhere({ to: ["@7M6JKG"], text: `news ${n}` });
			await vi.waitFor(() => expect(sent).toHaveLength(n + 1));
		}

		fromElsewhere({ to: ["@7M6JKG"], text: "one more" });
		fromElsewhere({ to: ["@7M6JKG"], from: "P9R1KI", text: "from another" });

		await vi.waitFor(() =>
			expect(sent.at(-1)?.message.content).toContain("from another"),
		);
		expect(entries.find((entry) => entry.type === GLANCE)?.data).toMatchObject({
			message: { text: "one more" },
			why: expect.stringContaining("the hour's news from WCJQSG spent"),
		});
	});

	it("counts a sender's news within what it catches up on at once", async () => {
		for (let n = 0; n <= MOST_IN_FULL_FROM_ONE; n += 1) {
			fromElsewhere({ to: ["@7M6JKG"], text: `news ${n}` });
		}

		const { sent, entries } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const details = sent[0]?.message.details as Delivered;
		expect(details.messages).toHaveLength(MOST_IN_FULL_FROM_ONE);
		expect(entries.filter((entry) => entry.type === GLANCE)).toHaveLength(1);
	});

	it("glances at an fyi it catches up on past its hour", async () => {
		const hour = 60 * 60 * 1000;
		const dir = join(paths.mesh, "messages");
		const sent = Date.now() - 2 * hour;
		const id = `${sent}-WCJQSG-7-aaaaaaaa`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				at: new Date(sent).toISOString(),
				from: "WCJQSG",
				to: ["@7M6JKG"],
				intent: "fyi",
				text: "the stick is free",
				pid: 7,
			}),
		);
		writeFileSync(join(dir, ".read-7M6JKG"), `${sent - hour}-X-1-bbbbbbbb`);

		const { entries } = await startSession();

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0]).toMatchObject({
			type: GLANCE,
			data: { why: "an fyi past its hour" },
		});
	});

	it("hands over nothing meant for another group, and none of its own", async () => {
		const { sent, tools } = await startSession();

		fromElsewhere({ to: ["@OVAE1I"], text: "not for you" });
		await send(tools, "#optimus", "fyi", "from me");
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

	it("shows the classifier what this peer is changing now, and asks about it", async () => {
		const calls: unknown[] = [];
		const { sent, entries } = await startSession({}, judging(notYours, calls));
		leased(session, { subject: "agentic-harness.pi:lib/mesh/attention.ts" });

		fromElsewhere({ text: "merging core #366 to main now. Shell only." });

		await vi.waitFor(() => expect(calls).toHaveLength(1));
		const asked = calls[0] as {
			state: { receiver: { changing_now?: string[] } };
			questions: { about: { instructions: string } };
		};
		expect(asked.state.receiver.changing_now).toEqual([
			"agentic-harness.pi:lib/mesh/attention.ts",
		]);
		expect(asked.questions.about.instructions).toContain("changing now");
		await vi.waitFor(() => expect(entries[0]?.type).toBe(GLANCE));
		expect(sent).toEqual([]);
	});

	it("takes a message naming a file this peer changes as its own, unasked", async () => {
		const calls: unknown[] = [];
		const { sent } = await startSession({}, judging(notYours, calls));
		leased(session, { subject: "agentic-harness.pi:lib/mesh/attention.ts" });

		fromElsewhere({ text: "lib/mesh/attention.ts glances at my holds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(calls).toEqual([]);
		expect(JSON.stringify(sent[0]?.message)).toContain(
			"about this peer's work",
		);
	});
});

describe("a turn", () => {
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

describe("a message never lost", () => {
	const slow = { settleMs: 400, spreadMs: 0 };

	it("is handed over at the next start when it was waiting to act as the session went", async () => {
		// Marked read as it arrived, it was lost with the process that held it.
		const first = await startSession({}, { isIdle: () => true }, [], slow);
		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await first.fire("session_shutdown");
		expect(first.sent).toEqual([]);

		const again = await startSession();

		await vi.waitFor(() => expect(again.sent).toHaveLength(1));
		expect(again.sent[0]?.message.content).toContain("your bug");
	});

	it("is handed over once, even when it was handed over while another waited", async () => {
		const first = await startSession({}, { isIdle: () => true }, [], slow);
		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		fromElsewhere({ to: ["@7M6JKG"], text: "done here" });
		await vi.waitFor(() => expect(first.sent).toHaveLength(1));
		await first.fire("session_shutdown");
		const branch = first.sent.map(({ message }) => ({
			type: "custom_message",
			...message,
		}));

		const again = await startSession({}, {}, branch);

		await vi.waitFor(() => expect(again.sent).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(again.sent).toHaveLength(1);
		expect(again.sent[0]?.message.content).toContain("your bug");
		expect(again.sent[0]?.message.content).not.toContain("done here");
	});

	it("is read once glanced at, or taken by a run something else started", async () => {
		const first = await startSession(
			{},
			{ ...judging(notYours), isIdle: () => true },
			[],
			slow,
		);
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(first.entries).toHaveLength(1));
		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await first.fire("before_agent_start");
		await first.fire("session_shutdown");

		const again = await startSession();

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(again.sent).toEqual([]);
		expect(again.entries).toEqual([]);
	});

	it("is heard when it lands as the peer starts watching", async () => {
		// Watching only after the catch-up lost what landed between the two.
		watching.deaf = true;
		watching.armed = () => {
			watching.armed = undefined;
			fromElsewhere({ to: ["@7M6JKG"], text: "just in time" });
		};

		const { sent } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("just in time");
	});

	it("is looked for again when the watcher never reports it", async () => {
		watching.deaf = true;
		const { sent } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			undefined,
			20,
		);

		fromElsewhere({ to: ["@7M6JKG"], text: "dropped by the kernel" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("dropped by the kernel");
	});

	it("is looked for again as a run ends", async () => {
		watching.deaf = true;
		const { sent, fire } = await startSession();
		fromElsewhere({ to: ["@7M6JKG"], text: "dropped by the kernel" });

		await fire("agent_end");

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("dropped by the kernel");
	});
});

describe("an answer", () => {
	it("to this peer's own message gets a turn, wherever it went", async () => {
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "#optimus", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(paths.mesh, "messages")).ids();

		fromElsewhere({ intent: "question", re: asked, text: "which version?" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.message.content).toMatch(/answering \[[0-9a-f]{8}\]/);
	});

	it("to this peer's question gets a turn however it was sent, whatever the hour spent", async () => {
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "#optimus", "question", "who has qemu?");
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

	it("names the question this peer took up when its answer names none", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "which qemu?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		const said = await send(tools, "WCJQSG", "fyi", "9.1, from nixpkgs");

		const answer = sentOut().at(-1);
		expect(answer?.re).toBe(asked.id);
		expect(said).toContain(
			`It answers [${asked.id.slice(-8)}], the question this peer took up; name re to say it answers another.`,
		);
	});

	it("names no question for an answer elsewhere, a hold, or one of two", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "which qemu?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		await send(tools, "#harness", "fyi", "qemu 9.1 is in");
		await send(tools, "WCJQSG", "hold", "hold qemu while I test");
		fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "and which nix?",
		});
		await vi.waitFor(() =>
			expect(ownBoard().filter(({ kind }) => kind === "answer")).toHaveLength(
				2,
			),
		);
		await send(tools, "WCJQSG", "fyi", "9.1, and 2.31");

		expect(sentOut().map(({ re }) => re)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("names every mesh tool in the line the prompt always shows", async () => {
		const { tools } = await startSession();
		const snippet =
			(tools.get("mesh_send") as { promptSnippet?: string } | undefined)
				?.promptSnippet ?? "";
		const names = [...tools.keys()].filter((name) => name.startsWith("mesh_"));
		expect(names.length).toBeGreaterThan(1);
		for (const name of names.filter((name) => name !== "mesh_send")) {
			expect(snippet).toContain(name);
		}
	});

	it("stands under this peer's question as it is read back", async () => {
		peer("session-p", ["P9R1KI"], ["#optimus"]);
		const { tools } = await startSession();
		await send(tools, "#optimus", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(paths.mesh, "messages")).ids();
		const readBack = async () =>
			(await tools.get("mesh_read")?.execute("call-2", {}))?.content[0]?.text ??
			"";

		expect(await readBack()).toContain("\n  unanswered after 0 min");
		leased("session-p", { kind: "answer", subject: asked });
		expect(await readBack()).toContain("\n  being answered by P9R1KI");
		const answer = fromElsewhere({
			from: "P9R1KI",
			to: ["@WCJQSG"],
			re: asked,
			text: "I do",
		});
		expect(await readBack()).toContain(
			`\n  answered by P9R1KI, last in [${answer.id.slice(-8)}]`,
		);
	});

	it("goes back to whoever asked when it answers and names nowhere", async () => {
		const { tools } = await startSession();
		peer("session-w", ["WCJQSG"], []);
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "are you there?",
		});

		const answer = await tools.get("mesh_send")?.execute("call-1", {
			intent: "fyi",
			text: "PONG",
			re: asked.id.slice(-8),
		});

		const transport = folderTransport(join(paths.mesh, "messages"));
		const sent = transport.ids().map((id) => transport.read(id));
		expect(sent.find((one) => one?.text === "PONG")?.to).toEqual(["@WCJQSG"]);
		expect(answer?.content[0]?.text).not.toContain("It named no group");
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
				intent: "finding",
				to: ["@7M6JKG"],
				text: `the cache is poisoned, ${one}`,
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

	it("starts a turn for every question put to this peer, past the hour's share", async () => {
		const { sent } = await startSession({}, { isIdle: () => true });

		for (let one = 1; one <= MOST_TURNS_FROM_ONE + 1; one += 1) {
			fromElsewhere({
				intent: "question",
				to: ["@7M6JKG"],
				text: `why ${one}?`,
			});
			await vi.waitFor(() => expect(sent).toHaveLength(one));
		}

		expect(sent.map((one) => one.options)).toEqual(
			Array.from({ length: MOST_TURNS_FROM_ONE + 1 }, () => ({
				triggerTurn: true,
			})),
		);
	});

	it("steers a question put to a busy peer into its run", async () => {
		const { sent } = await startSession({}, { isIdle: () => false });

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		fromElsewhere({ to: ["@7M6JKG"], text: "rebooting at 01:00" });

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent.map((one) => one.options)).toEqual([
			{ triggerTurn: true },
			{ triggerTurn: false },
		]);
	});

	it("remembers the hour's turns across a reload", async () => {
		const turns = Array.from({ length: MOST_TURNS_FROM_ONE }, (_, one) => ({
			type: "custom_message",
			customType: NOTED,
			details: {
				messages: [
					fromElsewhere({ intent: "finding", text: `poisoned ${one}` }),
				],
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

		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "and now" });

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

describe("a message caught half written", () => {
	it("is taken once it reads, not lost", async () => {
		const { sent } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		const dir = join(paths.mesh, "messages");
		const id = `${Date.now()}-TESTER-1-c0ffee00`;
		writeFileSync(join(dir, `${id}.json`), "");
		await new Promise((done) => setTimeout(done, 60));
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				at: new Date().toISOString(),
				from: "TESTER",
				to: ["@7M6JKG"],
				intent: "fyi",
				text: "written at last",
				pid: process.pid + 1,
			}),
		);

		await vi.waitFor(() =>
			expect(sent.map((one) => one.message.content).join()).toContain(
				"written at last",
			),
		);
	});
});

describe("asking again", () => {
	const later = () => vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);
	afterEach(() => vi.useRealTimers());
	const start = () =>
		startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);

	it("asks again, with a turn, a question put to this peer it never answered", async () => {
		const { sent } = await start();
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "ready?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		vi.useFakeTimers({ toFake: ["Date"] });
		later();

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.options).toEqual({ triggerTurn: true });
		expect(sent[1]?.message.content).toMatch(/^Asked again: this question/);
		expect(sent[1]?.message.content).toContain("ready?");
	});

	it("asks nothing again once this peer has answered", async () => {
		const { sent, tools } = await start();
		peer("session-w", ["WCJQSG"], []);
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "ready?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		await tools.get("mesh_send")?.execute("call-1", {
			to: "WCJQSG",
			intent: "fyi",
			text: "yes",
			re: asked.id.slice(-8),
		});

		vi.useFakeTimers({ toFake: ["Date"] });
		later();
		await new Promise((done) => setTimeout(done, 100));

		expect(sent).toHaveLength(1);
	});

	it("tells the asker a question put by name has had no answer", async () => {
		const { sent, tools } = await start();
		peer("session-w", ["WCJQSG"], []);
		await tools.get("mesh_send")?.execute("call-1", {
			to: "WCJQSG",
			intent: "question",
			text: "is equilibrius ready again?",
		});

		vi.useFakeTimers({ toFake: ["Date"] });
		later();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.content).toContain("has had no answer from WCJQSG");
	});
});

describe("sending", () => {
	it("signs with the quest the session has loaded, and the mesh stamps it", async () => {
		const { tools } = await startSession();

		const answer = await send(tools, "p9r1ki, #optimus", "fyi", "hello");

		expect(answer).toContain("Sent as 7M6JKG");
		const transport = folderTransport(join(paths.mesh, "messages"));
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

	it("signs as its session while another live peer has its quest, and both are told", async () => {
		// Two sessions on one quest both signed with its address, so each
		// took the other's messages for its own and heard none of them.
		peer("session-x", ["7M6JKG"], []);
		const { sent, tools } = await startSession();

		expect(await send(tools, "p9r1ki", "fyi", "hello")).toContain(
			"Sent as 24B025FE",
		);
		const transport = folderTransport(join(paths.mesh, "messages"));
		const told = transport
			.ids()
			.map((id) => transport.read(id))
			.find((one) => one?.to.includes("@7M6JKG"));
		expect(told).toMatchObject({ from: "24B025FE", intent: "fyi" });
		expect(told?.text).toContain("has quest 7M6JKG loaded too");
		expect(
			sent.some(({ message }) =>
				message.content.startsWith("Another live session, 7M6JKG"),
			),
		).toBe(true);

		fromElsewhere({ from: "7M6JKG", to: ["@24B025FE"], text: "which part?" });
		await vi.waitFor(() =>
			expect(
				sent.some(({ message }) => message.content.includes("which part?")),
			).toBe(true),
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

		const transport = folderTransport(join(paths.mesh, "messages"));
		expect(transport.ids()).toHaveLength(0);
		expect(
			sent.some(({ message }) =>
				message.content.startsWith("Another live session"),
			),
		).toBe(false);
	});

	it("keeps its quest's address from a peer that held it and ended", async () => {
		peer("session-x", ["7M6JKG"], [], true);
		const { tools } = await startSession();

		expect(await send(tools, "p9r1ki", "fyi", "hello")).toContain(
			"Sent as 7M6JKG",
		);
		const transport = folderTransport(join(paths.mesh, "messages"));
		expect(transport.ids()).toHaveLength(1);
	});

	it("takes its quest's address back once the peer holding it ends", async () => {
		peer("session-x", ["7M6JKG"], []);
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
		const presences = createPresences(join(paths.mesh, "presence"));
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
		expect(answer).toContain("No peer goes by P9RLKI");
	});

	it("reaches a peer that once held this peer's quest", async () => {
		// Its presence still lists the address this peer signs with.
		peer("session-s", ["5GV2AH", "7M6JKG"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "all", "hold", "installing");

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
		const messages = folderTransport(join(paths.mesh, "messages"));
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

		const messages = folderTransport(join(paths.mesh, "messages"));
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
		expect(said.every((one) => one.includes("#harness"))).toBe(true);
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
		const presences = createPresences(join(paths.mesh, "presence"));
		const waiting = (session: string, address: string, ended: boolean) =>
			presences.publish({
				session,
				addresses: [address],
				groups: ["#optimus"],
				worksOn: "",
				owns: [],
				busy: false,
				wants: { kind: "approval", since, said: "Push to main?" },
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

	it("lists each other peer still there, whether it is in a run, and its work", async () => {
		const presences = createPresences(join(paths.mesh, "presence"));
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

	it("says in presence what this session waits on, from the bus, held until it starts", async () => {
		const kept = () =>
			createPresences(join(paths.mesh, "presence")).of(session)?.wants;
		const held = {
			kind: "approval",
			since: "2026-10-22T08:00:00.000Z",
			said: "Push to main?",
		};
		const asked = {
			kind: "question",
			since: "2026-10-22T08:05:00.000Z",
			said: "Which launcher?",
		};

		const { emit } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			(early) => early(SESSION_WANTS, held),
		);
		expect(kept()).toEqual(held);

		emit(SESSION_WANTS, asked);
		expect(kept()).toEqual(held);
		emit(SESSION_WANTS, { kind: "approval", said: null });
		expect(kept()).toEqual(asked);
		emit(SESSION_WANTS, { kind: "question", said: null });
		expect(kept()).toBeUndefined();
		emit(SESSION_WANTS, { kind: "lunch", since: held.since, said: "hi" });
		expect(kept()).toBeUndefined();
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
					getSessionName: () => undefined,
					getCwd: () => root,
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

	it("says in presence what the file already holds, as a session starts", async () => {
		paths = { ...paths, waiting: join(root, "waiting") };
		mkdirSync(paths.waiting ?? "", { recursive: true });
		writeFileSync(
			join(root, "waiting", "7M6JKG.json"),
			JSON.stringify({
				updated: "2026-10-26T03:00:00.000Z",
				quest: "QEST-20261021-7M6JKG",
				items: [
					{
						id: "look",
						title: "Look at the sheet",
						why: "His taste",
						minutes: 1,
						when: "now",
						window: null,
						quest: "QEST-20261021-7M6JKG",
						ready: true,
					},
				],
			}),
		);

		await startSession();

		expect(
			createPresences(join(paths.mesh, "presence")).of(session)?.wants,
		).toMatchObject({ kind: "action", said: "Look at the sheet" });
	});

	it("tells the orchestrator when a quest or document ends", async () => {
		onQuest();
		writeFileSync(
			join(paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		const { emit } = await startSession();
		const transport = folderTransport(join(paths.mesh, "messages"));

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
			join(paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		createPresences(join(paths.mesh, "presence")).publish({
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
		const transport = folderTransport(join(paths.mesh, "messages"));

		emit(QUEST_CONCLUDED, { how: "concluded", ids: ["X"], said: "Done." });

		expect(transport.ids()).toEqual([]);
	});

	it("tells nobody of an ending when no orchestrator is above the quest", async () => {
		onQuest();
		const { emit } = await startSession();
		const transport = folderTransport(join(paths.mesh, "messages"));

		emit(QUEST_CONCLUDED, { how: "retired", ids: ["X"], said: "Retired." });

		expect(transport.ids()).toEqual([]);
	});

	it("keeps what waits on the person where the launcher reads it, mirrored in presence", async () => {
		paths = { ...paths, waiting: join(root, "waiting") };
		const { tools } = await startSession();
		const wait = (params: Record<string, unknown>) =>
			tools.get("mesh_wait")?.execute("call-w", params);
		const file = join(root, "waiting", "7M6JKG.json");
		const presence = () =>
			createPresences(join(paths.mesh, "presence")).of(session);

		const kept = await wait({
			id: "eero-login",
			title: "Log in to eero",
			why: "Only Joel has the account",
			minutes: 2,
			when: "now",
			ready: true,
		});

		expect(kept?.content[0]?.text).toContain("Kept eero-login");
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			quest: "QEST-20261021-7M6JKG",
			items: [
				{
					id: "eero-login",
					title: "Log in to eero",
					why: "Only Joel has the account",
					minutes: 2,
					when: "now",
					quest: "QEST-20261021-7M6JKG",
					ready: true,
				},
			],
		});
		expect(presence()?.wants).toMatchObject({
			kind: "action",
			said: "Log in to eero",
		});

		const refused = await wait({ id: "look", title: "Look" });
		expect(refused?.content[0]?.text).toContain("Nothing was kept");

		await wait({ id: "eero-login", done: true });

		expect(existsSync(file)).toBe(false);
		expect(presence()?.wants).toBeUndefined();
	});

	it("refuses a send to an orchestrator nobody is, and drops the word beside other groups", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah/7m6jkg", "#harness"]);
		const { tools } = await startSession();
		const transport = folderTransport(join(paths.mesh, "messages"));

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

	it("keeps the machine's group for holds and the answers that end them", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah/7m6jkg", "#harness"]);
		const { tools } = await startSession();
		const transport = folderTransport(join(paths.mesh, "messages"));
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
		});
		expect(over?.content[0]?.text).not.toContain("Not sent");
		expect(last()?.to).toEqual([ALL]);
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
			"Stopped WCJQSG: what it sends reaches this peer as one line only, its answers to this peer's questions included, until mesh_stop with lift. It is told, with why.",
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

		const answer = await send(tools, "all", "hold", "hold here");

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

	it("stops a git command once that rewrites a checkout another peer changes files in", async () => {
		mkdirSync(join(root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { checkout: root });
		const { fire } = await startSession();
		const run = (command: string) =>
			fire(
				"tool_call",
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "b",
					input: { command },
				},
				{ cwd: root },
			) as Promise<{ block?: boolean; reason?: string } | undefined>;

		expect(await run("git status")).toBeUndefined();
		const first = await run("git reset --hard");
		const again = await run("git reset --hard");

		expect(first?.block).toBe(true);
		expect(first?.reason).toMatch(
			/^Not run yet: `git reset --hard` rewrites the files of .*, where WCJQSG \(since \d\d:\d\d\) is changing .*a\.ts\. /,
		);
		expect(again).toBeUndefined();
		expect(ownBoard()).toMatchObject([
			{
				kind: "change",
				subject: root,
				checkout: root,
				why: "git reset --hard",
			},
		]);
		const told = sentOut();
		expect(told).toHaveLength(1);
		expect(told[0]).toMatchObject({ to: ["@WCJQSG"], intent: "fyi" });
		expect(told[0]?.text).toMatch(
			/is about to run `git reset --hard` in .*, which rewrites its files while this peer is changing /,
		);
	});

	it("lets a rewrite go ahead beside a peer in another checkout, or one that has ended", async () => {
		mkdirSync(join(root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		peer("session-e", ["ENDEDP"], [], true);
		leased("session-w", { checkout: join(root, "elsewhere") });
		leased("session-e", { checkout: root });
		const { fire } = await startSession();

		expect(
			await fire(
				"tool_call",
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "b",
					input: { command: "git checkout main" },
				},
				{ cwd: root },
			),
		).toBeUndefined();
		expect(sentOut()).toEqual([]);
	});

	it("claims no checkout for a pull, which only brings its branch up to date", async () => {
		// Seen live: two sessions installing one checkout by a pull stopped
		// each other for ten minutes after, with nothing there to lose.
		mkdirSync(join(root, ".git"));
		const { fire } = await startSession();

		const pulled = await fire(
			"tool_call",
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "b",
				input: { command: "git pull -q --ff-only origin main" },
			},
			{ cwd: root },
		);

		expect(pulled).toBeUndefined();
		expect(ownBoard()).toEqual([]);
	});

	it("stops an edit once in a checkout another peer rewrote", async () => {
		mkdirSync(join(root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {
			subject: root,
			checkout: root,
			why: "git checkout main",
		});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as {
			block?: boolean;
			reason?: string;
		};
		const again = await fire(...editing("a.ts"));

		expect(first.block).toBe(true);
		expect(first.reason).toContain(
			`is working on what \`git checkout main\` left in ${root}, so what is there may not be what this peer read`,
		);
		expect(again).toBeUndefined();
		expect(ownBoard()).toMatchObject([
			{ kind: "change", subject: `${basename(root)}:a.ts`, checkout: root },
		]);
		expect(sentOut()[0]?.text).toContain("in the checkout this peer rewrote");
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

	it("takes up a group's question after all once the peer answering it lets it go", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { sent } = await startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		const asked = fromElsewhere({
			intent: "question",
			text: "who can look at 7M6JKG's tests?",
		});
		leased("session-p", { kind: "answer", subject: asked.id });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		// Looked at again many times, it stays P9R1KI's while P9R1KI has it.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sent).toHaveLength(1);

		// Its run ended with no answer sent.
		createBoard(join(paths.mesh, "leases")).hold({
			session: "session-p",
			leases: [],
		});

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.options).toEqual({ triggerTurn: true });
		expect(sent[1]?.message.details).toMatchObject({
			why: ["about this peer's work, let go unanswered by P9R1KI"],
		});
	});

	it("leaves a question let go be once another peer answered it", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { sent } = await startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			undefined,
			undefined,
			20,
		);
		const asked = fromElsewhere({
			intent: "question",
			text: "who can look at 7M6JKG's tests?",
		});
		leased("session-p", { kind: "answer", subject: asked.id });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		fromElsewhere({
			from: "P9R1KI",
			to: ["@WCJQSG"],
			re: asked.id,
			text: "done",
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		createBoard(join(paths.mesh, "leases")).hold({
			session: "session-p",
			leases: [],
		});

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toHaveLength(1);
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

	it("keeps a question claimed as each turn of the run answering it ends", async () => {
		const { sent, fire } = await startSession({}, { isIdle: () => true });
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const before = Date.parse(ownBoard()[0]?.until ?? "");

		const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 540_000);
		try {
			await fire("turn_end");
		} finally {
			later.mockRestore();
		}

		expect(Date.parse(ownBoard()[0]?.until ?? "")).toBeGreaterThan(
			before + 500_000,
		);
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

	it("carries on with a turn when a hold it parked for ends after a reboot", async () => {
		peer("session-w", ["WCJQSG"], []);
		const before = await startSession({}, { isIdle: () => true });
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });
		await before.tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "parked",
			re: hold.id,
		});
		await before.fire("session_shutdown");

		// Both come back after the reboot: this session restored, and its
		// holder under the same address with another pid.
		const { sent } = await startSession({}, { isIdle: () => true });
		fromElsewhere({ re: hold.id, text: "reboot done", pid: process.pid + 2 });

		await vi.waitFor(() =>
			expect(
				sent.find(({ message }) =>
					message.content.includes('its holder said "reboot done"'),
				)?.options,
			).toEqual({ triggerTurn: true }),
		);
		expect(ownBoard()).toEqual([]);
	});

	it("tells the machine queue whose work this peer is parked on", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools, fire } = await startSession();
		expect(awaitedNow()).toEqual(new Set());
		const hold = fromElsewhere({ intent: "hold", text: "kernel build first" });
		await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "parked",
			re: hold.id,
		});

		expect(awaitedNow()).toEqual(new Set(["session-w"]));
		await fire("session_shutdown");
		expect(awaitedNow()).toEqual(new Set());
	});

	it("ends unsaid when the peer holding it has ended, so is no go-ahead", async () => {
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
		const over = sent.find(({ message }) =>
			message.content.startsWith("The hold ["),
		)?.message.content;
		expect(over).toContain(
			`Its holder never said [${hold.id.split("-").pop()}] was over, so what it named may still be in use`,
		);
		expect(over).not.toContain("Carry on with what it held up");
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
			/^WCJQSG \(since \d\d:\d\d\) is running heavy work on qemu already/,
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

	it("leaves heavy work overlapping to the machine's queue while it is kept", async () => {
		const runtime = join(root, "run");
		mkdirSync(join(runtime, "jobs"), { recursive: true });
		writeFileSync(join(runtime, "jobs", "queue.json"), "{}\n");
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "qemu", why: "vm test" });
		const { sent, emit } = await startSession({ XDG_RUNTIME_DIR: runtime });

		emit(LEASE_EVENT, { take: { subject: "qemu", why: "flake check" } });

		await vi.waitFor(() =>
			expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "qemu" }]),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toEqual([]);
		expect(sentOut()).toEqual([]);
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
				subject: "build",
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
		expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "vm-test" }]);
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

	describe("a handed-off call's heavy work, through a reload", () => {
		const handedOff = async (run: Awaited<ReturnType<typeof startSession>>) => {
			await run.fire("tool_call", {
				type: "tool_call",
				toolName: "bash",
				toolCallId: "b3",
				input: { command: "qemu-system-x86_64" },
			});
			await run.fire("tool_result", {
				type: "tool_result",
				toolCallId: "b3",
				content: [
					{ type: "text", text: "Running in the background as job j1." },
				],
			});
		};
		const ended = {
			jobId: "j1",
			kind: "shell",
			toolCallId: "b3",
			failed: false,
		};

		it("stays claimed, and the runtime the reload starts lets it go when its job ends", async () => {
			const first = await startSession();
			await handedOff(first);
			await first.fire("session_shutdown", { reason: "reload" });
			expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "vm-test" }]);

			const next = await startSession();
			expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "vm-test" }]);
			next.emit(JOBS_FINISHED, ended);
			await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		});

		it("is let go when its job ends before the new runtime has started", async () => {
			const first = await startSession();
			await handedOff(first);
			await first.fire("session_shutdown", { reason: "reload" });

			await startSession({}, {}, [], undefined, undefined, (emit) =>
				emit(JOBS_FINISHED, ended),
			);
			await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		});

		it("is let go at once when the session ends any other way", async () => {
			const first = await startSession();
			await handedOff(first);
			await first.fire("session_shutdown", { reason: "new" });
			expect(ownBoard()).toEqual([]);
		});
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

	it("lists a peer's heavy work as the machine's queue holds it", async () => {
		const runtime = join(root, "run");
		mkdirSync(join(runtime, "jobs"), { recursive: true });
		writeFileSync(
			join(runtime, "jobs", "queue.json"),
			`${JSON.stringify({
				v: 1,
				jobs: [
					{
						id: "j1",
						class: "bulk",
						kind: "vm-check",
						state: "waiting",
						owner: { session: "session-w", pid: 1 },
						what: "nix build .#checks.vm-a",
						memoryGib: 6,
						since: new Date().toISOString(),
						place: 1,
					},
				],
			})}\n`,
		);
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "vm-check" });
		const { tools } = await startSession({ XDG_RUNTIME_DIR: runtime });

		const listed = await tools.get("mesh_groups")?.execute("call-g", {});

		expect(listed?.content[0]?.text).toMatch(
			/\nLeases:\nWCJQSG: waiting at place 1 to run a VM check, since \d\d:\d\d \(nix build \.#checks\.vm-a\)$/,
		);
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
					getSessionName: () => undefined,
					getCwd: () => root,
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
	it("works as the hands of the peer that starts it", async () => {
		const env: NodeJS.ProcessEnv = {};
		const { emitted } = await startSession(env);

		expect(emitted).toContainEqual([
			SUBAGENT_REGISTER_DEFAULT_EXTENSION,
			HAND_EXTENSION,
		]);
		// Named to what it starts, so a subagent knows whose hands it is.
		expect(env[MESH_SESSION_ENV]).toBe(session);
	});

	it("gets its hands from a fleet that says it is ready after the mesh loaded", async () => {
		const registered: unknown[] = [];
		await startSession({}, {}, [], undefined, undefined, (emit) =>
			emit(SUBAGENT_READY, {
				registerDefaultExtension: (path: unknown) => registered.push(path),
			}),
		);

		expect(registered).toEqual([HAND_EXTENSION]);
	});

	it("is not a peer of its own", async () => {
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

describe("ending another peer's hold on the person's word", () => {
	afterEach(() => restoreSessionModes({}));

	/** Answer a hold through the tool, saying the person ended it. */
	const ending = async (
		tools: Awaited<ReturnType<typeof startSession>>["tools"],
		re: string,
	) =>
		(
			await tools.get("mesh_send")?.execute("call-1", {
				intent: "fyi",
				text: "Joel says the reboot is done; carry on",
				re,
				endsHold: true,
			})
		)?.content[0]?.text ?? "";

	it("goes wherever the hold went, and waits on nothing", async () => {
		setSessionMode("mesh-end-hold", "redirect");
		const { tools } = await startSession();
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });

		const said = await ending(tools, hold.id);

		expect(sentOut()).toMatchObject([
			{ re: hold.id, endsHold: true, to: [ALL] },
		]);
		expect(said).toContain("ends [");
		expect(said).not.toContain("waits on");
		expect(ownBoard()).toEqual([]);
	});

	it("is not sent where nobody can confirm it", async () => {
		const { tools } = await startSession();
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });

		const said = await ending(tools, hold.id);

		expect(said).toMatch(/^Not sent: /);
		expect(sentOut()).toEqual([]);
	});

	it("is left out where it answers no other peer's hold", async () => {
		const { tools } = await startSession();
		const question = fromElsewhere({ intent: "question", text: "who?" });

		const said = await ending(tools, question.id);

		expect(sentOut()).toHaveLength(1);
		expect(sentOut()[0]?.endsHold).toBeUndefined();
		expect(said).toContain("is no other peer's hold");
	});
});
