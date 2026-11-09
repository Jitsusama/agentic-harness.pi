/**
 * A hosted conversation reloads through its host: the tool asks, the end
 * of that conversation's run hands the request to the host, the host
 * reloads that conversation alone, and its new runtime says it landed.
 * The host's reload is played by starting a second instance of the
 * extension for that conversation, as the runner adapter's reload does.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HOSTED_RELOAD_ONTO } from "../../../extensions/reload-workflow/hosted.ts";
import reloadWorkflow from "../../../extensions/reload-workflow/index.ts";
import { PACKAGE_ROOT } from "../../../extensions/reload-workflow/lifecycle.ts";
import { HOSTED_RELOAD } from "../../../extensions/reload-workflow/transitions.ts";
import {
	type HostReloadRequest,
	installHost,
	withSession,
} from "../../../lib/core/session/index.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import { sessionHost } from "../../support/session-host.ts";
import { until } from "../../support/until.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Tool {
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { text: string }[] }>;
}

interface Command {
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Each runtime asks git what runs, so a landing may take seconds. */
const LANDING_MS = 20_000;
const LANDS = LANDING_MS + 10_000;

/** One runtime of the extension, driven as a host drives it. */
interface Runtime {
	hidden: string[];
	notices: string[];
	start(reason: string): Promise<void>;
	settle(aborted?: boolean): Promise<void>;
	ask(params: object): Promise<{ content: { text: string }[] }>;
	command(args: string): Promise<void>;
}

let dir: string;
let uninstall: (() => void) | undefined;
let closeAll: () => void = () => {};
/** What the host was asked to reload, by conversation. */
let asked: [string, HostReloadRequest][];
/** How the host's runner answers a reload; a fresh runtime by default. */
let runner: (id: string) => Promise<void>;
/** The newest runtime of each conversation. */
let runtimes: Map<string, Runtime>;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

/** One runtime of the extension for conversation `id`, as a host loads it. */
function runtime(id: string): Runtime {
	const handlers = new Map<string, Handler[]>();
	const hidden: string[] = [];
	const notices: string[] = [];
	let tool: Tool | undefined;
	let command: Command | undefined;
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: (_name: string, definition: Command) => {
			command = definition;
		},
		registerTool: (definition: Tool) => {
			tool = definition;
		},
		sendMessage: (message: { content: string; display: boolean }) => {
			if (!message.display) hidden.push(message.content);
		},
		sendUserMessage: () => {},
		appendEntry: () => {},
	};
	const ctx = {
		cwd: dir,
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => id },
		ui: {
			setStatus: () => {},
			notify: (text: string) => notices.push(text),
			theme: { fg: (_colour: string, text: string) => text },
		},
	};
	reloadWorkflow(pi as unknown as ExtensionAPI);
	// Inside its conversation, as a host runs every hook.
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? [])
			await withSession(id, () => handler(event, ctx));
	};
	const made: Runtime = {
		hidden,
		notices,
		start: (reason: string) => fire("session_start", { reason }),
		settle: (aborted = false) => fire("agent_settled", { aborted }),
		ask: (params: object) =>
			withSession(id, () =>
				tool
					? tool.execute("t1", params, undefined, undefined, ctx)
					: Promise.reject(new Error("no tool")),
			),
		command: (args: string) =>
			withSession(id, async () =>
				command?.handler(args, { ...ctx, waitForIdle: async () => {} }),
			),
	};
	runtimes.set(id, made);
	return made;
}

/** Install a host over conversations a and b, reloading as `runner` says. */
function host(reloads = true) {
	const { host } = sessionHost({ pid: process.pid, startedAt: Date.now() });
	const withReload = reloads
		? {
				...host,
				reload: async (id: string, request: HostReloadRequest) => {
					asked.push([id, request]);
					await withSession(id, () => runner(id));
				},
			}
		: host;
	uninstall = installHost(withReload);
	closeAll = () => {
		host.close("a", "test cleanup");
		host.close("b", "test cleanup");
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "host-reload-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [PACKAGE_ROOT] }),
	);
	asked = [];
	runtimes = new Map();
	runner = (id) => runtime(id).start("reload");
});

