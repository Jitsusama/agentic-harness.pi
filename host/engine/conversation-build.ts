/**
 * How pi builds, replaces and loses a hosted conversation's session. A
 * registered conversation is built by pi's runtime, on its own services,
 * agent and durable store, its folder trusted as pi's CLI would trust it.
 * One that becomes another (pi's /new, /fork, /resume or import) is held
 * under its new id before pi builds it; once pi has built it, it takes the
 * runtime on and the one it was ends, and when pi fails past its teardown
 * both end.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type LaunchHints,
	type SessionStamp,
	withSession,
} from "../../lib/core/session/index.ts";
import { noteFirstPrompt } from "../../lib/internal/session/first-prompt-slot.ts";
import type {
	AdoptRequest,
	ConversationEvents,
	OpenRequest,
	StartPhase,
} from "../service/backend.ts";
import { conversationAuthContext } from "./auth-context.ts";
import { holdMessagesThroughCarriedTurns } from "./carried-turn-messages.ts";
import type { Checkpoints } from "./checkpoints.ts";
import type {
	ConversationTraits,
	EngineOptions,
	HostedView,
} from "./contract.ts";
import { FOLDER_GONE_TYPE, folderGoneLine, toldOfMove } from "./gone-folder.ts";
import type { HarnessRequest } from "./harness-settings.ts";
import { bindHeadless } from "./headless.ts";
import type { HeldLogs } from "./held-logs.ts";
import type { HostPi } from "./host-pi.ts";
import type { HostedAgent } from "./hosted-agent.ts";
import {
	type HostedConversation,
	openHostedConversation,
} from "./hosted-conversation.ts";
import type { holdKeptHistory, retakeKeptHistory } from "./kept-history.ts";
import type { countLeftOut } from "./kept-history-session.ts";
import type { KeptRequests } from "./kept-requests.ts";
import type { PiLibrary } from "./pi-library.ts";
import {
	type AgentSessionRuntime,
	type BuiltInExtension,
	type EventBus,
	type PiSessions,
	type RuntimeResult,
	type RuntimeTarget,
	type SessionManager,
	type StartupDiagnostic,
	startupDiagnostics,
} from "./pi-session.ts";
import type { ProjectTrust, StartupQuestion } from "./project-trust.ts";
import { holdReplacements } from "./replacement.ts";
import { namesCommand, requireModel } from "./requests.ts";
import { loaderOptions } from "./resources.ts";
import type { TakeTurn } from "./resume-turns.ts";
import type { StopKeeping } from "./stopping.ts";

/** The durable store's file inside a conversation's folder. */
const STORE_FILE = "durable.sqlite";

/** One conversation the engine registered. */
export interface Live {
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
	/** It asked to park, so its close keeps its screen's terminal for the wake. */
	parking?: boolean;
	/**
	 * Its close hands it on, to pi's replacement in its seat or to another
	 * holder, so what its ended calls left is kept, as a stop keeps it.
	 */
	handsOn?: boolean;
}

/**
 * One pi runtime and the conversation it runs: the current one, and the
 * one it is becoming while pi builds it.
 */
interface Seat {
	current: Live;
	next?: Live;
}

/** The host's pi, as the engine loaded it and read its parts. */
export interface PiParts {
	readonly pi: HostPi;
	readonly sessions: PiSessions;
	readonly builtIns: readonly BuiltInExtension[];
	readonly trust: ProjectTrust;
	readonly library: PiLibrary;
	/** Holds only a log's kept history; loaded once pi has, as it binds pi. */
	readonly keptHistory: typeof holdKeptHistory;
	/** Takes a held log's view again once its extensions have said what stays behind; loaded as keptHistory is. */
	readonly keptRetake: typeof retakeKeptHistory;
	/** Has a session count and list what its held log left; loaded as keptHistory is. */
	readonly keptCounts: typeof countLeftOut;
}

