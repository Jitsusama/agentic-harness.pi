/**
 * A session that changed its tools and then compacted still leads its
 * next request with the head it first sent, so the provider's cached
 * prompt and tools answer for it. This boots real pi sessions over a
 * faux model and compacts them with pi's own compaction, since what a
 * compaction puts at the head is pi's to decide.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
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
import {
	KEEP_HEAD_ENV,
	registerFirstHead,
} from "../../../extensions/compaction-workflow/head.ts";

let dir: string;
let agentDir: string;
let faux: FauxProviderHandle;
/** The messages of every request the faux model was sent, in order. */
let sent: Message[][];
const saved = {
	agent: process.env.PI_CODING_AGENT_DIR,
	offline: process.env.PI_OFFLINE,
	keep: process.env[KEEP_HEAD_ENV],
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "first-head-"));
	agentDir = mkdtempSync(join(tmpdir(), "first-head-agent-"));
	// Kept this small, a few short turns leave pi something to compact.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	delete process.env[KEEP_HEAD_ENV];
	faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	sent = [];
});

afterEach(() => {
	process.env.PI_CODING_AGENT_DIR = saved.agent;
	process.env.PI_OFFLINE = saved.offline;
	if (saved.keep === undefined) delete process.env[KEEP_HEAD_ENV];
	else process.env[KEEP_HEAD_ENV] = saved.keep;
	rmSync(dir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

/** A tool the session puts away, as a loadout or a search changes tools. */
const tools: InlineExtension = {
	name: "first-head-tools",
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

/** A tool far larger than the rest of the head, as a big loaded tool is. */
const large: InlineExtension = {
	name: "first-head-large-tool",
	hidden: true,
	factory: (pi) => {
		pi.registerTool({
			name: "large_tool",
			label: "large_tool",
			description: "A large tool. ".repeat(2_000),
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
		});
	},
};

/** Just the head keeping, loaded as pi loads an extension. */
const keeping: InlineExtension = {
	name: "first-head",
	hidden: true,
	factory: registerFirstHead,
};

async function open(options: {
	keep: boolean;
	large?: boolean;
}): Promise<AgentSession> {
	const factories = [tools, ...(options.large ? [large] : [])];
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir,
		resourceLoaderOptions: {
			noExtensions: true,
			extensionFactories: options.keep ? [...factories, keeping] : factories,
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
		},
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.create(dir, dir),
		model: faux.getModel(),
	});
	await session.bindExtensions({});
	return session;
}

/** A reply that records the request it answers. */
function reply(text: string) {
	return (context: { messages: Message[] }) => {
		sent.push(structuredClone(context.messages));
		return fauxAssistantMessage(text);
	};
}

async function turn(session: AgentSession, text: string): Promise<Message[]> {
	faux.appendResponses([reply(`answer to ${text}`)]);
	await session.prompt(text);
	return sent[sent.length - 1] ?? [];
}

/**
 * The requests before and after a compaction, for a session that put a
 * tool away between its first turn and the compaction.
 */
async function aroundCompaction(options: {
	keep: boolean;
}): Promise<{ before: Message[]; after: Message[] }> {
	const session = await open(options);
	const before = await turn(session, "first");
	session.setActiveToolsByName(
		session.getActiveToolNames().filter((name) => name !== "put_away"),
	);
	await turn(session, "second");
	await turn(session, "third");
	// pi summarises the history and, when a turn is split, its start.
	faux.appendResponses([reply("what happened"), reply("how it started")]);
	await session.compact();
	const after = await turn(session, "after the compaction");
	session.dispose();
	return { before, after };
}

/** The system messages a request sent, without the times no provider sends. */
const systemOf = (messages: Message[]) =>
	messages
		.filter((message) => message.role === "system")
		.map(({ timestamp: _sent, ...rest }) => rest);

const names = (messages: Message[]) =>
	getCurrentTools(messages)
		.map((tool) => tool.name)
		.sort();

describe("a request after a compaction", () => {
	it("leads, without it, with a head other than the one first sent", async () => {
		const { before, after } = await aroundCompaction({ keep: false });

		expect(systemOf(after)[0]).not.toEqual(systemOf(before)[0]);
	});

	it("leads with the head the session first sent", async () => {
		const { before, after } = await aroundCompaction({ keep: true });

		expect(after[0]).toEqual(before[0]);
	});

	it("gives the model the same prompt and tools pi's own head would", async () => {
		const pis = await aroundCompaction({ keep: false });
		const kept = await aroundCompaction({ keep: true });

		expect(names(kept.after)).toEqual(names(pis.after));
		expect(names(kept.after)).not.toContain("put_away");
		expect(getCurrentSystemPrompt(kept.after)).toBe(
			getCurrentSystemPrompt(pis.after),
		);
	});

	it("leads with pi's own head once what changed outgrows the first", async () => {
		const session = await open({ keep: true, large: true });
		const all = session.getActiveToolNames();
		session.setActiveToolsByName(all.filter((name) => name !== "large_tool"));
		const before = await turn(session, "first");
		session.setActiveToolsByName(all);
		await turn(session, "second");
		await turn(session, "third");
		faux.appendResponses([reply("what happened"), reply("how it started")]);
		await session.compact();
		const after = await turn(session, "after the compaction");
		const later = await turn(session, "and after that");
		session.dispose();

		expect(names(before)).not.toContain("large_tool");
		expect(systemOf(after)).toHaveLength(1);
		expect(names(after)).toContain("large_tool");
		expect(later[0]).toEqual(after[0]);
	});

	it("keeps pi's own head when keeping is turned off", async () => {
		process.env[KEEP_HEAD_ENV] = "off";
		const { before, after } = await aroundCompaction({ keep: true });

		expect(systemOf(after)[0]).not.toEqual(systemOf(before)[0]);
	});
});

describe("a request before any compaction", () => {
	it("is sent as pi built it, its tool change a patch after the head", async () => {
		const sentBy = async (keep: boolean) => {
			const session = await open({ keep });
			await turn(session, "first");
			session.setActiveToolsByName(
				session.getActiveToolNames().filter((name) => name !== "put_away"),
			);
			const second = await turn(session, "second");
			session.dispose();
			return second;
		};
		const plain = await sentBy(false);
		const kept = await sentBy(true);

		expect(systemOf(plain)).toHaveLength(2);
		expect(systemOf(kept)).toEqual(systemOf(plain));
	});
});