afterEach(() => {
	closeAll();
	uninstall?.();
	uninstall = undefined;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

it(
	"reloads only the conversation that asked, once its run ends, and says it landed",
	async () => {
		host();
		const a = runtime("a");
		const b = runtime("b");
		await a.start("startup");
		await b.start("startup");

		const answer = await a.ask({ reason: "try it" });
		expect(answer.content[0]?.text).toMatch(
			/^Reload queued: the host reloads this conversation alone/,
		);
		expect(asked, "nothing reloads while the run goes on").toEqual([]);

		await b.settle();
		expect(asked, "B's settle hands on nothing of A's").toEqual([]);
		await a.settle();
		await until("A's new runtime says it landed", () =>
			Boolean(runtimes.get("a")?.hidden.length),
		);

		expect(asked).toEqual([["a", { reason: "try it" }]]);
		expect(runtimes.get("a")).not.toBe(a);
		expect(runtimes.get("b"), "B was never reloaded").toBe(b);
		expect(runtimes.get("a")?.hidden[0]).toMatch(
			/^Reloaded, as asked: try it\./,
		);
		expect(b.hidden, "B is told nothing").toEqual([]);
		expect(reloadSlot().request, "the process's slot is untouched").toBe(
			undefined,
		);
	},
	LANDS,
);

it(
	"refuses a tree, and calls a request off when the person stops the run",
	async () => {
		host();
		const a = runtime("a");
		await a.start("startup");

		await expect(a.ask({ reason: "x", onto: "/trees/other" })).rejects.toThrow(
			HOSTED_RELOAD_ONTO,
		);
		await a.ask({ reason: "try it" });
		await a.settle(true);
		await a.settle();

		expect(asked).toEqual([]);
		expect(a.notices).toEqual(["Reload called off: you stopped the run."]);
	},
	LANDS,
);

it(
	"reloads from the command, and says a reload the host could not do",
	async () => {
		host();
		const a = runtime("a");
		await a.start("startup");

		await a.command("reload");
		await until("A's new runtime says it landed", () =>
			Boolean(runtimes.get("a")?.hidden.length),
		);
		expect(asked).toEqual([
			["a", { reason: "you asked with /harness reload" }],
		]);
		expect(runtimes.get("a")?.hidden[0]).toMatch(
			/^Reloaded, as asked: you asked with \/harness reload\./,
		);

		const now = runtimes.get("a");
		runner = async () => {
			throw new Error("runner busy");
		};
		await now?.command("reload");
		await until("the failure is said", () => Boolean(now?.notices.length));
		expect(now?.notices).toEqual([
			"Nothing was reloaded: the host could not reload this conversation: runner busy.",
		]);
	},
	LANDS,
);

it("leaves the stale-rejection net to the host, adding no process listener", () => {
	// The net goes on once per process; clear that, so each load could add it.
	const net = Symbol.for("pi:harness:stale-rejections:v1");
	const saved = Reflect.get(globalThis, net);
	const before = process.listeners("unhandledRejection");
	try {
		Reflect.deleteProperty(globalThis, net);
		host();
		runtime("a");
		runtime("b");
		expect(
			process.listenerCount("unhandledRejection"),
			"no hosted load adds one",
		).toBe(before.length);

		closeAll();
		uninstall?.();
		uninstall = undefined;
		closeAll = () => {};
		runtime("plain");
		expect(
			process.listenerCount("unhandledRejection"),
			"plain pi's load still adds it",
		).toBe(before.length + 1);
	} finally {
		for (const listener of process.listeners("unhandledRejection"))
			if (!before.includes(listener))
				process.off("unhandledRejection", listener);
		if (saved === undefined) Reflect.deleteProperty(globalThis, net);
		else Reflect.set(globalThis, net, saved);
	}
});

it(
	"refuses as before in a host that can't reload a conversation",
	async () => {
		host(false);
		const a = runtime("a");
		await a.start("startup");

		await expect(a.ask({ reason: "try it" })).rejects.toThrow(HOSTED_RELOAD);
		await a.command("reload");

		expect(a.notices).toEqual([HOSTED_RELOAD]);
	},
	LANDS,
);
