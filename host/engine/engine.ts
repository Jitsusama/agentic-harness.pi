/**
 * The engine the host service drives. Each conversation is pi's own
 * session, built by pi's runtime with the conversation's extensions loaded
 * under its id, on the host's agent and a durable store of its own. The
 * service decides when a conversation is held; the engine names it, starts
 * it, carries on what a restart cut off, and ends it, through SessionHost,
 * which owns who holds what. A conversation that becomes another (pi's
 * /new, /fork, /resume or import) is held under its new id before pi builds
 * it, and the one it was ends with it.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
	ConversationEvents,
	OpenRequest,
	Prepared,
} from "../service/backend.ts";
import { conversationAuthContext } from "./auth-context.ts";
import type {
	ConversationTraits,
	EngineOptions,
	HostEngine,
	HostedView,
} from "./contract.ts";
import {
	HARNESS_SETTINGS_VARIABLE,
	type HarnessRequest,
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
	type PiSessions,
	piBuiltInExtensions,
	piSessions,
	type RuntimeResult,
	type RuntimeTarget,
	type SessionManager,
	type StartupDiagnostic,
	startupDiagnostics,
} from "./pi-session.ts";
import type { AssistantMessage } from "./pi-types.ts";
import { projectTrust, type StartupQuestion } from "./project-trust.ts";
import { holdReplacements } from "./replacement.ts";
import {
	adoptable,
	folder,
	hintsFor,
	namesCommand,
	requireModel,
} from "./requests.ts";
import { loaderOptions } from "./resources.ts";
import {
	hostedSubagentInstall,
	pinSubagentInstall,
} from "./subagent-install.ts";
import {
	conversationMarker,
	ownerMark,
	reapLeftBehind,
	reapToolChildren,
} from "./tool-children.ts";

/** The variables the work provider reads its gateway key from, set from the key on each request. */
export const KEY_VARIABLES = ["SHOPIFY_PROXY_KEY", "PI_PROXY_API_KEY"] as const;

/** An answer the gateway gave a key it would not take. */
const REFUSED_KEY = /\b401\b/;

/** The durable store's file inside a conversation's folder. */
const STORE_FILE = "durable.sqlite";

/** One conversation the engine registered. */
interface Live {
	readonly traits: ConversationTraits;
	readonly launch: Readonly<Record<string, string>>;
	readonly bus: EventBus;
	/** pi's runtime, while it runs this conversation; another it became takes it on. */
	runtime?: AgentSessionRuntime;
	conversation?: HostedConversation;
	ending?: SessionStamp["how"];
	unsubscribe?: () => void;
	/** pi disposed the session itself, replacing it. */
	disposed?: boolean;
	/** Its screen was asked about its folder, so the screen holds something of it however its build ends. */
	questioned?: boolean;
	/** Said once its screen first asks the person something before its session exists. */
	asked?: () => void;
	/** Its close has begun, so a build still under way stops short of a session. */
	closing?: boolean;
}

/**
 * One pi runtime and the conversation it runs: the current one, and the
 * one it is becoming while pi builds it.
 */
interface Seat {
	current: Live;
	next?: Live;
}

/** A conversation prepare named, waiting for its start, with the launch derived for it. */
interface Preparing {
	readonly manager: SessionManager;
	readonly traits: ConversationTraits;
	readonly launch: Readonly<Record<string, string>>;
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
	const trust = projectTrust(pi.modules);
	const library = piLibrary(pi.modules);
	const { host } = options;
	const report = options.report ?? (() => {});
	// Before the service resumes or admits anything: what this host's dead predecessors' tools left running ends first, held or not.
	const owner = ownerMark();
	const reaped = reapLeftBehind(host.key);
	if (reaped.groups.length > 0 || reaped.pids.length > 0)
		report(
			new Error(
				`Ended what an earlier host's tools left running: groups ${reaped.groups.join(", ") || "none"}, processes ${reaped.pids.join(", ") || "none"}`,
			),
		);
	const prepared = new Map<string, Preparing>();
	const live = new Map<string, Live>();
	let watched: ConversationEvents | undefined;

	function held(sessionId: string, file: string): boolean {
		return (
			prepared.has(sessionId) ||
			host.holds(sessionId) !== undefined ||
			fileHeld(file)
		);
	}

