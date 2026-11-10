/**
 * The engine the host service drives. Each conversation is pi's own
 * session, built by pi's runtime with the conversation's extensions loaded
 * under its id, on the host's agent and a durable store of its own. The
 * service decides when a conversation is held; the engine names it, starts
 * it, carries on what a restart cut off, and ends it, through SessionHost,
 * which owns who holds what.
 */
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type LaunchHints,
	SESSION_STAMP_EVENT,
	type SessionStamp,
	withSession,
} from "../../lib/core/session/index.ts";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { noteFirstPrompt } from "../../lib/internal/session/first-prompt-slot.ts";
import type {
	AdoptRequest,
	ConversationEngine,
	OpenRequest,
	Prepared,
} from "../service/backend.ts";
import { conversationAuthContext } from "./auth-context.ts";
import {
	HARNESS_SETTINGS_VARIABLE,
	harnessSettings,
} from "./harness-settings.ts";
import { loadHostPi } from "./host-pi.ts";
import type { HostedAgent } from "./hosted-agent.ts";
import {
	type HostedConversation,
	openHostedConversation,
} from "./hosted-conversation.ts";
import { piLibrary } from "./pi-library.ts";
import {
	type AgentSessionRuntime,
	type EventBus,
	loadProblems,
	type PiSessions,
	piBuiltInExtensions,
	piSessions,
	type RuntimeResult,
	type RuntimeTarget,
	type SessionManager,
	type SessionServices,
} from "./pi-session.ts";
import type { AssistantMessage, Model } from "./pi-types.ts";
import type { SessionHost } from "./session-host.ts";
import {
	hostedSubagentInstall,
	pinSubagentInstall,
} from "./subagent-install.ts";
import { conversationMarker, reapToolChildren } from "./tool-children.ts";

/** The gateway key every provider request carries, as the service keeps it. */
export interface EngineKey {
	current(): Promise<string>;
	refused(): void;
	readonly inherited: boolean;
}

/** What a conversation's own environment is chosen by. */
export interface ConversationTraits {
	readonly sessionId: string;
	readonly file: string;
	readonly cwd: string;
	readonly attended: boolean;
	readonly quest?: string;
}

/** One conversation as a screen drives it. */
export interface HostedView {
	readonly sessionId: string;
	/** pi's own runtime, which pi's InteractiveMode takes as its host. */
	readonly runtime: AgentSessionRuntime;
	/** End the conversation, as its screen's exit does. */
	close(why: string): Promise<void>;
}

/**
 * The screens over conversations. Given one, the engine leaves binding a
 * conversation's extensions to it, as pi's InteractiveMode does at its
 * start; without one, the engine binds them with no interface.
 */
export interface EngineScreens {
	/** A conversation is registered and built; its first words are still to come. */
	opened(view: HostedView): void | Promise<void>;
	/** A conversation became another (new, fork or resume) under a new id. */
	rebound(view: HostedView, previousId: string): void | Promise<void>;
	/**
	 * A conversation is ending: called first in its cleanup, before its
	 * session is disposed, so a screen stops before the session it watches
	 * goes.
	 */
	closed(sessionId: string): void | Promise<void>;
}

/** What the engine is made from. */
export interface EngineOptions {
	/** The host's pi install, carrying every host patch. */
	readonly packageDir: string;
	/** Where each conversation's durable store is kept, a folder per conversation. */
	readonly stateDir: string;
	readonly host: SessionHost;
	/** The realm's environment every conversation starts from. */
	readonly env: NodeJS.ProcessEnv;
	/** The gateway key, set in each request's environment; none leaves the environment as it is. */
	readonly key?: EngineKey;
	/**
	 * A conversation's own variables, laid over the realm's. Asked once, when
	 * it opens or is adopted; the roster holds the answer as its launch and a
	 * resume replays it as held, so a restart never derives it again.
	 */
	readonly conversationEnv?: (
		conversation: ConversationTraits,
		request: OpenRequest | AdoptRequest,
	) => Readonly<Record<string, string>>;
	readonly screens?: EngineScreens;
	readonly report?: (error: unknown) => void;
}

