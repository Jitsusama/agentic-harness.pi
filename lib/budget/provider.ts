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

import type { EventBus } from "@earendil-works/pi-coding-agent";

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
}

/** What the host hands out over {@link BUDGET_READY}. */
export interface BudgetHostApi {
	/** Register a provider, replacing one with the same id. */
	registerProvider(provider: BudgetProvider): void;
	/** Ids of every registered provider, in the order they are asked. */
	listProviders(): readonly string[];
}

/** Whether a bus payload is a budget provider. */
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
