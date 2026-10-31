/**
 * A session that rolls over goes on answering with the model and
 * thinking level it had, and one left on no model says so. On 31
 * October four sessions rolled over onto no model and sat dead. This
 * drives pi's real runtime and switch, over a model an extension
 * registers by config, as the proxy extension registers every model
 * those sessions ran on; here the extension registers it only once its
 * session starts, which is after pi's switch restores the model.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	type InlineExtension,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import rolloverWorkflow, {
	COMMAND,
} from "../../../extensions/rollover-workflow/index.ts";

/** The provider and model the session runs on. */
const PROVIDER = "proxied";
const MODEL = "faux-1";

let dir: string;
let agentDir: string;
let faux: ReturnType<typeof createFauxCore>;
let registering: boolean;
let runtime: AgentSessionRuntime | undefined;
let notices: { text: string; kind?: string }[];
const saved = {
	agent: process.env.PI_CODING_AGENT_DIR,
	offline: process.env.PI_OFFLINE,
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rollover-model-"));
	agentDir = mkdtempSync(join(tmpdir(), "rollover-model-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	faux = createFauxCore({
		provider: PROVIDER,
		models: [{ id: MODEL, reasoning: true }],
	});
	registering = true;
	notices = [];
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	process.env.PI_CODING_AGENT_DIR = saved.agent;
	process.env.PI_OFFLINE = saved.offline;
	rmSync(dir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

/** The provider, registered once a session starts while `registering`. */
function register(pi: ExtensionAPI): void {
	if (!registering) return;
	pi.registerProvider(PROVIDER, {
		api: faux.api,
		streamSimple: faux.streamSimple,
		baseUrl: "http://proxied.invalid",
		apiKey: "proxied-key",
		models: [
			{
				id: MODEL,
				name: MODEL,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
}

const provider: InlineExtension = {
	name: "rollover-model-provider",
	hidden: true,
	factory: (pi) => {
		pi.on("session_start", () => register(pi));
	},
};

const workflow: InlineExtension = {
	name: "rollover-workflow",
	hidden: true,
	factory: rolloverWorkflow,
};

/**
 * pi's runtime over `sessions`, its first session put on the model and
 * thinking level once its extensions are up, as a person choosing them
 * does, and every later one left to restore them.
 */
async function start(sessions: SessionManager): Promise<AgentSessionRuntime> {
	const create: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				extensionFactories: [provider, workflow],
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const host = await createAgentSessionRuntime(create, {
		cwd: dir,
		agentDir,
		sessionManager: sessions,
	});
	const bind = async () => {
		await host.session.bindExtensions({
			uiContext: {
				notify: (text: string, kind?: string) => notices.push({ text, kind }),
			} as never,
			commandContextActions: {
				waitForIdle: () => host.session.waitForIdle(),
				newSession: (options) => host.newSession(options),
				fork: async (entryId, options) => ({
					cancelled: (await host.fork(entryId, options)).cancelled,
				}),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: (path, options) => host.switchSession(path, options),
				reload: () => host.session.reload(),
			},
		});
	};
	host.setRebindSession(bind);
	await bind();
	const model = host.session.modelRuntime.getModel(PROVIDER, MODEL);
	if (!model) throw new Error("the provider's model is not registered");
	await host.session.setModel(model);
	host.session.setThinkingLevel("high");
	return host;
}

/** Ask and wait for the answer. */
async function ask(host: AgentSessionRuntime, text: string): Promise<void> {
	faux.appendResponses([fauxAssistantMessage(`answer to ${text}`)]);
	await host.session.prompt(text);
}

/** The last thing the assistant said, or the error it stopped on. */
function lastAnswer(host: AgentSessionRuntime): string {
	const messages = host.session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return `error: ${message.errorMessage}`;
		return message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
	}
	return "";
}

/** A runtime over a session that has answered twice and compacted. */
async function compacted(): Promise<AgentSessionRuntime> {
	const sessions = SessionManager.create(dir, dir);
	const host = await start(sessions);
	await ask(host, "first");
	const kept = sessions.getLeafId();
	await ask(host, "kept");
	sessions.appendCompaction("what happened early", kept ?? "", 1000);
	return host;
}

describe("a session that rolls over", () => {
	it("still answers, on the model and thinking level it had", async () => {
		runtime = await compacted();
		const before = runtime.session.sessionFile;

		await runtime.session.prompt(`/${COMMAND}`);

		expect(runtime.session.sessionFile).not.toBe(before);
		expect(runtime.session.model?.provider).toBe(PROVIDER);
		expect(runtime.session.model?.id).toBe(MODEL);
		expect(runtime.session.thinkingLevel).toBe("high");
		await ask(runtime, "after");
		expect(lastAnswer(runtime)).toBe("answer to after");
		expect(notices.filter((notice) => notice.kind === "error")).toEqual([]);
	});

	it("says so in its window when the model it had can't be found", async () => {
		runtime = await compacted();
		registering = false;

		await runtime.session.prompt(`/${COMMAND}`);

		const errors = notices.filter((notice) => notice.kind === "error");
		expect(errors.map((notice) => notice.text)).toEqual([
			`This session has no model, so it can't answer. It ran on ${PROVIDER}/${MODEL} before rolling over, which can't be found now. Choose one with /model.`,
		]);
	});
});
