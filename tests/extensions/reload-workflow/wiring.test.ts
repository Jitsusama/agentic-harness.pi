/**
 * The reload workflow driven through the events pi emits: the tool
 * asks, the end of the run hands the request to the command, the
 * command reloads, and the new runtime says it landed. pi's `reload()`
 * is played by starting a second instance of the extension, which is
 * what a reload does, in an agent dir of the test's own.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	type EventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import reloadWorkflow from "../../../extensions/reload-workflow/index.ts";
import {
	PACKAGE_ROOT,
	STATUS_KEY,
} from "../../../extensions/reload-workflow/lifecycle.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import { announceJobHost, type Job } from "../../../lib/jobs/index.ts";
import { FOOTER_GLYPH } from "../../../lib/ui/footer-mark.ts";
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

const GIT_SOURCE = "git:github.com/Jitsusama/agentic-harness.pi";

let dir: string;
let agentDir: string;
let events: EventBus;
let reported: string[];
const disposers: (() => void)[] = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

/** Name the packages the settings hold. */
function settingsName(packages: unknown[]): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
}

function packagesOnDisk(): unknown {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
		.packages;
}

/** One runtime of the extension, as pi would load it. */
function runtime() {
	const handlers = new Map<string, Handler[]>();
	const hidden: string[] = [];
	const sentToPrompt: { text: string; options: unknown }[] = [];
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	const entries: { type: string; data: unknown }[] = [];
	let tool: Tool | undefined;
	let command: Command | undefined;
	// A runtime the session replaced: pi refuses its captured pi from then on.
	let replaced = false;
	const live = () => {
		if (replaced) {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		}
	};
	const pi = {
		events,
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
			live();
			if (!message.display) hidden.push(message.content);
		},
		sendUserMessage: (text: string, options: unknown) =>
			sentToPrompt.push({ text, options }),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	const ui = {
		setStatus: (key: string, text: string | undefined) =>
			statuses.set(key, text),
		notify: (text: string) => notices.push(text),
		theme: { fg: (_colour: string, text: string) => text },
	};
	reloadWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown = {}, ctx: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, { ui, cwd: dir, ...(ctx as object) });
		}
	};
	return {
		/** The session replaced this runtime, as a rollover does. */
		replace: () => {
			replaced = true;
		},
		hidden,
		entries,
		sentToPrompt,
		statuses,
		notices,
		fire,
		start: (reason: string) => fire("session_start", { reason }),
		ask: (params: object) =>
			tool?.execute("t1", params, undefined, undefined, { cwd: dir, ui }) ??
			Promise.reject(new Error("no tool")),
		/** Run `/harness <args>`; `reload()` brings up `next`. */
		command: (
			args: string,
			next?: { start: (reason: string) => Promise<void> },
		) =>
			command?.handler(args, {
				ui,
				cwd: dir,
				waitForIdle: async () => {},
				isIdle: () => true,
				hasPendingMessages: () => false,
				reload: async () => {
					await next?.start("reload");
				},
			}),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reload-wiring-"));
	agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	events = createEventBus();
	reported = [];
	disposers.push(
		announceJobHost(events, {
			start: (): Job => ({
				id: "j1",
				signal: new AbortController().signal,
				finish: (outcome) => {
					reported.push(outcome.summary);
				},
				onDelivered: () => {},
				withdraw: () => false,
			}),
		}),
	);
	const slot = reloadSlot();
	slot.request = undefined;
	slot.dispatched = undefined;
	slot.reloading = undefined;
	slot.landed = undefined;
	slot.unsaid = undefined;
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

/** The install pi's settings name is the code that runs. */
function runningTheInstall(): void {
	settingsName([PACKAGE_ROOT]);
}

/** The settings name a git install; the code that runs is this checkout. */
function runningATree(): string {
	const install = join(
		agentDir,
		"git",
		"github.com",
		"Jitsusama",
		"agentic-harness.pi",
	);
	mkdirSync(install, { recursive: true });
	writeFileSync(
		join(install, "package.json"),
		JSON.stringify({ name: "agentic-harness.pi" }),
	);
	settingsName([GIT_SOURCE]);
	return install;
}

describe("the agent asking for a reload", () => {
	it("queues it for the end of the run and says to end the turn", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");

		const answer = await now.ask({ reason: "try it", onto: "installed" });

		expect(answer.content[0]?.text).toMatch(
			/^Reload queued onto the install\./,
		);
		expect(answer.content[0]?.text).toContain("end your turn now");
		expect(now.sentToPrompt).toEqual([]);
	});

	it("reads an onto given as null as left out, not as a path named null", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");

		// Raw, and as the string pi's schema coercion makes of it.
		for (const onto of [null, "null"]) {
			const answer = await now.ask({ reason: "try it", onto });
			expect(answer.content[0]?.text).toMatch(
				/^Reload queued onto the install\./,
			);
		}
	});

	it("hands it to the command once, when the run ends", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		await now.ask({ reason: "try it" });

		await now.fire("agent_settled");
		await now.fire("agent_settled");

		expect(now.sentToPrompt).toEqual([
			{ text: "/harness reload", options: { expandPromptTemplates: true } },
		]);
	});

	it("waits for a run that started after it was handed over, whatever pi says", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		await now.ask({ reason: "try it" });
		await now.fire("agent_settled");
		// The run a compaction resumes, starting before the command runs.
		await now.fire("agent_start");
		let reloaded = false;
		const next = {
			start: async () => {
				reloaded = true;
			},
		};

		const command = now.command("reload", next);
		await new Promise((done) => setTimeout(done, 1_500));
		expect(reloaded).toBe(false);

		await now.fire("agent_settled");
		await command;
		expect(reloaded).toBe(true);
		expect(now.entries).toMatchObject([
			{ type: "reload-waited-for-run", data: { times: expect.any(Number) } },
		]);
	}, 10_000);

	it("is called off when the person stops the run", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		await now.ask({ reason: "try it" });

		await now.fire("agent_settled", { aborted: true });
		await now.fire("agent_settled");

		expect(now.sentToPrompt).toEqual([]);
		expect(now.notices).toContain("Reload called off: you stopped the run.");
	});

	it("comes back as a turn, through the job host, saying what runs", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		await now.ask({ reason: "try the new mark" });
		await now.fire("agent_settled");

		const next = runtime();
		await now.command("reload", next);
		await until("the reload is said", () => reported.length > 0);

		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatch(
			/^Reloaded, as asked: try the new mark\. agentic-harness\.pi runs its install, /,
		);
		expect(reported[0]).toMatch(/Carry on from where you were\.$/);
		expect(next.hidden).toEqual([]);
	});

	it("refuses a directory that is not this package", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		mkdirSync(join(dir, "elsewhere"));

		await expect(
			now.ask({ reason: "x", onto: join(dir, "elsewhere") }),
		).rejects.toThrow(/is not a checkout of agentic-harness\.pi/);
		expect(reloadSlot().request).toBeUndefined();
	});
});

