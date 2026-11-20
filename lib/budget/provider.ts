/**
 * The contract between the budget host and whatever knows what a
 * budget's name means.
 *
 * A quest may name the budget its model calls draw on, such as a
 * team's token for one project rather than the person's own key. The
 * host, quest-workflow, works out which budget the loaded quest draws
 * on and asks its providers, in turn, what that name means: the
 * environment the session's model calls need (an API key in the
 * variable the model provider reads) and a label to show. The first
 * provider that knows the name answers; one that knows it but cannot
 * draw on it now (a credential not yet saved) says what would fix it.
 *
 * A provider registers over the event bus rather than by importing
 * the host, so it can live in another package: the harness ships one
 * that reads a file per budget, and a company's package can map its
 * names onto its own tokens. The names are versioned because the
 * payload is a public contract; a breaking change ships as `:v2`
 * beside the old one. Either load order works: a provider emits
 * {@link BUDGET_REGISTER_PROVIDER} when it activates, in case the host
 * is already up, and again whenever the host announces
 * {@link BUDGET_READY}, in case it was not. Registration is keyed by
 * id, so registering again replaces.
 */

import type {
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";

/**
 * What a budget's name may be: a letter or digit, then letters,
 * digits, dots, dashes and underscores, at most 64 of them. A provider
 * may use it as a file's name, so it never holds a slash or starts
 * with a dot; any host on the bus may hand one over, so a provider
 * that makes a path of it checks it first.
 */
const BUDGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The most characters a budget's name may run to. */
const LONGEST_NAME = 64;

/** Whether a word can be a budget's name. */
export function isBudgetName(word: string): boolean {
	return word.length <= LONGEST_NAME && BUDGET_NAME.test(word);
}

/** Emitted by the host once it accepts providers. */
export const BUDGET_READY = "budget:ready:v1";

/** Emitted by a provider to register itself with the host. */
export const BUDGET_REGISTER_PROVIDER = "budget:register-provider:v1";

/**
 * Emitted by an extension asking the host to announce itself, for when
 * it loaded second and missed {@link BUDGET_READY}.
 */
export const BUDGET_REQUEST = "budget:request:v1";

/** What a provider says a budget's name means. */
export type BudgetAnswer =
	| {
			/** The name is this provider's, and here is how to draw on it. */
			readonly kind: "drawn";
			/**
			 * The variables a session drawing on the budget runs with, set in
			 * its own environment and inherited by what it starts.
			 */
			readonly env: Readonly<Record<string, string>>;
			/** A short name to show for it, such as the account it bills. */
			readonly label: string;
	  }
	| {
			/** The name is not one this provider knows; the next is asked. */
			readonly kind: "unknown";
	  }
	| {
			/**
			 * The name is this provider's but it cannot be drawn on now. The
			 * reason says what would fix it, in words a person can act on.
			 */
			readonly kind: "unavailable";
			readonly reason: string;
	  };

/** Something that knows what some budgets' names mean. */
export interface BudgetProvider {
	/** Named when it answers, so a person can see whose answer it was. */
	readonly id: string;
	/** Lower is asked first. */
	readonly precedence: number;
	/**
	 * What a budget's name means to this provider. Resolves rather than
	 * rejecting: a provider that fails says so as `unavailable`.
	 */
	resolve(name: string): Promise<BudgetAnswer>;
	/**
	 * The budget work in `folder`, an absolute path, draws on when no
	 * quest names one, or undefined when this provider can't say. The
	 * folder is the caller's choice and may hold anyone's files, so match
	 * it by whole path segments, never as a bare string prefix. A quest
	 * made or spawned there with no budget above it is named this one, so
	 * a project's work stops drawing on the person's own key by default.
	 * Optional, since a provider may only know what names mean.
	 */
	budgetFor?(folder: string): Promise<string | undefined>;
	/**
	 * Which budget `work` draws on, judged from what the work is, when
	 * neither a quest above it nor its folder names one; or undefined
	 * when this provider can't judge. `classify` asks the session's own
	 * classifier model, so the person's model config decides where it is
	 * served and with what credentials. `none` is a judgement too: work
	 * that is the person's own. Optional, as `budgetFor` is.
	 */
	budgetForWork?(
		work: WorkToBudget,
		classify: Classify,
	): Promise<WorkJudgement | undefined>;
}

/** Asks the session's classifier model one question set. */
export type Classify = (
	context: ClassifierContext,
	signal?: AbortSignal,
) => Promise<ClassifierResult>;

/**
 * What a provider is told of work it judges the budget of. A quest
 * seeded from a link takes its title and summary from what that issue's
 * or page's author wrote, so a provider hands them to its classifier as
 * data to weigh, never as instructions, lest whoever wrote them steer
 * which budget pays.
 */
export interface WorkToBudget {
	/**
	 * The quest's title, or for a session with none, its folder. Seeded
	 * from a link, it is the link's author's.
	 */
	readonly title: string;
	/**
	 * What the quest says it is about, when it says. Seeded from a link,
	 * it holds an excerpt the link's author wrote.
	 */
	readonly summary?: string;
	/** The absolute folder the work happens in, when there is one. */
	readonly folder?: string;
	/** Its branches, changes and links, as `type:value`. */
	readonly names?: readonly string[];
	/** For a session with no quest, the first thing the person asked. */
	readonly prompt?: string;
}

/** A provider's judgement of which budget some work draws on. */
export interface WorkJudgement {
	/** The budget, or `none` for the person's own work. */
	readonly name: string;
	/** Why, in a short clause a person can check. */
	readonly why: string;
	/**
	 * Whether it is sure enough to name the budget. One that isn't
	 * names nothing, and the work is said to be unsure instead.
	 */
	readonly sure: boolean;
}

/** What the host hands out over {@link BUDGET_READY}. */
export interface BudgetHostApi {
	/** Register a provider, replacing one with the same id. */
	registerProvider(provider: BudgetProvider): void;
	/** Ids of every registered provider, in the order they are asked. */
	listProviders(): readonly string[];
}

/**
 * Whether a bus payload is a budget provider. Its optional `budgetFor`
 * isn't judged here: one that isn't a function is never asked about a
 * folder, and the provider still answers for names, since losing those
 * too would put its quests on the person's own key.
 */
export function isBudgetProvider(data: unknown): data is BudgetProvider {
	if (typeof data !== "object" || data === null) return false;
	const p = data as Record<string, unknown>;
	return (
		typeof p.id === "string" &&
		p.id.length > 0 &&
		typeof p.precedence === "number" &&
		typeof p.resolve === "function"
	);
}

/**
 * Register a provider with the host now, and again whenever the host
 * announces itself. Returns what stops the re-registering.
 */
export function registerBudgetProvider(
	bus: Pick<EventBus, "emit" | "on">,
	provider: BudgetProvider,
): () => void {
	const stop = bus.on(BUDGET_READY, () =>
		bus.emit(BUDGET_REGISTER_PROVIDER, provider),
	);
	bus.emit(BUDGET_REGISTER_PROVIDER, provider);
	return stop;
}
