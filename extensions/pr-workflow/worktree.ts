/**
 * Worktree provisioning interface and session registry.
 *
 * Council reviewers run as full pi subagents that need
 * read/grep/bash access to the PR's code at a specific SHA.
 * That access happens in a worktree the provider hands out.
 * Providers are pluggable: the default uses native git
 * worktrees; monorepos with their own worktree managers
 * (Shopify World's `world` tool, hg-based repos) can ship
 * their own provider.
 *
 * This module defines:
 *
 *   - `WorktreeProvider` — the pluggable interface.
 *   - `WorktreeHandle` — what a provider returns.
 *   - `WorktreeRequest` — what callers ask for.
 *   - `WorktreeRegistry` — per-session coordinator that
 *     reuses handles for repeat requests and releases all
 *     of them on session close.
 *
 * The native git provider lives in a separate module.
 */

/** Event emitted by pr-workflow once its registration API is ready. */
export const PR_WORKFLOW_READY = "pr-workflow:ready:v1";

/** Event external extensions emit to register a worktree provider. */
export const PR_WORKFLOW_REGISTER_WORKTREE_PROVIDER =
	"pr-workflow:worktree-provider:register:v1";

/** What a caller wants a worktree for. */
export interface WorktreeRequest {
	readonly owner: string;
	readonly repo: string;
	/** Commit SHA the worktree must be checked out at. */
	readonly sha: string;
	/** Optional branch hint; provider may retrieve it if appropriate. */
	readonly branch?: string;
}

/** What a provider returns. */
export interface WorktreeHandle {
	/** Absolute path to the checked-out tree. */
	readonly path: string;
	/** Commit SHA actually checked out. */
	readonly sha: string;
	/** Branch checked out, if any. */
	readonly branch?: string;
	/** Identifier of the provider that owns this handle. */
	readonly providerId: string;
	/** Can other requests share this handle? */
	readonly reusable: boolean;
	/** When the handle was created. */
	readonly createdAt: Date;
	/**
	 * Provider-specific opaque data. The registry doesn't
	 * read it; the provider's `release()` uses it to find
	 * the resource being released.
	 */
	readonly marker?: string;
}

/** Pluggable interface for getting at PR code. */
export interface WorktreeProvider {
	/** Stable identifier for logs and config. */
	readonly id: string;
	/** Higher-priority providers are consulted first. */
	readonly priority?: number;

	/** Whether this provider can satisfy `request`. Defaults to true. */
	canHandle?(request: WorktreeRequest): boolean | Promise<boolean>;

	/**
	 * Ensure a worktree exists for the requested ref.
	 * Reuse an existing one when possible.
	 */
	ensure(request: WorktreeRequest): Promise<WorktreeHandle>;

	/**
	 * Release the resources backing this handle. Providers
	 * decide whether to delete, leave in place, or no-op.
	 * Called on session close and on explicit cleanup.
	 */
	release(handle: WorktreeHandle): Promise<void>;

	/** Optional: list currently active handles. */
	list?(): Promise<WorktreeHandle[]>;
}

/** Public runtime API exposed over the pi event bus. */
export interface PrWorkflowWorktreeApi {
	/** Register or replace a provider for future worktree requests. */
	registerWorktreeProvider(provider: WorktreeProvider): void;
	/** Return provider ids in the order they will be consulted. */
	listWorktreeProviders(): readonly string[];
}

/** Type guard for event-bus worktree provider registrations. */
export function isWorktreeProvider(value: unknown): value is WorktreeProvider {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.ensure === "function" &&
		typeof record.release === "function" &&
		(record.canHandle === undefined || typeof record.canHandle === "function")
	);
}

/**
 * Per-session coordinator over a single `WorktreeProvider`.
 *
 * - Deduplicates by repo+sha so two reviewers asking for
 *   the same PR head don't double-provision.
 * - Tracks every handle so `releaseAll()` can clean up on
 *   session close.
 * - Continues releasing remaining handles when one fails,
 *   then re-throws the collected errors.
 */
export class WorktreeProviderBroker implements WorktreeProvider {
	readonly id = "broker";
	private readonly providers: WorktreeProvider[] = [];

	constructor(private readonly fallback: WorktreeProvider) {}

	/** Register or replace a provider. */
	register(provider: WorktreeProvider): void {
		const index = this.providers.findIndex((p) => p.id === provider.id);
		if (index >= 0) {
			this.providers[index] = provider;
		} else {
			this.providers.push(provider);
		}
		this.providers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	/** Provider ids in consultation order, including fallback last. */
	providerIds(): readonly string[] {
		return [...this.providers.map((p) => p.id), this.fallback.id];
	}

	async ensure(request: WorktreeRequest): Promise<WorktreeHandle> {
		const provider = await this.selectProvider(request);
		return provider.ensure(request);
	}

	async release(handle: WorktreeHandle): Promise<void> {
		return this.providerForHandle(handle).release(handle);
	}

	async list(): Promise<WorktreeHandle[]> {
		const handles: WorktreeHandle[] = [];
		for (const provider of [...this.providers, this.fallback]) {
			if (provider.list) handles.push(...(await provider.list()));
		}
		return handles;
	}

	private async selectProvider(
		request: WorktreeRequest,
	): Promise<WorktreeProvider> {
		for (const provider of this.providers) {
			if (await providerCanHandle(provider, request)) return provider;
		}
		return this.fallback;
	}

	private providerForHandle(handle: WorktreeHandle): WorktreeProvider {
		return (
			this.providers.find((p) => p.id === handle.providerId) ?? this.fallback
		);
	}
}

export class WorktreeRegistry {
	private readonly active_: Map<string, WorktreeHandle> = new Map();

	constructor(private readonly provider: WorktreeProvider) {}

	/** Provision (or reuse) a worktree for `request`. */
	async ensure(request: WorktreeRequest): Promise<WorktreeHandle> {
		const key = keyOf(request);
		const existing = this.active_.get(key);
		if (existing) return existing;
		const handle = await this.provider.ensure(request);
		this.active_.set(key, handle);
		return handle;
	}

	/**
	 * Release every active handle. Continues past failures
	 * so a single bad cleanup doesn't strand other trees.
	 * Re-throws an aggregate error at the end if any
	 * release failed.
	 */
	async releaseAll(): Promise<void> {
		const handles = Array.from(this.active_.values());
		this.active_.clear();
		const errors: unknown[] = [];
		for (const handle of handles) {
			try {
				await this.provider.release(handle);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) {
			throw new AggregateError(errors, "One or more worktree releases failed");
		}
	}

	/** Snapshot of currently-allocated handles. */
	active(): WorktreeHandle[] {
		return Array.from(this.active_.values());
	}
}

async function providerCanHandle(
	provider: WorktreeProvider,
	request: WorktreeRequest,
): Promise<boolean> {
	return provider.canHandle ? await provider.canHandle(request) : true;
}

function keyOf(request: WorktreeRequest): string {
	return `${request.owner}/${request.repo}@${request.sha}`;
}