/** What a build asks of the engine it builds for. */
export interface BuildContext {
	readonly parts: PiParts;
	readonly options: EngineOptions;
	readonly report: (error: unknown) => void;
	readonly logs: HeldLogs;
	readonly requests: KeptRequests;
	readonly stopping: StopKeeping;
	/** The host's one checkpointer, which keeps every conversation's store checkpointed off the thread. */
	readonly checkpoints?: Checkpoints;
	/** The service's ears, once it set them. */
	watched(): ConversationEvents | undefined;
	/** Whether a conversation is held or named for a start already, by id or by file. */
	held(sessionId: string, file: string): boolean;
	/** Whether a conversation held or named for a start already has this file. */
	fileHeld(file: string): boolean;
	/** Hold a conversation with the host under its id, as the engine registers each start. */
	register(
		traits: ConversationTraits,
		launch: Readonly<Record<string, string>>,
		request: HarnessRequest | undefined,
		hints: LaunchHints,
	): Live;
	/** Follow what a conversation's session says. */
	heard(sessionId: string, event: string): void;
}

/** How the engine builds a registered conversation, and reads what it built. */
export interface ConversationBuilds {
	/** Build a registered conversation, under its id, and carry on what it had in flight. */
	build(
		record: Live,
		manager: SessionManager,
		request: OpenRequest | AdoptRequest | undefined,
		mark?: (phase: StartPhase) => void,
		turn?: TakeTurn,
	): Promise<void>;
	/** What a screen or test is handed of a built conversation. */
	view(sessionId: string, record: Live): HostedView;
	/** Something failed once its conversation's start had answered, so no open fails with it: report it, and show it on the screen if it has one. */
	failedAfterStart(record: Live, error: unknown): void;
}

