/**
 * One conversation's durable side: its own store, harness and registry,
 * opened before pi builds the conversation's session, so pi's
 * createAgentSession can be given the agent that runs on it. Each
 * conversation keeps its own store, so its settings and models are its own
 * and closing it touches no other.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	Conversation,
	DurableContext,
	Extension,
	GenerationHooks,
	Harness,
	Registry,
	ToolRegistration,
} from "./durable-types.ts";
import type { HostPiModules } from "./host-pi.ts";
import { HostedAgent } from "./hosted-agent.ts";
import type { PiLibrary } from "./pi-library.ts";
import type { AgentOptions, AssistantMessage } from "./pi-types.ts";

/** The durable extension's name; one per conversation's registry. */
export const HOSTED_EXTENSION = "pi-host";

/** A conversation's durable side, ready for pi to build its agent on. */
export interface HostedConversation {
	/** The agent pi's createAgentSession gets from its createAgent option. */
	createAgent(options: AgentOptions): HostedAgent;
	/** The agent, once pi built it. */
	readonly agent: HostedAgent | undefined;
	/** Close the conversation's store; its agent must be idle. */
	close(): Promise<void>;
}

interface DurableModule {
	readonly Harness: {
		open(
			storage: unknown,
			options: object,
			context: DurableContext,
		): Promise<Harness>;
	};
	readonly createRegistry: () => Registry;
	readonly defineExtension: (extension: Extension) => Extension;
	readonly hook: (task: unknown, handlers: GenerationHooks) => unknown;
	readonly GenerationTask: unknown;
}

/** Open a conversation's durable store at `storePath` and its root conversation. */
export async function openHostedConversation(options: {
	readonly modules: HostPiModules;
	readonly library: PiLibrary;
	readonly storePath: string;
	/** The conversation's complete environment, read at each request. */
	readonly env: () => Promise<Readonly<Record<string, string>>>;
	/** Whether a refused request's credential was since renewed, so it is sent once more. */
	readonly renewed?: (error: AssistantMessage) => Promise<boolean>;
	/** Run work as this conversation's own, whoever scheduled it. */
	readonly within?: <T>(work: () => T) => T;
	readonly report?: (error: unknown) => void;
}): Promise<HostedConversation> {
	const durable = durableModule(options.modules);
	const context = backgroundContext(options.modules);
	const openStorage = options.modules.sqlite.openNodeSqliteStorage;
	if (typeof openStorage !== "function")
		throw new Error("The host's pi-durable has no SQLite storage for Node");
	await mkdir(dirname(options.storePath), { recursive: true });
	const storage: unknown = await openStorage(options.storePath);
	const registry = durable.createRegistry();
	let agent: HostedAgent | undefined;
	const built = (): HostedAgent => {
		if (!agent)
			throw new Error("Durable asked for the host's agent before pi built it");
		return agent;
	};
	const harness = await durable.Harness.open(
		storage,
		{
			models: () => built().models,
			registry,
			settings: () => agent?.settings(),
			onReport: (report: { error: unknown }) => options.report?.(report.error),
		},
		context,
	);
	const root: Conversation = await harness.root(context);
	return {
		get agent() {
			return agent;
		},
		createAgent(agentOptions) {
			if (agent) throw new Error("This conversation's agent is built already");
			agent = new HostedAgent(agentOptions, options.library, {
				conversation: root,
				registry,
				context,
				abortSubmission: (id) => harness.abortSubmission(id, context),
				resume: () => harness.resume(),
				extension: (
					tools: readonly ToolRegistration[],
					hooks: GenerationHooks,
				) =>
					durable.defineExtension({
						name: HOSTED_EXTENSION,
						tools,
						hooks: [durable.hook(durable.GenerationTask, hooks)],
					}),
				env: options.env,
				...(options.renewed ? { renewed: options.renewed } : {}),
				...(options.within ? { within: options.within } : {}),
			});
			// Durable resumes from the agent's recover, once pi's session holds the agent and can show what it does.
			return agent;
		},
		async close() {
			await harness.close(context);
		},
	};
}

function durableModule(modules: HostPiModules): DurableModule {
	const { Harness, createRegistry, defineExtension, hook, GenerationTask } =
		modules.durable;
	const missing = Object.entries({
		Harness,
		createRegistry,
		defineExtension,
		hook,
		GenerationTask,
	})
		.filter(([, value]) => value === undefined)
		.map(([name]) => name);
	if (missing.length > 0)
		throw new Error(`The host's pi-durable lacks ${missing.join(", ")}`);
	// Checked present above; each is pi-durable's documented export.
	return modules.durable as unknown as DurableModule;
}

function backgroundContext(modules: HostPiModules): DurableContext {
	const context = modules.context.BACKGROUND_CONTEXT;
	if (typeof context !== "object" || context === null) {
		throw new Error("The host's chord has no background context");
	}
	return context as DurableContext;
}
