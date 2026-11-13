/**
 * What the engine promises the host program, its service and its screens:
 * what it is made from, what it hands a screen, and what it answers beyond
 * the service's ConversationEngine. It changes when what a host asks of a
 * conversation changes, not when how the engine builds one does.
 */
import type {
	AdoptRequest,
	ConversationEngine,
	ConversationEvents,
	OpenRequest,
} from "../service/backend.ts";
import type { AgentSessionRuntime } from "./pi-session.ts";
import type { ConversationResources } from "./resources.ts";
import type { SessionHost } from "./session-host.ts";

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
	/**
	 * Ask the person at a conversation's screen what pi asks at its start,
	 * whether to trust the folder it works in, before its session exists:
	 * answer with a label, or undefined when dismissed or closed, which
	 * leaves the folder untrusted. Asked only of an attended conversation
	 * where pi would ask, once it is listed; its start answers once this is
	 * asked. None leaves such a folder untrusted, as pi without a screen does.
	 */
	askProjectTrust?(
		sessionId: string,
		cwd: string,
		title: string,
		labels: readonly string[],
	): Promise<string | undefined>;
	/**
	 * A conversation is registered and built; its first words are still to
	 * come. What the screen may tell the engine of it comes with it.
	 */
	opened(view: HostedView, signals: ScreenSignals): void | Promise<void>;
	/**
	 * A conversation's build or first words failed after its start had
	 * answered, as it does while the person is asked something, so no open
	 * failed with it: show it, as pi shows an initial message's error. It is
	 * reported to the service as well. Not called once the conversation is
	 * closing.
	 */
	failed?(sessionId: string, message: string): void;
	/** A conversation became another (new, fork or resume) under a new id. */
	rebound(view: HostedView, previousId: string): void | Promise<void>;
	/**
	 * A conversation is ending: called first in its cleanup, before its
	 * session is disposed, so a screen stops before the session it watches
	 * goes. `why` is the reason its close gave, such as "released, asked by
	 * ...", so a screen can tell its viewers a release apart from a close.
	 */
	closed(sessionId: string, why?: string): void | Promise<void>;
	/**
	 * A conversation is parking, called where `closed` would be: its
	 * screen stops, but its viewers stay, shown that it is parked, and the
	 * keys they type are kept for the screen it wakes into, the first
	 * calling `wake`, which rejects with why a wake failed so the screen
	 * can say so and let the next key ask again. The next `opened` for it
	 * takes them on; `closed` lets them go. None closes the screen as at
	 * any end.
	 */
	parked?(sessionId: string, wake: () => Promise<void>): void | Promise<void>;
	/**
	 * Reload an idle conversation's extensions as its screen's pi does at
	 * /reload: what the old load put on the screen goes before pi
	 * invalidates that load, and the new load's keys, commands and theme
	 * are bound. pi says a failure on the screen rather than to its caller.
	 * None leaves the engine to reload the session itself, as for screens
	 * that draw nothing of the extensions'.
	 */
	reload?(sessionId: string): Promise<void>;
}

/** What a screen may tell the engine of a conversation it shows. */
export interface ScreenSignals {
	/**
	 * Something in the conversation waits on the person, such as an
	 * extension's dialog, and no viewer has attached to answer it. The
	 * conversation's start answers at once, so one can; its build and first
	 * words carry on, and what fails later is reported. Once start has
	 * answered, it does nothing.
	 */
	asking(): void;
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
	/** What every conversation loads beyond what its settings and folders give it, as pi's flags say; none leaves pi to its settings. */
	readonly resources?: ConversationResources;
	/**
	 * Whether the host gives V8's pooled pages back with a last-resort
	 * collection once it is quiet (quiet-collection.ts); on unless false.
	 */
	readonly collectWhenQuiet?: boolean;
	readonly report?: (error: unknown) => void;
}

/** The service's engine, and each conversation as a screen or test drives it. */
export interface HostEngine extends ConversationEngine {
	view(sessionId: string): HostedView | undefined;
	/** Say to the service each conversation ending or becoming another on its own; set once, before any start. */
	watch(events: ConversationEvents): void;
	/** A viewer pressed a key or resized, so a collection waits for the quiet after it. */
	viewed(): void;
	/**
	 * How much background work every running conversation holds: commands,
	 * fleets and rounds still running, and results not yet said, which a
	 * host restart would end or lose.
	 */
	background(): number;
}
