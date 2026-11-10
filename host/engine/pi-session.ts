/**
 * What the engine uses of pi's session layer: the session manager that
 * names and keeps a conversation's file, the services and runtime pi
 * builds a session with, and the session itself. pi's JavaScript carries
 * no types the engine can import, so the shapes are declared here, as far
 * as the engine reaches, and picked from the loaded install by name.
 */
import type { AuthContext } from "./auth-context.ts";
import type { HostPiModules } from "./host-pi.ts";
import type { AgentOptions, Model } from "./pi-types.ts";

/** pi's session manager: one conversation's tree and the file it keeps. */
export interface SessionManager {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getCwd(): string;
	getHeader(): object | null;
	isPersisted(): boolean;
}

/** pi's ways to make a session manager. */
export interface SessionManagerStatics {
	create(cwd: string, sessionDir?: string): SessionManager;
	open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
}

/** pi's event bus, the one `pi.events` gives every extension of a session. */
export interface EventBus {
	emit(channel: string, data: unknown): void;
}

/** pi's model runtime, as the engine asks it for a model. */
export interface ModelRuntime {
	getModel(provider: string, id: string): Model | undefined;
}

/** How pi builds a model runtime, with the host patch's auth context. */
export interface ModelRuntimeStatics {
	create(options: {
		authPath: string;
		modelsPath: string;
		authContext: AuthContext;
	}): Promise<ModelRuntime>;
}

/** The services pi builds for one session's working folder. */
export interface SessionServices {
	readonly cwd: string;
	readonly agentDir: string;
	readonly modelRuntime: ModelRuntime;
	readonly settingsManager: unknown;
	readonly resourceLoader: unknown;
	readonly diagnostics: unknown[];
}

/** What an extension may ask of the mode a session runs in. */
export interface CommandContextActions {
	waitForIdle(): Promise<void>;
	newSession(options?: object): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: object): Promise<{ cancelled: boolean }>;
	navigateTree(
		targetId: string,
		options?: object,
	): Promise<{ cancelled: boolean }>;
	switchSession(
		sessionPath: string,
		options?: object,
	): Promise<{ cancelled: boolean }>;
	reload(): Promise<void>;
}

/** pi's AgentSession, as far as the engine drives it. */
export interface AgentSession {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly isStreaming: boolean;
	prompt(
		text: string,
		options?: {
			source?: "interactive" | "rpc" | "extension";
			preflightResult?: (disposition: string) => void;
		},
	): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	reload(): Promise<void>;
	subscribe(listener: (event: { readonly type: string }) => void): () => void;
	navigateTree(
		targetId: string,
		options?: object,
	): Promise<{ cancelled: boolean }>;
	bindExtensions(bindings: {
		mode?: "tui" | "rpc" | "json" | "print";
		commandContextActions?: CommandContextActions;
		shutdownHandler?: () => void;
		onError?: (error: { extensionPath: string; error: string }) => void;
	}): Promise<void>;
}

/** pi's AgentSessionRuntime: the session and its services, replaced together. */
export interface AgentSessionRuntime {
	readonly session: AgentSession;
	readonly services: SessionServices;
	newSession(options?: object): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: object): Promise<{ cancelled: boolean }>;
	switchSession(
		sessionPath: string,
		options?: object,
	): Promise<{ cancelled: boolean }>;
	setRebindSession(rebind?: (session: AgentSession) => Promise<void>): void;
	dispose(): Promise<void>;
}

/** What pi's runtime factory is handed for each session it builds. */
export interface RuntimeTarget {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
	readonly sessionStartEvent?: object;
}

/** What a runtime factory answers: the session and the services it was built with. */
export interface RuntimeResult {
	readonly session: AgentSession;
	readonly services: SessionServices;
	readonly diagnostics: unknown[];
	readonly [field: string]: unknown;
}

/** The pieces of pi's session layer the engine builds a conversation from. */
export interface PiSessions {
	readonly SessionManager: SessionManagerStatics;
	readonly ModelRuntime: ModelRuntimeStatics;
	createEventBus(): EventBus;
	createAgentSessionServices(options: {
		cwd: string;
		agentDir?: string;
		modelRuntime?: ModelRuntime;
		resourceLoaderOptions?: { eventBus?: EventBus };
	}): Promise<SessionServices>;
	createAgentSession(options: {
		cwd: string;
		agentDir: string;
		modelRuntime: ModelRuntime;
		settingsManager: unknown;
		resourceLoader: unknown;
		sessionManager: SessionManager;
		sessionStartEvent?: object;
		model?: Model;
		thinkingLevel?: string;
		createAgent: (options: AgentOptions) => unknown;
	}): Promise<{ session: AgentSession; [field: string]: unknown }>;
	createAgentSessionRuntime(
		factory: (target: RuntimeTarget) => Promise<RuntimeResult>,
		options: RuntimeTarget,
	): Promise<AgentSessionRuntime>;
	getAgentDir(): string;
}

const NAMES = [
	"SessionManager",
	"ModelRuntime",
	"createEventBus",
	"createAgentSessionServices",
	"createAgentSession",
	"createAgentSessionRuntime",
	"getAgentDir",
] as const;

/** Pick pi's session layer from the loaded coding agent, refusing one that lacks a piece. */
export function piSessions(modules: HostPiModules): PiSessions {
	const missing = NAMES.filter(
		(name) => modules.codingAgent[name] === undefined,
	);
	if (missing.length > 0)
		throw new Error(`The host's pi coding agent lacks ${missing.join(", ")}`);
	// Each is checked present above and is the coding agent's documented export of that name.
	return modules.codingAgent as unknown as PiSessions;
}
