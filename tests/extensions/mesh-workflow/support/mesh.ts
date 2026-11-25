/**
 * What every test of the mesh as a session meets it runs in: a fresh
 * mesh under a temporary folder, with a session whose record names its
 * quest, and the sessions a test starts shut down after it. Importing
 * this sets that up around every test in the file.
 *
 * Beside it, the pieces several of those tests share: a session started
 * on the extension with just enough of pi, another peer's message,
 * presence and lease as it would write them, a classifier's answer, and
 * the fixture's quest.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
	type MeshPaths,
	meshWorkflow,
} from "../../../../extensions/mesh-workflow/index.ts";
import type { HubTiming } from "../../../../extensions/mesh-workflow/tools/above.ts";
import type { ExecResult } from "../../../../lib/core/exec/exec.ts";
import { isRecord } from "../../../../lib/internal/record.ts";
import {
	type Authored,
	answerAuthored,
} from "../../../../lib/internal/session/authored.ts";
import { ALL } from "../../../../lib/mesh/group.ts";
import { createBoard, type Lease } from "../../../../lib/mesh/lease.ts";
import type { Draft, Message } from "../../../../lib/mesh/message.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../../lib/mesh/transport.ts";
import { alongside } from "../../../support/turn-end.ts";

/** The session every test starts, by its id. */
export const session = "01a15f3a-2255-7463-9909-afa624b025fe";

/**
 * The test's temporary folder and the mesh's folders under it, made
 * fresh before each test. A test that needs another folder, such as
 * what waits on the person, adds it to `paths` before it starts a session.
 */
export const fixture: {
	root: string;
	paths: MeshPaths;
	// What a command the extension runs through pi answers, for a test
	// that fakes one; with none, running a command fails as it would
	// with no such program.
	exec?: (command: string, args: readonly string[]) => Promise<ExecResult>;
} = {
	root: "",
	paths: { mesh: "", sessions: "", quests: "" },
};

/** How to shut down each session the test started. */
let stops: (() => Promise<void>)[] = [];

beforeEach(() => {
	fixture.root = mkdtempSync(join(tmpdir(), "mesh-workflow-"));
	fixture.paths = {
		mesh: join(fixture.root, "mesh"),
		sessions: join(fixture.root, "sessions"),
		quests: join(fixture.root, "quests"),
	};
	fixture.exec = undefined;
	mkdirSync(fixture.paths.sessions, { recursive: true });
	writeFileSync(
		join(fixture.paths.sessions, `${session}.json`),
		JSON.stringify({ quest: "QEST-20261021-7M6JKG" }),
		"utf8",
	);
	stops = [];
});

afterEach(async () => {
	for (const stop of stops) await stop();
	rmSync(fixture.root, { recursive: true, force: true });
});

/** What the extension handed pi to send, with the options it asked for. */
export type Sent = {
	message: {
		customType: string;
		content: string;
		display?: boolean;
		details?: unknown;
	};
	options: unknown;
};
type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = {
	handler: (args: string, ctx: unknown) => Promise<void>;
};
/** A message renderer the extension registered with pi. */
export type Renderer = (
	message: Sent["message"],
	options: { expanded: boolean },
	theme: unknown,
) => { render: (width: number) => string[] };

/**
 * A session's environment naming a realm whose node isn't there, for a
 * test that means no node to answer: an empty one would fall back to the
 * machine's own realm file and, on a Mac, its temporary folder, and so
 * reach a real node.
 */
export function noNode(): NodeJS.ProcessEnv {
	return {
		MYCELIUM_REALM: "work",
		XDG_RUNTIME_DIR: join(fixture.root, "no-node"),
	};
}

