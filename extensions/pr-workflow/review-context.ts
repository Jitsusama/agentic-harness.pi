/** Review-context provider interface and registry for pr-workflow prompts. */

/** Event external extensions emit to register a review-context provider. */
export const PR_WORKFLOW_REGISTER_REVIEW_CONTEXT_PROVIDER =
	"pr-workflow:review-context-provider:register:v1";

/** Prompt stage requesting repository or workspace context. */
export type ReviewContextStage =
	| "council"
	| "judge"
	| "critique"
	| "stack-review"
	| "stack-judge";

/** What a prompt builder wants review context for. */
export interface ReviewContextRequest {
	readonly owner: string;
	readonly repo: string;
	readonly prNumber: number;
	readonly sha: string;
	readonly branch?: string;
	readonly stage: ReviewContextStage;
}

/** Pluggable provider for repository or workspace review guidance. */
export interface ReviewContextProvider {
	/** Stable identifier for diagnostics. */
	readonly id: string;
	/** Higher-priority providers contribute context first. */
	readonly priority?: number;
	/** Whether this provider applies to `request`. Defaults to true. */
	canHandle?(request: ReviewContextRequest): boolean | Promise<boolean>;
	/** Return prompt guidance for this request. Empty strings are ignored. */
	context(request: ReviewContextRequest): string | Promise<string>;
}

/** Public runtime API exposed over the pi event bus. */
export interface PrWorkflowReviewContextApi {
	/** Register or replace a review-context provider for future prompts. */
	registerReviewContextProvider(provider: ReviewContextProvider): void;
	/** Return provider ids in the order they will be consulted. */
	listReviewContextProviders(): readonly string[];
}

/** Type guard for event-bus review-context provider registrations. */
export function isReviewContextProvider(
	value: unknown,
): value is ReviewContextProvider {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.context === "function" &&
		(record.canHandle === undefined || typeof record.canHandle === "function")
	);
}

/** Coordinates all registered review-context providers. */
export class ReviewContextProviderBroker {
	private readonly providers: ReviewContextProvider[] = [];

	/** Register or replace a provider. */
	register(provider: ReviewContextProvider): void {
		const index = this.providers.findIndex((p) => p.id === provider.id);
		if (index >= 0) {
			this.providers[index] = provider;
		} else {
			this.providers.push(provider);
		}
		this.providers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	/** Provider ids in consultation order. */
	providerIds(): readonly string[] {
		return this.providers.map((provider) => provider.id);
	}

	/** Collect matching provider context as a single prompt addendum. */
	async promptAddendum(request: ReviewContextRequest): Promise<string> {
		const parts: string[] = [];
		for (const provider of this.providers) {
			if (!(await providerCanHandle(provider, request))) continue;
			const context = (await provider.context(request)).trim();
			if (context.length > 0) parts.push(context);
		}
		return parts.join("\n\n");
	}
}

async function providerCanHandle(
	provider: ReviewContextProvider,
	request: ReviewContextRequest,
): Promise<boolean> {
	return provider.canHandle ? await provider.canHandle(request) : true;
}