	function fileHeld(file: string): boolean {
		return (
			host.list().some((conversation) => conversation.file === file) ||
			[...prepared.values()].some(({ traits }) => traits.file === file)
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

	/**
	 * pi's runtime factory for one seat: the conversation it was started for,
	 * then each it becomes, held under its new id before pi builds it.
	 */
	function factory(
		seat: Seat,
		request: OpenRequest | AdoptRequest | undefined,
	): (target: RuntimeTarget) => Promise<RuntimeResult> {
		return async (target) => {
			const { current } = seat;
			if (target.sessionManager.getSessionId() === current.traits.sessionId)
				return await session(current, target, target.sessionManager, {
					starting: true,
					...(request ? { request } : {}),
				});
			const next = await becoming(current, target);
			seat.next = next;
			return await host.run(next.traits.sessionId, () =>
				session(next, target, keptFile(sessions, target.sessionManager), {
					starting: false,
				}),
			);
		};
	}

	/**
	 * Hold the conversation a seat's current one is becoming: the service
	 * first, then the host, with the same launch, folder kind and quest, and
	 * its settings derived afresh for a new or forked conversation or as a
	 * resumed one.
	 */
	async function becoming(
		previous: Live,
		target: RuntimeTarget,
	): Promise<Live> {
		const manager = target.sessionManager;
		const sessionId = manager.getSessionId();
		const named = manager.getSessionFile();
		if (!named) throw new Error("pi named no file for the conversation");
		const file = resolve(named);
		if (held(sessionId, file))
			throw new Error(`Conversation already held: ${sessionId}`);
		const { attended, quest } = previous.traits;
		const traits: ConversationTraits = {
			sessionId,
			file,
			cwd: target.cwd,
			attended,
			...(quest ? { quest } : {}),
		};
		const { launch } = previous;
		await watched?.became(previous.traits.sessionId, {
			sessionId,
			file,
			cwd: target.cwd,
			...(Object.keys(launch).length > 0 ? { launch } : {}),
		});
		return register(
			traits,
			launch,
			resumes(target) ? { op: "adopt" } : { op: "open" },
			quest ? { questId: quest } : {},
		);
	}

	/**
	 * Build pi's session for a registered conversation, on its own services,
	 * agent and store, its folder trusted as pi's CLI would trust it.
	 */
	async function session(
		record: Live,
		target: RuntimeTarget,
		sessionManager: SessionManager,
		building: {
			/** The conversation's own start, rather than one it became. */
			readonly starting: boolean;
			readonly request?: OpenRequest | AdoptRequest;
		},
	): Promise<RuntimeResult> {
		const { sessionId } = record.traits;
		const { request } = building;
		const env = () => requestEnv(sessionId);
		const modelRuntime = await sessions.ModelRuntime.create({
			authPath: join(target.agentDir, "auth.json"),
			modelsPath: join(target.agentDir, "models.json"),
			authContext: conversationAuthContext(env),
		});
		const trustSaid: StartupDiagnostic[] = [];
		const ask = building.starting ? trustQuestion(record) : undefined;
		const trusted = trust.services(target.cwd, target.agentDir, {
			...(ask ? { ask } : {}),
			...(target.projectTrustContext
				? { context: target.projectTrustContext }
				: {}),
			warn: (message) => trustSaid.push({ type: "warning", message }),
		});
		const services = await sessions.createAgentSessionServices({
			cwd: target.cwd,
			agentDir: target.agentDir,
			modelRuntime,
			settingsManager: trusted.settingsManager,
			...(trusted.resourceLoaderReloadOptions
				? { resourceLoaderReloadOptions: trusted.resourceLoaderReloadOptions }
				: {}),
			// pi's own built-ins, as its CLI passes them, so the conversation
			// has the tools a plain pi on the same settings has.
			resourceLoaderOptions: loaderOptions(
				record.bus,
				builtIns,
				options.resources,
			),
		});
		// What the CLI says as it starts: the screen shows it all, and the
		// journal, read when no screen is, keeps the errors and warnings.
		// Closed while its screen asked the person: nothing more is built for it.
		if (record.closing)
			throw new Error(`Conversation ${sessionId} closed before it was built`);
		const said = [...trustSaid, ...startupDiagnostics(services)];
		for (const { type, message } of said)
			if (type !== "info")
				report(new Error(`Conversation ${sessionId}: ${message}`));
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
			sessionManager,
			...(target.sessionStartEvent
				? { sessionStartEvent: target.sessionStartEvent }
				: {}),
			...(model ? { model } : {}),
			...(opening?.thinkingLevel
				? { thinkingLevel: opening.thinkingLevel }
				: {}),
			createAgent: conversation.createAgent,
		});
		return { ...created, services, diagnostics: said };
	}