/** Start a session on the extension, with just enough of pi to run it. */
export async function startSession(
	env: NodeJS.ProcessEnv = {},
	ctx: Record<string, unknown> = {},
	branch: unknown[] = [],
	settling = { settleMs: 40, spreadMs: 0 },
	waitCheckMs = 60_000,
	// Said on the bus once the extension loads, before the session starts.
	early: (emit: (channel: string, data: unknown) => void) => void = () => {},
	lookAgainMs = 60_000,
	// How often the hub from use is found again, left to the extension.
	hubTiming: HubTiming = {},
) {
	// No machine's owners file: a test reads only the one it writes.
	env.PI_OWNERS_FILE ??= join(fixture.root, "no-owners.txt");
	const sent: Sent[] = [];
	const emitted: [string, unknown][] = [];
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const entries: { type: string; data: unknown }[] = [];
	const lifecycle = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const renderers = new Map<string, Renderer>();
	const tools = new Map<
		string,
		{
			execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
		}
	>();
	const pi = {
		on: (event: string, handler: Handler) =>
			lifecycle.set(event, alongside(lifecycle, event, handler)),
		registerTool: (tool: { name: string }) =>
			tools.set(tool.name, tool as never),
		sendMessage: (message: Sent["message"], options?: unknown) =>
			sent.push({ message, options }),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		exec: (command: string, args: readonly string[]) =>
			fixture.exec
				? fixture.exec(command, args)
				: Promise.reject(new Error(`no ${command} in this test`)),
		registerEntryRenderer: () => {},
		registerMessageRenderer: (type: string, renderer: Renderer) =>
			renderers.set(type, renderer),
		registerCommand: (name: string, command: Command) =>
			commands.set(name, command),
		events: {
			on: (channel: string, handler: (data: unknown) => void) =>
				bus.set(channel, [...(bus.get(channel) ?? []), handler]),
			emit: (channel: string, data: unknown) => {
				emitted.push([channel, data]);
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
	};
	// The review integration's side, which says who wrote a change: no
	// host claims a URL until a test says otherwise.
	let authorship: (url: string) => Authored = () => ({ by: "no-change" });
	answerAuthored(pi.events as never, async (url) => authorship(url));
	meshWorkflow(
		fixture.paths,
		env,
		settling,
		waitCheckMs,
		lookAgainMs,
		hubTiming,
	)(pi as never);
	early(pi.events.emit);
	const started = {
		hasUI: false,
		cwd: fixture.root,
		sessionManager: {
			getSessionId: () => session,
			getSessionFile: () => join(fixture.root, `${session}.jsonl`),
			getBranch: () => branch,
			// The branch read back from its last entry, as pi's walk reads it.
			getLeafId: () => idOf(branch.at(-1)),
			getEntry: (id: string) => branch.find((entry) => idOf(entry) === id),
			getSessionName: () => undefined,
			getCwd: () => fixture.root,
		},
		...ctx,
	};
	await lifecycle.get("session_start")?.({ reason: "startup" }, started);
	stops.push(async () => {
		await lifecycle.get("session_shutdown")?.({}, {});
	});
	const fire = (event: string, payload: unknown = {}, at: unknown = {}) =>
		lifecycle.get(event)?.(payload, at);
	// The same session starting again in this runtime, as after it ends.
	const restart = () =>
		lifecycle.get("session_start")?.({ reason: "startup" }, started);
	return {
		sent,
		tools,
		entries,
		fire,
		restart,
		emit: pi.events.emit,
		emitted,
		/** Say from now on what a change's host answers of who wrote it. */
		whoWrote: (judge: (url: string) => Authored) => {
			authorship = judge;
		},
		commands,
		renderers,
	};
}

/**
 * A model registry holding one classifier that answers `about` so, and
 * a routing question's `to` so when given.
 */
export function judging(about: unknown, calls: unknown[] = [], to?: unknown) {
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

/** A classifier's answer that a message is about another peer's work. */
export const notYours = {
	type: "choice",
	choice: "other",
	probabilities: { other: 0.93, receiver: 0.05, machine: 0.02 },
};

/** A message from another peer, sent the way it sends one. */
export function fromElsewhere(over: Partial<Draft> = {}): Message {
	return folderTransport(join(fixture.paths.mesh, "messages")).send({
		from: "WCJQSG",
		to: [ALL],
		intent: "fyi",
		text: "hold heavy builds until I say done",
		pid: process.pid + 1,
		...over,
	});
}

/** Send through the tool, and hand back what it answered. */
export async function send(
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
export function peer(
	session: string,
	addresses: string[],
	groups: string[],
	ended = false,
) {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
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

/** The fixture's quest, under 5GV2AH, with this worktree's checkout. */
export function onQuest() {
	const readme = (id: string, parent: string) =>
		`---\nid: ${id}\nkind: quest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# ${id}\n`;
	for (const [id, parent] of [
		["QEST-20261021-7M6JKG", "QEST-20261021-5GV2AH"],
		["QEST-20261021-5GV2AH", "null"],
	] as const) {
		mkdirSync(join(fixture.paths.quests, id), { recursive: true });
		writeFileSync(
			join(fixture.paths.quests, id, "README.md"),
			readme(id, parent),
		);
	}
}

/** Set or lift a stop through the tool, and hand back what it answered. */
export async function stopping(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	params: { peer: string; why?: string; lift?: boolean },
): Promise<string> {
	const answer = await tools.get("mesh_stop")?.execute("call-s", params);
	return answer?.content[0]?.text ?? "";
}

/** Another peer's lease, written to the board as that peer would. */
export function leased(owner: string, over: Partial<Lease>) {
	const now = Date.now();
	createBoard(join(fixture.paths.mesh, "leases")).hold({
		session: owner,
		leases: [
			{
				kind: "change",
				subject: join(fixture.root, "a.ts"),
				since: new Date(now - 60_000).toISOString(),
				until: new Date(now + 600_000).toISOString(),
				...over,
			},
		],
	});
}

/** This peer's leases on the board. */
export function ownBoard(): readonly Lease[] {
	return (
		createBoard(join(fixture.paths.mesh, "leases")).of(session)?.leases ?? []
	);
}

/** What the mesh sent other peers, as they would read it. */
export function sentOut(): Message[] {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport
		.ids()
		.map((id) => transport.read(id))
		.filter((one): one is Message => one?.pid === process.pid);
}

/** A branch entry's id, when it carries one. */
function idOf(entry: unknown): string | undefined {
	return isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
}

/** This peer, paused by its person. */
export function pausedByItsPerson(): ReturnType<typeof createPresences> {
	const presences = createPresences(join(fixture.paths.mesh, "presence"));
	presences.publish({
		session,
		addresses: [],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		state: "paused",
		at: new Date().toISOString(),
	});
	return presences;
}