/** Build each conversation on the host's pi, for the engine this context names. */
export function conversationBuilds(context: BuildContext): ConversationBuilds {
	const { parts, options, report, logs, requests } = context;
	const {
		pi,
		sessions,
		builtIns,
		trust,
		library,
		keptHistory,
		keptRetake,
		keptCounts,
	} = parts;
	const { host } = options;

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
		mark?: (phase: StartPhase) => void,
	): (target: RuntimeTarget) => Promise<RuntimeResult> {
		return async (target) => {
			const { current } = seat;
			if (target.sessionManager.getSessionId() === current.traits.sessionId)
				return await session(current, target, target.sessionManager, {
					starting: true,
					...(request ? { request } : {}),
					...(mark ? { mark } : {}),
				});
			const next = await becoming(current, target);
			seat.next = next;
			return await host.run(next.traits.sessionId, () =>
				session(
					next,
					target,
					keptHistory(keptFile(sessions, target.sessionManager), report),
					{ starting: false },
				),
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
		if (context.held(sessionId, file))
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
		await context.watched()?.became(previous.traits.sessionId, {
			sessionId,
			file,
			cwd: target.cwd,
			...(Object.keys(launch).length > 0 ? { launch } : {}),
		});
		const next = await context.register(
			traits,
			launch,
			resumes(target) ? { op: "adopt" } : { op: "open" },
			quest ? { questId: quest } : {},
		);
		// Before its runner tells, so the record never names it tighter
		// than what the one it replaces has running; replaced() hands on
		// again whatever that one told since.
		host.inherit(previous.traits.sessionId, sessionId);
		return next;
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
			/** Hears each phase of the conversation's own start as it ends. */
			readonly mark?: (phase: StartPhase) => void;
		},
	): Promise<RuntimeResult> {
		const { sessionId } = record.traits;
		const { request, mark } = building;
		// Written by now: keptFile writes the log of one held before its first message.
		logs.hold(sessionId, record.traits.file);
		const env = () => requests.requestEnv(sessionId);
		requests.building(sessionId, target.agentDir);
		const modelRuntime = await sessions.ModelRuntime.create({
			authPath: join(target.agentDir, "auth.json"),
			modelsPath: join(target.agentDir, "models.json"),
			authContext: conversationAuthContext(env),
		});
		mark?.("models");
		const trustSaid: StartupDiagnostic[] = [];
		// Said with the start's diagnostics until they are reported; a later load's straight to the journal.
		let started = false;
		const ask = building.starting ? trustQuestion(record) : undefined;
		const trusted = trust.services(target.cwd, target.agentDir, {
			...(ask ? { ask } : {}),
			...(target.projectTrustContext
				? { context: target.projectTrustContext }
				: {}),
			warn: (message) =>
				started
					? report(`Conversation ${sessionId}: ${message}`)
					: trustSaid.push({ type: "warning", message }),
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
		mark?.("services");
		// Its log was held before its extensions loaded, so the records they
		// say stay behind leave the view before pi builds a context from it.
		keptRetake(sessionManager);
		// What the CLI says as it starts: the screen shows it all, and the
		// journal, read when no screen is, keeps the errors and warnings.
		// Closed while its screen asked the person: nothing more is built for it.
		if (record.closing)
			throw new Error(`Conversation ${sessionId} closed before it was built`);
		const said = [...trustSaid, ...startupDiagnostics(services)];
		started = true;
		for (const { type, message } of said)
			if (type !== "info") report(`Conversation ${sessionId}: ${message}`);
		const conversation = await openHostedConversation({
			modules: pi.modules,
			library,
			storePath: join(options.stateDir, sessionId, STORE_FILE),
			env,
			renewed: (error) => requests.renewed(error, sessionId),
			within: (work) => withSession(sessionId, work),
			report,
			...(context.checkpoints ? { checkpoints: context.checkpoints } : {}),
		});
		mark?.("store");
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
		mark?.("session");
		// A turn durable carries on is no run of pi's session, which would write an extension's message mid-round.
		// The hold ends with the session's dispose, writing what it held, so nothing here keeps its undo.
		holdMessagesThroughCarriedTurns(created.session, agentOf(record), (error) =>
			report(`Conversation ${sessionId}: ${String(error)}`),
		);
		// /session's counts and /fork's list take in the messages a held log left on disk.
		keptCounts(created.session, (error) =>
			report(`Conversation ${sessionId}: ${String(error)}`),
		);
		// Words the agent queues past the session show as pending, where pi has the seam; the host says at start when it lacks it.
		// The agent's own runs open as pi's, where pi has the seam, so pi prepares and settles them as it does a prompt's.
		agentOf(record).joinSession(created.session, (error) =>
			report(`Conversation ${sessionId}: ${String(error)}`),
		);
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
				`pi replaced ${previousId} without the host holding what it became`,
			);
			return;
		}
		seat.current = next;
		seat.next = undefined;
		// Plain pi keeps what the conversation it replaces left running, so
		// the host keeps its fence too, for when it is held again.
		previous.handsOn = true;
		host.handsOn(previousId);
		previous.runtime = undefined;
		previous.disposed = true;
		previous.unsubscribe?.();
		previous.unsubscribe = undefined;
		next.runtime = runtime;
		const { sessionId } = next.traits;
		// What it had in flight runs on as the next one's, under its fence.
		host.inherit(previousId, sessionId);
		try {
			await host.run(sessionId, async () => {
				next.unsubscribe = runtime.session.subscribe((event) =>
					context.heard(sessionId, event.type),
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

	async function build(
		record: Live,
		manager: SessionManager,
		request: OpenRequest | AdoptRequest | undefined,
		mark?: (phase: StartPhase) => void,
		turn?: TakeTurn,
	): Promise<void> {
		const { sessionId, cwd } = record.traits;
		// What an earlier host's tools left running for it ends before this start reports them cut off.
		await context.stopping.reap(sessionId);
		mark?.("reap");
		const first = request?.op === "open" ? request.first : undefined;
		noteFirstPrompt(first);
		const sessionManager =
			request?.op === "open" ? keptFile(sessions, manager) : manager;
		const seat: Seat = { current: record };
		const runtime = await sessions.createAgentSessionRuntime(
			factory(seat, request, mark),
			{ cwd, agentDir: sessions.getAgentDir(), sessionManager },
		);
		mark?.("runtime");
		record.runtime = runtime;
		// Before a screen takes the runtime on, so its own rebinding runs as the conversation it binds.
		holdReplacements(runtime, {
			refuse: (file) => {
				if (context.fileHeld(file))
					throw new Error(`That session is open in the host already: ${file}`);
			},
			replaced: (previousId) => replaced(seat, runtime, previousId),
			lost: (previousId) => lost(seat, previousId),
		});
		const agent = agentOf(record);
		record.unsubscribe = runtime.session.subscribe((event) =>
			context.heard(sessionId, event.type),
		);
		if (options.screens)
			await options.screens.opened(view(sessionId, record), {
				asking: () => record.asked?.(),
			});
		else {
			runtime.setRebindSession(() => bindHeadless(runtime, host, report));
			await bindHeadless(runtime, host, report);
		}
		mark?.("screen");
		const recovery = await agent.recover(turn);
		mark?.("recovery");
		// Told once the recovery settles: while the run it shows is under way the
		// message is held to that run's next turn end, which is after the next
		// answer, so the model answered before it knew (engine.test, 23 November).
		const tell = async (): Promise<void> => {
			const { left } = record.traits;
			if (!left || toldOfMove(sessionManager.getEntries(), left, cwd)) return;
			await runtime.session.sendCustomMessage(
				{
					customType: FOLDER_GONE_TYPE,
					content: folderGoneLine(left, cwd),
					display: true,
					details: { left, now: cwd },
				},
				{ triggerTurn: false },
			);
		};
		if (first === undefined) {
			recovery.settled.then(tell).catch(report);
			return;
		}
		await recovery.settled;
		await tell();
		await promptFirst(record, agent, first);
		mark?.("first");
	}

	/** Send the first words; resolve once durable holds them, or pi took them as a command. */
	async function promptFirst(
		record: Live,
		agent: HostedAgent,
		first: string,
	): Promise<void> {
		const session = view(record.traits.sessionId, record).runtime.session;
		const stopping = new AbortController();
		const words = agent.watchWords(stopping.signal);
		// Once the race is decided, a later rejection says only what the race already said.
		words.held.catch(() => undefined);
		let handled = () => {};
		const taken = new Promise<void>((done) => {
			handled = done;
		});
		const prompting = session.prompt(first, {
			source: "rpc",
			// An extension may begin a run of pi's as the carried one settles, and pi refuses words that don't say how to queue behind it, as its editor's do.
			streamingBehavior: "followUp",
			// What pi says it did tells the watch which words are these.
			preflightResult: (disposition) => {
				if (disposition === "handled") handled();
				words.told(disposition);
			},
		});
		// pi runs an extension command inside prompt and calls it handled only
		// once its handler returns, which may wait on a person at a panel; the
		// command was taken the moment it started, which prompt has done by now.
		if (namesCommand(session, first)) handled();
		// pi answers at once for words it only queued behind a run under way, or
		// put off while a run settled, so its answer alone says nothing: durable
		// holds them once the run takes them or a later prompt carries them.
		try {
			await Promise.race([words.held, taken, prompting.then(() => words.held)]);
		} finally {
			stopping.abort();
		}
		prompting.catch((error: unknown) => failedAfterStart(record, error));
	}

	function failedAfterStart(record: Live, error: unknown): void {
		report(error);
		if (record.closing || !record.runtime) return;
		const message = error instanceof Error ? error.message : String(error);
		try {
			options.screens?.failed?.(record.traits.sessionId, message);
		} catch (showing) {
			report(showing);
		}
	}

	return { build, view, failedAfterStart };
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
