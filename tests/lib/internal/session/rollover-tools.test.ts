/**
 * A rolled-over log, resumed by pi itself, comes back with the tools the
 * session had. pi rebuilds a resumed session's tools by replaying the
 * system messages on its branch, so this boots real pi sessions over a
 * faux model rather than restating that replay.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type InlineExtension,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import rolloverWorkflow from "../../../../extensions/rollover-workflow/index.ts";
import {
	builtInsLostToRollover,
	type Entry,
	isSystemEntry,
	type Rolled,
	rollOver,
	writeRolled,
} from "../../../../lib/internal/session/rollover.ts";

/** The tools pi declares by itself, which only the first system message names. */
const BUILT_IN = ["read", "bash", "edit", "write"];

let dir: string;
let agentDir: string;
let faux: FauxProviderHandle;
const saved = {
	agent: process.env.PI_CODING_AGENT_DIR,
	offline: process.env.PI_OFFLINE,
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rollover-tools-"));
	agentDir = mkdtempSync(join(tmpdir(), "rollover-tools-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
});

afterEach(() => {
	process.env.PI_CODING_AGENT_DIR = saved.agent;
	process.env.PI_OFFLINE = saved.offline;
	rmSync(dir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

/** An extension tool the session can put away, as a loadout does. */
const extension: InlineExtension = {
	name: "rollover-tools",
	hidden: true,
	factory: (pi) => {
		pi.registerProvider(faux.provider);
		for (const name of ["kept_tool", "put_away"]) {
			pi.registerTool({
				name,
				label: name,
				description: `The ${name} tool.`,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			});
		}
	},
};

/** The rollover workflow itself, loaded as pi loads an extension. */
const workflow: InlineExtension = {
	name: "rollover-workflow",
	hidden: true,
	factory: rolloverWorkflow,
};

/**
 * A pi session over `sessions`, as a restart would open it, with its
 * extensions started when `start` is set.
 */
async function open(
	sessions: SessionManager,
	options: { start?: boolean } = {},
): Promise<AgentSession> {
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir,
		resourceLoaderOptions: {
			noExtensions: true,
			extensionFactories: options.start ? [extension, workflow] : [extension],
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
		},
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: sessions,
		model: faux.getModel(),
	});
	if (options.start) await session.bindExtensions({});
	return session;
}

/** One turn, so pi records the tools it declared. */
async function turn(session: AgentSession, text: string): Promise<void> {
	faux.appendResponses([fauxAssistantMessage(`answer to ${text}`)]);
	await session.prompt(text);
}

/**
 * A session that declared its tools, put one away, and compacted with a
 * kept tail after that, written to disk by pi.
 */
async function compactedSession(): Promise<SessionManager> {
	const sessions = SessionManager.create(dir, dir);
	const session = await open(sessions);
	await turn(session, "first");
	session.setActiveToolsByName(
		session.getActiveToolNames().filter((name) => name !== "put_away"),
	);
	await turn(session, "second");
	const kept = sessions.getLeafId();
	await turn(session, "kept");
	sessions.appendCompaction("what happened early", kept, 1000);
	await turn(session, "after");
	session.dispose();
	return sessions;
}

/**
 * The log a rollover writes for `sessions`, opened from disk; `older`
 * writes it as rollovers did before they folded the system messages.
 */
function rolled(
	sessions: SessionManager,
	options: { older?: boolean } = {},
): SessionManager {
	const fresh = rollOver(sessions.getBranch() as unknown as Entry[], {
		parentSession: sessions.getSessionFile() ?? "",
		cwd: sessions.getCwd(),
		version: sessions.getHeader()?.version,
	});
	if (!fresh) throw new Error("expected a rollover");
	return SessionManager.open(
		writeRolled(dir, options.older ? unfolded(fresh) : fresh),
	);
}

/** A fresh log without its folded system message, relinked around it. */
function unfolded(fresh: Rolled): Rolled {
	const fold = fresh.entries.find(isSystemEntry);
	const entries = fresh.entries
		.filter((entry) => entry !== fold)
		.map((entry) =>
			entry.parentId === fold?.id
				? { ...entry, parentId: fold?.parentId ?? null }
				: entry,
		);
	return { ...fresh, entries };
}

/**
 * A log rolled over before the fold, then changed by a turn and
 * restarted, which is how a session lost its built-in tools.
 */
async function brokenByRestart(): Promise<SessionManager> {
	const fresh = rolled(await compactedSession(), { older: true });
	const session = await open(fresh);
	session.setActiveToolsByName(
		session.getActiveToolNames().filter((name) => name !== "kept_tool"),
	);
	await turn(session, "in the fresh log");
	session.dispose();
	return SessionManager.open(fresh.getSessionFile() ?? "");
}

describe("a rolled-over log resumed by pi", () => {
	it("comes back with the built-in tools after it changed its tools", async () => {
		const fresh = rolled(await compactedSession());
		const session = await open(fresh);
		session.setActiveToolsByName(
			session.getActiveToolNames().filter((name) => name !== "kept_tool"),
		);
		await turn(session, "in the fresh log");
		session.dispose();
		const restarted = await open(
			SessionManager.open(fresh.getSessionFile() ?? ""),
		);

		expect(restarted.getActiveToolNames()).toEqual(
			expect.arrayContaining(BUILT_IN),
		);
		expect(restarted.getActiveToolNames()).not.toContain("kept_tool");
		restarted.dispose();
	});

	it("comes back with the tools the parent would, and no others", async () => {
		const sessions = await compactedSession();
		const parent = await open(
			SessionManager.open(sessions.getSessionFile() ?? ""),
		);
		const resumed = await open(rolled(sessions));

		expect([...resumed.getActiveToolNames()].sort()).toEqual(
			[...parent.getActiveToolNames()].sort(),
		);
		expect(resumed.getActiveToolNames()).toContain("kept_tool");
		expect(resumed.getActiveToolNames()).not.toContain("put_away");
		parent.dispose();
		resumed.dispose();
	});
});

describe("a log rolled over before the fold", () => {
	it("is resumed by pi without its built-in tools", async () => {
		const restarted = await open(await brokenByRestart());

		for (const name of BUILT_IN) {
			expect(restarted.getActiveToolNames()).not.toContain(name);
		}
		restarted.dispose();
	});

	it("gets them back when the workflow starts on it", async () => {
		const restarted = await open(await brokenByRestart(), { start: true });

		expect(restarted.getActiveToolNames()).toEqual(
			expect.arrayContaining(BUILT_IN),
		);
		expect(restarted.getActiveToolNames()).not.toContain("kept_tool");
		restarted.dispose();
	});

	it("is the only kind that lost any", async () => {
		const sessions = await compactedSession();

		expect(builtInsLostToRollover(sessions.getBranch())).toEqual([]);
		expect(builtInsLostToRollover(rolled(sessions).getBranch())).toEqual([]);
		expect(
			builtInsLostToRollover(rolled(sessions, { older: true }).getBranch()),
		).toEqual(BUILT_IN);
	});
});
