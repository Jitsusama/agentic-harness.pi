import type {
	Capabilities,
	ChangeRef,
	RepoLocator,
	RepoProbe,
	ReviewProvider,
} from "@jitsusama/agentic-harness.core/review";

/** Overrides a test cares about; the rest is inert. */
export interface StubOptions {
	id: string;
	priority: number;
	/** Recognize a reference, or claim nothing by default. */
	claimReference?: (input: string, repo?: RepoLocator) => ChangeRef | null;
	/** Recognize a repo, or claim nothing by default. */
	claimRepo?: (probe: RepoProbe) => RepoLocator | null;
	capabilities?: Capabilities;
	facets?: Partial<
		Pick<
			ReviewProvider,
			"proposals" | "stacking" | "conversation" | "authoring"
		>
	>;
}

/**
 * A provider that claims nothing and does nothing unless a
 * test says otherwise. Tests of resolution care only about
 * claiming, so everything else stays absent rather than
 * being stubbed into existence.
 */
export function stubProvider(options: StubOptions): ReviewProvider {
	return {
		id: options.id,
		priority: options.priority,
		claimReference: options.claimReference ?? (() => null),
		claimRepo: options.claimRepo ?? (() => null),
		capabilities: () => options.capabilities ?? {},
		...options.facets,
	};
}

/** A provider that claims any reference for one repo. */
export function claimingProvider(
	id: string,
	priority: number,
	repo: RepoLocator,
): ReviewProvider {
	return stubProvider({
		id,
		priority,
		claimReference: (input) => ({
			provider: id,
			repo,
			id: input,
			label: `${repo.key}#${input}`,
		}),
		claimRepo: () => repo,
	});
}