describe("a reload that lands as the session is replaced", () => {
	// On 22 October a rollover replaced the session while a landing was
	// still asking git what runs, and the stale pi's throw took pi down.
	const landing = { reason: "feat: x", by: "person" } as const;

	it("hands the landing to the runtime that replaced it", async () => {
		runningTheInstall();
		const old = runtime();
		await old.start("startup");
		const say = reloadSlot().landed;
		old.replace();
		const next = runtime();
		await next.start("resume");

		say?.(landing);
		await until("the landing is said", () => next.hidden.length > 0);

		expect(next.hidden[0]).toContain("as asked: feat: x.");
	});

	it("tells the model of its own reload quietly, never the person", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");

		reloadSlot().landed?.({ reason: "feat: y", by: "self" });
		await until("the model is told", () => now.hidden.length > 0);

		expect(now.hidden[0]).toContain(
			"Reloaded between runs, because the install moved: feat: y.",
		);
	});

	it("keeps a landing its replaced runtime could not say for the next one", async () => {
		runningTheInstall();
		const old = runtime();
		await old.start("startup");
		old.replace();

		reloadSlot().landed?.(landing);
		await until("it is kept", () => reloadSlot().unsaid !== undefined);
		const next = runtime();
		await next.start("resume");

		expect(next.hidden).toHaveLength(1);
		expect(next.hidden[0]).toContain("as asked: feat: x.");
		expect(reloadSlot().unsaid).toBeUndefined();
	});
});

describe("a reload nobody asked the agent for", () => {
	it("tells the model quietly which code now runs", async () => {
		runningTheInstall();
		const next = runtime();
		await next.start("reload");

		expect(next.hidden).toHaveLength(1);
		expect(next.hidden[0]).toMatch(
			/^The harness was reloaded\. agentic-harness\.pi runs its install, /,
		);
		expect(reported).toEqual([]);
	});

	it("says nothing at startup, when nothing changed under the model", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		expect(now.hidden).toEqual([]);
	});

	it("drops a request the old code was still waiting to run", async () => {
		runningTheInstall();
		const now = runtime();
		await now.start("startup");
		await now.ask({ reason: "try it" });

		const next = runtime();
		await next.start("reload");
		await next.fire("agent_settled");

		expect(next.sentToPrompt).toEqual([]);
		expect(next.hidden).toHaveLength(1);
	});
});

describe("running a tree in place of the install", () => {
	it("shows the mark only while the tree runs", async () => {
		runningATree();
		const tree = runtime();
		await tree.start("startup");
		expect(tree.statuses.get(STATUS_KEY)).toBe(FOOTER_GLYPH.swapped);

		runningTheInstall();
		const install = runtime();
		await install.start("startup");
		expect(install.statuses.get(STATUS_KEY)).toBeUndefined();
	});

	it("points the settings at the tree for the reload alone", async () => {
		runningATree();
		const now = runtime();
		await now.start("startup");

		let duringReload: unknown;
		const next = runtime();
		await now.command("reload", {
			...next,
			start: async (reason: string) => {
				duringReload = packagesOnDisk();
				await next.start(reason);
			},
		});

		await until("the reload is said", () => next.hidden.length > 0);

		expect(duringReload).toEqual([PACKAGE_ROOT]);
		expect(packagesOnDisk()).toEqual([GIT_SOURCE]);
		expect(next.statuses.get(STATUS_KEY)).toBe(FOOTER_GLYPH.swapped);
		expect(next.hidden[0]).toMatch(
			/^Reloaded onto .*, as asked: you asked with \/harness reload\. agentic-harness\.pi runs .*, not its install: /,
		);
		expect(reported).toEqual([]);
	});

	it("says what runs, and where the install is, on /harness", async () => {
		const install = runningATree();
		const now = runtime();
		await now.start("startup");
		await now.command("");
		expect(now.notices[0]).toContain(`not its install: the install is`);
		expect(now.notices[0]).toContain(install.split("/").slice(-2).join("/"));
	});
});
