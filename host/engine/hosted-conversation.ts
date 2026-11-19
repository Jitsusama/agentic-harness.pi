/**
 * One conversation's durable side: its own store, harness and registry,
 * opened before pi builds the conversation's session, so pi's
 * createAgentSession can be given the agent that runs on it. Each
 * conversation keeps its own store, so its settings and models are its own
 * and closing it touches no other.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { withCallSignal } from "../../lib/core/exec/call-signal.ts";
import { isRecord } from "../../lib/internal/record.ts";
import type { Checkpoints } from "./checkpoints.ts";
import type {
	Conversation,
	DurableContext,
	Extension,
	GenerationHooks,
	Harness,
	Registry,
	RunFailure,
	ToolRegistration,
} from "./durable-types.ts";
import type { HostPiModules } from "./host-pi.ts";
import { HostedAgent } from "./hosted-agent.ts";
import type { PiLibrary } from "./pi-library.ts";
import type { AgentOptions, AssistantMessage } from "./pi-types.ts";
import type { StoreDatabase, StoreThreads } from "./store-threads.ts";

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
	/** The token of a conversation's `pi.live` document. */
	readonly LiveDoc: unknown;
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
	/** The host's checkpointer, which keeps the store's checkpoints off the host's thread. */
	readonly checkpoints?: Checkpoints;
	/** The host's store threads, which read and write the store off the host's thread. */
	readonly stores: StoreThreads;
}): Promise<HostedConversation> {
	const durable = durableModule(options.modules);
	const context = backgroundContext(options.modules);
	const openStorage = storageOpener(options.modules);
	await mkdir(dirname(options.storePath), { recursive: true });
	const database = await options.stores.open(
		options.storePath,
		options.checkpoints?.storeOptions,
	);
	let storage: unknown;
	try {
		storage = await openStorage(database);
	} catch (error) {
		// The storage's failure is the one said; the store is let go either way.
		await database.close().catch(() => {});
		throw error;
	}
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
	// Kept once open, so a store that failed to open leaves nothing kept.
	const kept = options.checkpoints?.keep(options.storePath);
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
				runFailure: async () =>
					failureIn(await harness.snapshot(durable.LiveDoc, root.id, context)),
				carrying: async () =>
					busyIn(await harness.snapshot(durable.LiveDoc, root.id, context)),
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
				// Durable starts each task in the context of whatever kicked its drain, as a review
				// call running under its own signal, which durable aborts as that call ends. Starting
				// the conversation's work under no call's signal keeps a later call's commands alive.
				within: (work) =>
					withCallSignal(undefined, () =>
						options.within ? options.within(work) : work(),
					),
			});
			// Durable resumes from the agent's recover, once pi's session holds the agent and can show what it does.
			return agent;
		},
		async close() {
			// Checkpointed first, off the thread, so the store's own TRUNCATE as it closes finds nothing left to copy.
			try {
				try {
					await kept?.settle();
				} catch (error) {
					// A checkpoint that couldn't be asked for leaves it to the store's own close.
					options.report?.(error);
				}
				await harness.close(context);
			} finally {
				kept?.release();
			}
		},
	};
}

/** The run failure a conversation's `pi.live` document holds, if any. */
function failureIn(live: unknown): RunFailure | undefined {
	if (!isRecord(live) || !isRecord(live.runFailure)) return undefined;
	const { taskId, reason } = live.runFailure;
	return typeof taskId === "number" && typeof reason === "string"
		? { taskId, reason }
		: undefined;
}

/** Whether a conversation's `pi.live` document holds a run, as it does exactly while busy. */
function busyIn(live: unknown): boolean {
	return isRecord(live) && isRecord(live.run);
}

/**
 * pi-durable's `SqliteStorage.open`, which takes any database keeping
 * chord's contract, as the host's store threads do.
 */
function storageOpener(
	modules: HostPiModules,
): (database: StoreDatabase) => Promise<unknown> {
	const { SqliteStorage } = modules.sqlite;
	// pi-durable's is a class, so a function, whose static open is read off it.
	const open: unknown =
		typeof SqliteStorage === "function" || isRecord(SqliteStorage)
			? Reflect.get(SqliteStorage, "open")
			: undefined;
	if (typeof open !== "function")
		throw new Error("The host's pi-durable has no SQLite storage");
	return async (database) => Reflect.apply(open, SqliteStorage, [database]);
}

function durableModule(modules: HostPiModules): DurableModule {
	const {
		Harness,
		createRegistry,
		defineExtension,
		hook,
		GenerationTask,
		LiveDoc,
	} = modules.durable;
	const missing = Object.entries({
		Harness,
		createRegistry,
		defineExtension,
		hook,
		GenerationTask,
		LiveDoc,
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