	/**
	 * How a conversation's start asks its person whether to trust its folder:
	 * through its screen, only when it is attended and the screen can ask,
	 * saying it asked so its start can answer while the person decides.
	 */
	function trustQuestion(record: Live): StartupQuestion | undefined {
		const screens = options.screens;
		const askProjectTrust = screens?.askProjectTrust;
		if (!record.traits.attended || !screens || !askProjectTrust) return;
		const { sessionId, cwd } = record.traits;
		return (title, labels) => {
			record.questioned = true;
			record.asked?.();
			return askProjectTrust.call(screens, sessionId, cwd, title, labels);
		};
	}

	/**
	 * Settle a replacement pi finished: the conversation it became takes the
	 * runtime on, its screen and state follow it, what it had in flight
	 * carries on, and the one it was ends, its session gone with pi's
	 * teardown.
	 */
	async function replaced(
		seat: Seat,
		runtime: AgentSessionRuntime,
		previousId: string,
	): Promise<void> {
		const { current: previous, next } = seat;
		if (!next || previous.traits.sessionId !== previousId) {
			report(
				new Error(
					`pi replaced ${previousId} without the host holding what it became`,
				),
			);
			return;
		}
		seat.current = next;
		seat.next = undefined;
		previous.runtime = undefined;
		previous.disposed = true;
		previous.unsubscribe?.();
		previous.unsubscribe = undefined;
		next.runtime = runtime;
		const { sessionId } = next.traits;
		try {
			await host.run(sessionId, async () => {
				next.unsubscribe = runtime.session.subscribe((event) =>
					publishState(sessionId, event.type),
				);
				await options.screens?.rebound(view(sessionId, next), previousId);
				const recovery = await agentOf(next).recover();
				recovery.settled.catch(report);
			});
		} catch (error) {
			report(error);
		} finally {
			await host.close(previousId, "replaced").catch(report);
		}
	}

	/**
	 * Settle a replacement pi failed after disposing the session: the
	 * conversation it was becoming, if held yet, and the one it was both end.
	 */
	async function lost(seat: Seat, previousId: string): Promise<void> {
		const { current: previous, next } = seat;
		seat.next = undefined;
		previous.disposed = true;
		if (next)
			await host
				.close(next.traits.sessionId, "pi failed to build it")
				.catch(report);
		await host.close(previousId, "pi failed to replace it").catch(report);
	}

	/** Bind a conversation's extensions with no interface, as pi's RPC mode does, again after each replacement. */
	async function bindHeadless(runtime: AgentSessionRuntime): Promise<void> {
		const session = runtime.session;
		const sessionId = session.sessionId;
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				newSession: (next) => runtime.newSession(next),
				fork: (entryId, next) => runtime.fork(entryId, next),
				navigateTree: (targetId, next) =>
					runtime.session.navigateTree(targetId, next),
				switchSession: (path, next) => runtime.switchSession(path, next),
				reload: () =>
					host.reload(runtime.session.sessionId, {
						reason: "an extension asked",
					}),
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
		const seat: Seat = { current: record };
		const runtime = await sessions.createAgentSessionRuntime(
			factory(seat, request),
			{ cwd, agentDir: sessions.getAgentDir(), sessionManager },
		);
		record.runtime = runtime;
		// Before a screen takes the runtime on, so its own rebinding runs as the conversation it binds.
		holdReplacements(runtime, {
			refuse: (file) => {
				if (fileHeld(file))
					throw new Error(`That session is open in the host already: ${file}`);
			},
			replaced: (previousId) => replaced(seat, runtime, previousId),
			lost: (previousId) => lost(seat, previousId),
		});
		const agent = agentOf(record);
		record.unsubscribe = runtime.session.subscribe((event) =>
			publishState(sessionId, event.type),
		);
		if (options.screens) await options.screens.opened(view(sessionId, record));
		else {
			runtime.setRebindSession(() => bindHeadless(runtime));
			await bindHeadless(runtime);
		}
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
		// pi runs an extension command inside prompt and calls it handled only
		// once its handler returns, which may wait on a person at a panel; the
		// command was taken the moment it started, which prompt has done by now.
		if (namesCommand(session, first)) handled();
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
		const record = register(traits, launch, request, hintsFor(request));
		const asking = new Promise<"asking">((done) => {
			record.asked = () => done("asking");
		});
		const building = host
			.run(sessionId, () => build(record, manager, request))
			.then(
				() => "built" as const,
				(error: unknown) => {
					try {
						host.state(sessionId, "parked");
					} catch (parking) {
						// Closing already: the close parks it, and the start's error is what the caller must see.
						report(parking);
					}
					throw error;
				},
			);
		// A start whose screen is asking the person answers now, so a viewer can attach to answer; the build carries on, and says what fails.
		if ((await Promise.race([building, asking])) === "asking")
			building.catch(report);
	}

