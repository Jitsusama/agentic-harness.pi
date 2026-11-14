/**
 * What the engine uses of pi's session layer: the session manager that
 * names and keeps a conversation's file, the services and runtime pi
 * builds a session with, and the session itself. pi's JavaScript carries
 * no types the engine can import, so the shapes are declared here, as far
 * as the engine reaches, and picked from the loaded install by name.
 */
import { isRecord } from "../../lib/internal/record.ts";
import type { AuthContext } from "./auth-context.ts";
import type { HostPiModules } from "./host-pi.ts";
import type { AgentOptions, Model } from "./pi-types.ts";

/** pi's session manager: one conversation's tree and the file it keeps. */
export interface SessionManager {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getCwd(): string;
	getHeader(): object | null;
	getEntries(): readonly object[];
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
	/** Hear `channel`; answers the function that stops hearing it. */
	on(channel: string, listener: (data: unknown) => void): () => void;
}

/** What one model call answered, as far as a cache warm reads it. */
export interface CompletedCall {
	readonly provider: string;
	readonly model: string;
	readonly responseModel?: string;
	readonly stopReason: string;
	readonly errorMessage?: string;
	readonly usage: { readonly cacheWrite: number } & Record<string, unknown>;
}

/** pi's model runtime, as the engine asks it for a model and a warm's call. */
export interface ModelRuntime {
	getModel(provider: string, id: string): Model | undefined;
	completeSimple(
		model: Model,
		context: { readonly messages: readonly unknown[] },
		options: {
			readonly headers: Readonly<Record<string, string | null>>;
			readonly sessionId: string;
			readonly maxTokens: number;
			readonly maxRetries: number;
			readonly signal: AbortSignal;
			readonly onPayload: () => unknown;
		},
	): Promise<CompletedCall>;
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

/** One thing pi says as a session starts, as its CLI shows it. */
export interface StartupDiagnostic {
	readonly type: "error" | "warning" | "info";
	readonly message: string;
}

/**
 * What pi's CLI says as a session's services load, in its words and its
 * order: each diagnostic of the services, each invalid settings file, each
 * extension the resource loader couldn't load and each warning about an
 * extension package. Its InteractiveMode shows them on the session's
 * screen as it starts; a host shows them on the conversation's screen and
 * reports the errors and warnings to its journal.
 */
export function startupDiagnostics(
	services: SessionServices,
): StartupDiagnostic[] {
	const said = services.diagnostics.filter(isStartupDiagnostic);
	const settings = services.settingsManager;
	if (isRecord(settings) && typeof settings.drainErrors === "function") {
		const drained: unknown = settings.drainErrors();
		for (const failure of Array.isArray(drained) ? drained : []) {
			if (!isRecord(failure)) continue;
			const reason = isRecord(failure.error)
				? String(failure.error.message)
				: String(failure.error);
			said.push({
				type: "warning",
				message: failure.path
					? `Invalid settings file ${String(failure.path)}: ${reason}`
					: `Invalid ${String(failure.scope)} settings: ${reason}`,
			});
		}
	}
	const loader = services.resourceLoader;
	if (!isRecord(loader) || typeof loader.getExtensions !== "function")
		return said;
	const extensions: unknown = loader.getExtensions();
	if (!isRecord(extensions)) return said;
	const { errors, warnings } = extensions;
	for (const failure of Array.isArray(errors) ? errors : []) {
		if (isRecord(failure))
			said.push({
				type: "error",
				message: `Failed to load extension "${String(failure.path)}": ${String(failure.error)}`,
			});
	}
	for (const warning of Array.isArray(warnings) ? warnings : []) {
		if (isRecord(warning))
			said.push({
				type: "warning",
				message: `Extension package "${String(warning.path)}": ${String(warning.warning)}`,
			});
	}
	return said;
}

function isStartupDiagnostic(value: unknown): value is StartupDiagnostic {
	return (
		isRecord(value) &&
		(value.type === "error" ||
			value.type === "warning" ||
			value.type === "info") &&
		typeof value.message === "string"
	);
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

/** An extension's own message, as pi.sendMessage takes it. */
export interface CustomMessageInput {
	readonly customType: string;
	readonly content?: unknown;
	readonly display: boolean;
	readonly details?: unknown;
}

/** How pi.sendMessage is asked to deliver an extension's message. */
export interface CustomMessageOptions {
	readonly triggerTurn?: boolean;
	readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** pi's AgentSession, as far as the engine drives it. */
export interface AgentSession {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly isStreaming: boolean;
	/** The extensions' runner, asked which commands they registered. */
	readonly extensionRunner: {
		getCommand(name: string): object | undefined;
	};
	prompt(
		text: string,
		options?: {
			source?: "interactive" | "rpc" | "extension";
			preflightResult?: (disposition: string) => void;
		},
	): Promise<void>;
	abort(): Promise<void>;
	/** What pi's runtime calls as it lets go of the session, as the host stops or the session is replaced. */
	dispose(): void;
	waitForIdle(): Promise<void>;
	reload(): Promise<void>;
	subscribe(listener: (event: { readonly type: string }) => void): () => void;
	/**
	 * Show words the agent already holds as pending, as pi shows its own
	 * queued input: the agent-interface patch's, absent from a runtime built
	 * before it.
	 */
	showQueued?(text: string, mode: "steer" | "followUp"): void;
	/** What an extension's pi.sendMessage reaches. */
	sendCustomMessage(
		message: CustomMessageInput,
		options?: CustomMessageOptions,
	): Promise<void>;
	navigateTree(
		targetId: string,
		options?: object,
	): Promise<{ cancelled: boolean }>;
	bindExtensions(bindings: {
		/** What extensions' ctx.ui reaches, as a screen binds it; none keeps what was bound. */
		uiContext?: object;
		mode?: "tui" | "rpc" | "json" | "print";
		commandContextActions?: CommandContextActions;
		shutdownHandler?: () => void;
		onError?: (error: {
			extensionPath: string;
			event: string;
			error: string;
			stack?: string;
		}) => void;
	}): Promise<void>;
}

/** pi's AgentSessionRuntime: the session and its services, replaced together. */
export interface AgentSessionRuntime {
	readonly session: AgentSession;
	readonly services: SessionServices;
	/** What its factory said as the session started, which a screen shows. */
	readonly diagnostics: readonly StartupDiagnostic[];
	newSession(options?: object): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: object): Promise<{ cancelled: boolean }>;
	switchSession(
		sessionPath: string,
		options?: object,
	): Promise<{ cancelled: boolean }>;
	setRebindSession(rebind?: (session: AgentSession) => Promise<void>): void;
	/** A callback run as pi invalidates the session it is replacing, just before disposing it. */
	setBeforeSessionInvalidate(callback?: () => void): void;
	dispose(): Promise<void>;
}

/** What pi's runtime factory is handed for each session it builds. */
export interface RuntimeTarget {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
	readonly sessionStartEvent?: object;
	/** pi's screen's context for asking whether to trust the folder, as it hands one to a session it resumes. */
	readonly projectTrustContext?: object;
}

/** What a runtime factory answers: the session and the services it was built with. */
export interface RuntimeResult {
	readonly session: AgentSession;
	readonly services: SessionServices;
	readonly diagnostics: readonly StartupDiagnostic[];
	readonly [field: string]: unknown;
}

/** What the engine sets of pi's resource loader, as pi's own main sets it from its flags. */
export interface ResourceLoaderOptions {
	readonly eventBus?: EventBus;
	/** pi's own built-ins, as its CLI hands them over. */
	readonly extensionFactories?: readonly BuiltInExtension[];
	readonly additionalExtensionPaths?: string[];
	readonly noExtensions?: boolean;
	readonly disabledBuiltinExtensions?: string[];
	readonly noSkills?: boolean;
	readonly noPromptTemplates?: boolean;
	readonly noContextFiles?: boolean;
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
		settingsManager?: object;
		resourceLoaderOptions?: ResourceLoaderOptions;
		resourceLoaderReloadOptions?: {
			resolveProjectTrust(options: {
				extensionsResult: unknown;
			}): Promise<boolean>;
		};
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

/**
 * One of pi's built-in extensions, as its CLI hands them to the resource
 * loader: the loader keys on `builtin`, and `replaceable` lets an
 * extension registering the same tool take over, so each is passed on
 * whole rather than rebuilt from its factory.
 */
export interface BuiltInExtension {
	readonly name: string;
	readonly factory: (...args: never[]) => unknown;
	readonly builtin?: boolean;
	readonly replaceable?: boolean;
}

function isBuiltInExtension(value: unknown): value is BuiltInExtension {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"factory" in value &&
		typeof value.factory === "function"
	);
}

/**
 * pi's built-in extensions, in the order its CLI loads them before any
 * other, refusing an install whose list is missing or unreadable: without
 * them a hosted conversation would have no tool_search, codemode or MCP,
 * so none of its deferred tools nor the gateway's.
 */
export function piBuiltInExtensions(
	modules: Pick<HostPiModules, "builtins">,
): readonly BuiltInExtension[] {
	const list = modules.builtins.builtInExtensions;
	if (
		!Array.isArray(list) ||
		list.length === 0 ||
		!list.every(isBuiltInExtension)
	)
		throw new Error(
			"The host's pi coding agent lists no built-in extensions it can load",
		);
	return list;
}

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