/** The variables the work provider reads its gateway key from, set from the key on each request. */
export const KEY_VARIABLES = ["SHOPIFY_PROXY_KEY", "PI_PROXY_API_KEY"] as const;

/** An answer the gateway gave a key it would not take. */
const REFUSED_KEY = /\b401\b/;

/** The durable store's file inside a conversation's folder. */
const STORE_FILE = "durable.sqlite";

/** One conversation the engine registered. */
interface Live {
	readonly traits: ConversationTraits;
	readonly bus: EventBus;
	runtime?: AgentSessionRuntime;
	conversation?: HostedConversation;
	ending?: SessionStamp["how"];
	unsubscribe?: () => void;
}

/** A conversation prepare named, waiting for its start, with the launch derived for it. */
interface Preparing {
	readonly manager: SessionManager;
	readonly traits: ConversationTraits;
	readonly launch: Readonly<Record<string, string>>;
}

/** The service's engine, and each conversation as a screen or test drives it. */
export interface HostEngine extends ConversationEngine {
	view(sessionId: string): HostedView | undefined;
}

/** Load the host's pi and make the engine over the host's ownership. */
export async function createEngine(
	options: EngineOptions,
): Promise<HostEngine> {
	const pi = await loadHostPi(options.packageDir);
	// Before any conversation's extensions load, so the first subagent finds it.
	pinSubagentInstall(hostedSubagentInstall(pi));
	const sessions = piSessions(pi.modules);
	const builtIns = piBuiltInExtensions(pi.modules);
	const library = piLibrary(pi.modules);
	const { host } = options;
	const report = options.report ?? (() => {});
	const prepared = new Map<string, Preparing>();
	const live = new Map<string, Live>();

	function held(sessionId: string, file: string): boolean {
		return (
			prepared.has(sessionId) ||
			host.holds(sessionId) !== undefined ||
			host.list().some((conversation) => conversation.file === file)
		);
	}

	/** The conversation's environment as one request sends it, the current key included. */
	async function requestEnv(
		sessionId: string,
	): Promise<Readonly<Record<string, string>>> {
		const values: Record<string, string> = {};
		for (const [name, value] of Object.entries(
			host.env(sessionId).snapshot(),
		)) {
			if (value !== undefined) values[name] = value;
		}
		if (options.key) {
			const key = await options.key.current();
			for (const name of KEY_VARIABLES) values[name] = key;
		}
		return values;
	}

	/** Whether a refused request is worth sending again, having asked for a fresh key. */
	async function renewed(error: AssistantMessage): Promise<boolean> {
		const key = options.key;
		if (!key || key.inherited || !REFUSED_KEY.test(error.errorMessage ?? ""))
			return false;
		key.refused();
		return true;
	}

	function view(sessionId: string, record: Live): HostedView {
		const runtime = record.runtime;
		if (!runtime) throw new Error(`Conversation is not built: ${sessionId}`);
		return {
			sessionId,
			runtime,
			close: (why) => host.close(sessionId, why),
		};
	}

	function agentOf(record: Live): HostedAgent {
		const agent = record.conversation?.agent;
		if (!agent)
			throw new Error(
				"pi built the conversation's session without the host's agent",
			);
		return agent;
	}

	/** pi's runtime factory for one conversation, which never becomes another. */
	function factory(
		record: Live,
		request: OpenRequest | AdoptRequest | undefined,
	): (target: RuntimeTarget) => Promise<RuntimeResult> {
		const { sessionId } = record.traits;
		return async (target) => {
			if (target.sessionManager.getSessionId() !== sessionId)
				throw new Error(
					"A hosted conversation can't become another yet; close it and open a new one",
				);
			const env = () => requestEnv(sessionId);
			const modelRuntime = await sessions.ModelRuntime.create({
				authPath: join(target.agentDir, "auth.json"),
				modelsPath: join(target.agentDir, "models.json"),
				authContext: conversationAuthContext(env),
			});
			const services = await sessions.createAgentSessionServices({
				cwd: target.cwd,
				agentDir: target.agentDir,
				modelRuntime,
				// pi's own built-ins, as its CLI passes them, so the conversation
				// has the tools a plain pi on the same settings has.
				resourceLoaderOptions: {
					eventBus: record.bus,
					extensionFactories: builtIns,
				},
			});
			// What the CLI would print as it starts, with no terminal to print on.
			for (const problem of loadProblems(services))
				report(new Error(`Conversation ${sessionId}: ${problem}`));
			const conversation = await openHostedConversation({
				modules: pi.modules,
				library,
				storePath: join(options.stateDir, sessionId, STORE_FILE),
				env,
				renewed,
				within: (work) => withSession(sessionId, work),
				report,
			});
			record.conversation = conversation;
			const opening = request?.op === "open" ? request : undefined;
			const model = opening?.model
				? requireModel(services, opening.model)
				: undefined;
			const created = await sessions.createAgentSession({
				cwd: target.cwd,
				agentDir: target.agentDir,
				modelRuntime: services.modelRuntime,
				settingsManager: services.settingsManager,
				resourceLoader: services.resourceLoader,
				sessionManager: target.sessionManager,
				...(target.sessionStartEvent
					? { sessionStartEvent: target.sessionStartEvent }
					: {}),
				...(model ? { model } : {}),
				...(opening?.thinkingLevel
					? { thinkingLevel: opening.thinkingLevel }
					: {}),
				createAgent: conversation.createAgent,
			});
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Bind a conversation's extensions with no interface, as pi's RPC mode does. */
	async function bindHeadless(sessionId: string, record: Live): Promise<void> {
		const runtime = view(sessionId, record).runtime;
		const session = runtime.session;
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				newSession: (next) => runtime.newSession(next),
				fork: (entryId, next) => runtime.fork(entryId, next),
				navigateTree: (targetId, next) =>
					runtime.session.navigateTree(targetId, next),
				switchSession: (path, next) => runtime.switchSession(path, next),
				reload: () => host.reload(sessionId, { reason: "an extension asked" }),
			},
			shutdownHandler: () => {
				host
					.close(sessionId, "an extension ended the conversation")
					.catch(report);
			},
			onError: (error) =>
				report(
					new Error(`Extension error (${error.extensionPath}): ${error.error}`),
				),
		});
	}

	/** Build a registered conversation, under its id, and carry on what it had in flight. */
	async function build(
		record: Live,
		manager: SessionManager,
		request: OpenRequest | AdoptRequest | undefined,
	): Promise<void> {
		const { sessionId, cwd } = record.traits;
		// What an earlier host's tools left running for it ends before this start reports them cut off.
		reapToolChildren(sessionId);
		const first = request?.op === "open" ? request.first : undefined;
		noteFirstPrompt(first);
		const sessionManager =
			request?.op === "open" ? keptFile(sessions, manager) : manager;
		record.runtime = await sessions.createAgentSessionRuntime(
			factory(record, request),
			{ cwd, agentDir: sessions.getAgentDir(), sessionManager },
		);
		const agent = agentOf(record);
		record.unsubscribe = record.runtime.session.subscribe((event) =>
			publishState(sessionId, event.type),
		);
		if (options.screens) await options.screens.opened(view(sessionId, record));
		else await bindHeadless(sessionId, record);
		const recovery = await agent.recover();
		if (first === undefined) {
			recovery.settled.catch(report);
			return;
		}
		await recovery.settled;
		await promptFirst(record, agent, first);
	}

	/** Send the first words; resolve once durable holds them, or pi took them as a command. */
	async function promptFirst(
		record: Live,
		agent: HostedAgent,
		first: string,
	): Promise<void> {
		const session = view(record.traits.sessionId, record).runtime.session;
		const admitted = agent.whenAdmitted();
		// Once the race is decided, a later rejection says only what the race already said, or concerns a later prompt.
		admitted.catch(() => undefined);
		let handled = () => {};
		const taken = new Promise<void>((done) => {
			handled = done;
		});
		const prompting = session.prompt(first, {
			source: "rpc",
			preflightResult: (disposition) => {
				if (disposition === "handled") handled();
			},
		});
		await Promise.race([admitted, taken, prompting]);
		prompting.catch(report);
	}

	/** Register a conversation, then build it under its id; one that fails once registered stays held, parked. */
	async function begin(
		traits: ConversationTraits,
		manager: SessionManager,
		launch: Readonly<Record<string, string>>,
		request?: OpenRequest | AdoptRequest,
	): Promise<void> {
		const { sessionId } = traits;
		const record: Live = { traits, bus: sessions.createEventBus() };
		host.register({
			id: sessionId,
			file: traits.file,
			cwd: traits.cwd,
			// What the engine derives comes after the launch, every start, so a held launch never overrides it.
			env: {
				...options.env,
				...launch,
				[HARNESS_SETTINGS_VARIABLE]: harnessSettings(
					options.env[HARNESS_SETTINGS_VARIABLE],
					{ attended: traits.attended },
					request,
					{ version: pi.version },
				),
				...conversationMarker(sessionId),
			},
			hints: hintsFor(request),
			close: () => end(sessionId, record),
			stamp: (how) => {
				record.ending = how;
				const stamp: SessionStamp = { session: sessionId, how };
				record.bus.emit(SESSION_STAMP_EVENT, stamp);
			},
			reload: () => reload(record),
		});
		live.set(sessionId, record);
		try {
			await host.run(sessionId, () => build(record, manager, request));
		} catch (error) {
			try {
				host.state(sessionId, "parked");
			} catch (parking) {
				// Closing already: the close parks it, and the start's error is what the caller must see.
				report(parking);
			}
			throw error;
		}
	}

	/** Release a conversation's session and store, keeping a stopped run for the next start. */
	async function end(sessionId: string, record: Live): Promise<void> {
		if (record.runtime) await options.screens?.closed(sessionId);
		const agent = record.conversation?.agent;
		if (record.ending !== "closed") agent?.park();
		else await record.runtime?.session.abort();
		record.unsubscribe?.();
		await record.runtime?.dispose();
		// Closing signals a running tool and writes no outcome, so the next start reports it cut off.
		try {
			await record.conversation?.close();
		} finally {
			// The signal kills a tool's own group; a descendant that left it ends here.
			reapToolChildren(sessionId);
			live.delete(sessionId);
		}
	}

	/** Say on the host's list whether a conversation is running, as its runs start and end. */
	function publishState(sessionId: string, event: string): void {
		const state =
			event === "agent_start"
				? "busy"
				: event === "agent_end"
					? "idle"
					: undefined;
		if (!state || host.holds(sessionId) === "parked") return;
		try {
			host.state(sessionId, state);
		} catch (error) {
			report(error);
		}
	}

	/** Load a conversation's extensions again once its run is done, as pi's /reload does. */
	async function reload(record: Live): Promise<void> {
		const session = view(record.traits.sessionId, record).runtime.session;
		await session.waitForIdle();
		await session.reload();
	}

	return {
		view(sessionId) {
			const record = live.get(sessionId);
			return record?.runtime ? view(sessionId, record) : undefined;
		},

		async prepare(request) {
			const manager =
				request.op === "open"
					? sessions.SessionManager.create(folder(request.cwd))
					: sessions.SessionManager.open(adoptable(request.sessionFile));
			const sessionId = manager.getSessionId();
			const file = manager.getSessionFile();
			if (!file) throw new Error("pi named no file for the conversation");
			if (held(sessionId, file))
				throw new Error(`Conversation already held: ${sessionId}`);
			const cwd = manager.getCwd();
			const traits: ConversationTraits = {
				sessionId,
				file,
				cwd,
				attended: request.attended,
				...(request.quest ? { quest: request.quest } : {}),
			};
			const launch = { ...options.conversationEnv?.(traits, request) };
			prepared.set(sessionId, { manager, traits, launch });
			return {
				sessionId,
				file,
				cwd,
				...(Object.keys(launch).length > 0 ? { launch } : {}),
			};
		},

		async start(conversation: Prepared, request) {
			const preparing = prepared.get(conversation.sessionId);
			if (!preparing)
				throw new Error(
					`Conversation was not prepared: ${conversation.sessionId}`,
				);
			prepared.delete(conversation.sessionId);
			const { manager, traits, launch } = preparing;
			await begin(traits, manager, launch, request);
		},

		async discard(conversation) {
			prepared.delete(conversation.sessionId);
		},

		async resume(entry: RosterEntry) {
			if (host.holds(entry.sessionId) !== undefined)
				throw new Error(`Conversation already running: ${entry.sessionId}`);
			if (!existsSync(entry.file))
				throw new Error(
					`Conversation ${entry.sessionId} has lost its session file: ${entry.file}`,
				);
			const manager = sessions.SessionManager.open(entry.file);
			if (manager.getSessionId() !== entry.sessionId)
				throw new Error(
					`${entry.file} now holds conversation ${manager.getSessionId()}, not ${entry.sessionId}`,
				);
			const { sessionId, file, cwd, attended, quest, launch } = entry;
			await begin(
				{ sessionId, file, cwd, attended, ...(quest ? { quest } : {}) },
				manager,
				launch ?? {},
			);
		},

		async abort(sessionId) {
			const record = live.get(sessionId);
			if (!record) throw new Error(`Conversation is not hosted: ${sessionId}`);
			const session = view(sessionId, record).runtime.session;
			await host.run(sessionId, () => session.abort());
		},
	};
}