	/**
	 * Hold a conversation with the host under its id, its environment the
	 * realm's, then its launch, then what the engine derives for this start.
	 */
	function register(
		traits: ConversationTraits,
		launch: Readonly<Record<string, string>>,
		request: HarnessRequest | undefined,
		hints: LaunchHints,
	): Live {
		const { sessionId } = traits;
		const record: Live = { traits, launch, bus: sessions.createEventBus() };
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
				...conversationMarker(sessionId, { key: host.key, mark: owner }),
			},
			hints,
			close: (why) => end(sessionId, record, why),
			stamp: (how) => {
				record.ending = how;
				const stamp: SessionStamp = { session: sessionId, how };
				record.bus.emit(SESSION_STAMP_EVENT, stamp);
			},
			reload: () => reload(record),
		});
		live.set(sessionId, record);
		return record;
	}

	/**
	 * Release a conversation's session and store, keeping a stopped run for
	 * the next start, and say a conversation that ended itself has ended.
	 */
	async function end(
		sessionId: string,
		record: Live,
		why: string,
	): Promise<void> {
		record.closing = true;
		// A screen asked about the folder holds a terminal for it, and settles any question still open, whether or not a session came of it.
		if (record.runtime || record.questioned)
			await options.screens?.closed(sessionId);
		const agent = record.conversation?.agent;
		if (record.ending !== "closed") agent?.park();
		else if (!record.disposed) await record.runtime?.session.abort();
		record.unsubscribe?.();
		if (!record.disposed) await record.runtime?.dispose();
		// Closing signals a running tool and writes no outcome, so the next start reports it cut off.
		try {
			await record.conversation?.close();
		} finally {
			// The signal kills a tool's own group; a descendant that left it ends here.
			reapToolChildren(sessionId);
			live.delete(sessionId);
		}
		const events = watched;
		if (record.ending === "closed" && events)
			// Not awaited: the service's answer may close this very conversation, whose close waits on this.
			Promise.resolve()
				.then(() => events.ended(sessionId, why))
				.catch(report);
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

		watch(events) {
			watched = events;
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
 * once it holds a message, and pi opening a file that isn't there names a
 * new conversation, so a conversation held before its first message would
 * come back from a restart as another. What pi holds of it so far (its
 * header, and a fork's branch) is written at start, as pi would write it,
 * and the file opened as pi opens any other. A file already written is
 * pi's to keep, as it is.
 */
function keptFile(
	sessions: PiSessions,
	manager: SessionManager,
): SessionManager {
	const file = manager.getSessionFile();
	if (!file) throw new Error("pi named no file for the conversation");
	if (existsSync(file)) return manager;
	const entries = [manager.getHeader(), ...manager.getEntries()];
	writeFileSync(
		file,
		entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
		{ flag: "wx" },
	);
	return sessions.SessionManager.open(file);
}

/** Whether pi builds a session it resumed, rather than a new or forked one. */
function resumes(target: RuntimeTarget): boolean {
	const start = target.sessionStartEvent;
	return start !== undefined && Reflect.get(start, "reason") === "resume";
}