/**
 * The session manager over a kept file. pi writes a session's file only
 * once it holds an answer, and pi opening a file that isn't there names a
 * new conversation, so a conversation held before its first answer would
 * come back from a restart as another. The header is written at start, as
 * pi writes it, and the file opened as pi opens any other.
 */
function keptFile(
	sessions: PiSessions,
	manager: SessionManager,
): SessionManager {
	const file = manager.getSessionFile();
	if (!file) throw new Error("pi named no file for the conversation");
	if (!existsSync(file))
		writeFileSync(file, `${JSON.stringify(manager.getHeader())}\n`, {
			flag: "wx",
		});
	return sessions.SessionManager.open(file);
}

/** The model an open names, refused when no provider of the conversation's has it. */
function requireModel(
	services: SessionServices,
	wanted: { readonly provider: string; readonly id: string },
): Model {
	const model = services.modelRuntime.getModel(wanted.provider, wanted.id);
	if (!model)
		throw new Error(
			`No model ${wanted.provider}/${wanted.id} for this conversation`,
		);
	return model;
}

function folder(cwd: string): string {
	if (!isAbsolute(cwd))
		throw new Error(`A conversation's folder must be absolute: ${cwd}`);
	if (!existsSync(cwd)) throw new Error(`No such folder: ${cwd}`);
	return resolve(cwd);
}

function adoptable(sessionFile: string): string {
	if (!isAbsolute(sessionFile))
		throw new Error(`A session file to adopt must be absolute: ${sessionFile}`);
	if (!existsSync(sessionFile))
		throw new Error(`No session file to adopt: ${sessionFile}`);
	return resolve(sessionFile);
}

/** What a conversation's extensions are told once, at its start. */
function hintsFor(
	request: OpenRequest | AdoptRequest | undefined,
): LaunchHints {
	if (!request) return {};
	return {
		...(request.quest ? { questId: request.quest } : {}),
		...(request.op === "open" && request.first !== undefined
			? { firstWords: request.first }
			: {}),
	};
}
