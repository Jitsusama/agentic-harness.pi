/**
 * The layer consumers actually talk to.
 *
 * Everything below this is deliberately separate: a model, a
 * provider contract, a resolver, a draft. That separation is
 * what makes each piece testable, but a consumer should not
 * have to assemble them. So the engine does it: hand it a
 * reference or a checkout, get back something that knows its
 * own provider, capabilities, diff and stack, and can open a
 * draft about itself.
 */

import { resolveTarget } from "./bind.js";
import type { Capabilities } from "./capabilities.js";
import type {
	ChangeRef,
	Proposal,
	RepoLocator,
	ReviewTarget,
} from "./change.js";
import type { ChecksRollup } from "./checks.js";
import type { ReviewConfig } from "./config.js";
import type { DiffModel } from "./diff.js";
import { parseUnifiedDiff } from "./diff.js";
import type { DraftDeps, ReviewDraft } from "./draft/handle.js";
import { openDraft } from "./draft/handle.js";
import type { DraftStore } from "./draft/store.js";
import type {
	ConversationFacet,
	RepoProbe,
	ReviewProvider,
} from "./provider.js";
import type { Exec } from "./providers/exec.js";
import { run } from "./providers/exec.js";
import { getReviewProvider } from "./register.js";
import { resolveReference } from "./resolve.js";
import type { Stack } from "./stack.js";

/** What the engine needs to work. */
export interface ReviewEngineDeps {
	exec: Exec;
	store: DraftStore;
	/** The user's `review` config section, when there is one. */
	config?: ReviewConfig;
}

/** Which local refs to review. */
export type LocalSpec = { base: string; head: string } | { refs: string[] };

/** A target with its provider and everything reachable from it. */
export interface BoundTarget {
	target: ReviewTarget;
	provider: ReviewProvider;
	repo: RepoLocator;
	capabilities: Capabilities;
	/** The hosted change, when the target is one. */
	proposal(): Promise<Proposal | null>;
	/** Unified diff, from the provider or from local git. */
	diff(): Promise<string>;
	/** The same diff, parsed. */
	diffModel(): Promise<DiffModel>;
	/** The stack, when the provider can read one. */
	stack(): Promise<Stack | null>;
	/** CI state, when the provider reports it. */
	checks(): Promise<ChecksRollup | null>;
	/** The conversation, or null when nothing hosts this target. */
	conversation: ConversationFacet | null;
}

/** The substrate, assembled. */
export interface ReviewEngine {
	/** What a directory says about the repo it sits in. */
	probe(cwd: string): Promise<RepoProbe>;
	/** Resolve a reference, throwing the resolver's guidance. */
	resolve(input: string, cwd?: string): Promise<BoundTarget>;
	/**
	 * Bind a change whose system is already known.
	 *
	 * For a caller that resolved once and kept the answer. Going
	 * back through {@link resolve} would ask every provider to
	 * claim the name again, and claiming depends on the directory
	 * the question is asked from, so the same change can bind to a
	 * different system on a later call. That is exactly how a
	 * review reaches a mirror instead of the system of record.
	 */
	bound(change: ChangeRef): Promise<BoundTarget>;
	/** Review refs in a checkout, hosted or not. */
	fromLocal(repoRoot: string, spec: LocalSpec): Promise<BoundTarget>;
	openDraft(target: ReviewTarget): Promise<ReviewDraft>;
}

/** The two endpoints of whatever the target covers. */
function endpointsOf(target: ReviewTarget): { base: string; head: string } {
	if (target.kind === "range") {
		return { base: target.base, head: target.head };
	}
	if (target.kind === "stack") {
		// A stack's diff is everything from below its first ref to
		// the tip of its last.
		return {
			base: target.refs[0] ?? "HEAD",
			head: target.refs.at(-1) ?? "HEAD",
		};
	}
	throw new Error("a hosted change has no local endpoints");
}

/**
 * The provider a change names, or a refusal that names it back.
 *
 * A change carrying a system nobody registered almost always
 * means an extension did not load, and saying which system is
 * missing is what points at it.
 */
function providerFor(id: string): ReviewProvider {
	const provider = getReviewProvider(id);
	if (!provider) {
		throw new Error(
			`This change belongs to ${id}, and no ${id} provider is registered, so it cannot be reached. The extension that contributes it may not be loaded.`,
		);
	}
	return provider;
}

/** Build the engine. */
export function createReviewEngine(deps: ReviewEngineDeps): ReviewEngine {
	const draftDeps: DraftDeps = { store: deps.store };

	async function probe(cwd: string): Promise<RepoProbe> {
		const top = await deps.exec("git", [
			"-C",
			cwd,
			"rev-parse",
			"--show-toplevel",
		]);
		// Not being in a repo is an ordinary answer, not a failure:
		// a reference can still be a URL.
		if (top.code !== 0) return {};
		const repoRoot = top.stdout.trim();

		const remotes = await deps.exec("git", [
			"-C",
			repoRoot,
			"config",
			"--get-regexp",
			"^remote\\..*\\.url$",
		]);
		const remoteUrls =
			remotes.code === 0
				? remotes.stdout
						.split("\n")
						.map((line) => line.trim().split(/\s+/)[1])
						.filter((url): url is string => Boolean(url))
				: [];
		return { repoRoot, remoteUrls };
	}

	/** Wrap a resolved target in everything reachable from it. */
	function bind(
		target: ReviewTarget,
		provider: ReviewProvider,
		repo: RepoLocator,
	): BoundTarget {
		let diffText: Promise<string> | undefined;

		async function readDiff(): Promise<string> {
			if (target.kind === "proposal") {
				if (!provider.proposals) {
					throw new Error(`the ${provider.id} provider cannot read a diff`);
				}
				try {
					return await provider.proposals.diff(target.change);
				} catch (error) {
					// A big change is the case a diff is most wanted for and the one
					// that failed hardest: a backend that caps its own diff route
					// answered with a raw upstream refusal and the read was over,
					// while the same provider offered `fetchAsRef` for exactly this
					// and nothing reached for it. Bringing the commits down and
					// diffing them locally has no such cap.
					return await diffFromRef(target.change, error);
				}
			}
			const root = repo.localPath ?? target.repo.localPath;
			if (!root) {
				throw new Error(`${repo.key} has no local checkout to diff`);
			}
			const { base, head } = endpointsOf(target);
			return run(
				deps.exec,
				"git",
				["-C", root, "diff", `${base}...${head}`],
				`diffing ${base}...${head}`,
			);
		}

		/**
		 * The diff read from a ref the provider fetched, when its own route
		 * would not answer.
		 *
		 * The original failure is carried into anything said here, because the
		 * fallback can fail for reasons of its own and being told only about
		 * the second one sends somebody after the wrong problem.
		 */
		async function diffFromRef(
			change: ChangeRef,
			cause: unknown,
		): Promise<string> {
			const why = cause instanceof Error ? cause.message : String(cause);
			const fetchAsRef = provider.proposals?.fetchAsRef;
			const root = repo.localPath ?? change.repo.localPath;
			if (!fetchAsRef || !root) {
				throw new Error(
					`${why}\n\nThe ${provider.id} provider ${fetchAsRef ? `has no local checkout of ${repo.key} to read ${change.label} into` : "cannot fetch a change as a ref"}, so there is no way around that. Read the change a file at a time instead.`,
				);
			}

			const head = await fetchAsRef(change, root);
			// The base is not fetched with it, and the diff is against the base.
			// Asking the provider what the base is costs one read and beats
			// guessing at a default branch name.
			const base = (await provider.proposals?.fetch(change))?.base;
			if (base === undefined) {
				throw new Error(
					`${why}\n\n${change.label} was fetched to ${head}, but the ${provider.id} provider did not say what it is based on, so there is nothing to diff it against.`,
				);
			}

			const read = await deps.exec("git", [
				"-C",
				root,
				"diff",
				`${base}...${head}`,
			]);
			if (read.code !== 0) {
				// Both causes, because the fallback fails for its own reasons and
				// hearing only the second sends somebody after the wrong problem.
				// The usual one is a checkout that has never seen the base.
				throw new Error(
					`${why}\n\nReading it from a fetched ref instead did not work either: diffing ${base}...${head} in ${root} said ${read.stderr.trim() || `exit ${read.code}`}. Fetch ${base} into that checkout and try again.`,
				);
			}
			return read.stdout;
		}

		function diff(): Promise<string> {
			// One read per bound target: a diff is asked for by the
			// council, the planner and the renderer in turn.
			diffText ??= readDiff();
			return diffText;
		}

		return {
			target,
			provider,
			repo,
			capabilities: provider.capabilities(repo),
			conversation:
				target.kind === "proposal" ? (provider.conversation ?? null) : null,

			async proposal() {
				if (target.kind !== "proposal" || !provider.proposals) return null;
				return provider.proposals.fetch(target.change);
			},

			diff,

			async diffModel() {
				return parseUnifiedDiff(await diff());
			},

			async stack() {
				if (!provider.stacking) return null;
				if (target.kind === "proposal") {
					return provider.stacking.stack(target.change);
				}
				const { head } = endpointsOf(target);
				return provider.stacking.stack({ repo, ref: head });
			},

			async checks() {
				if (target.kind !== "proposal" || !provider.proposals?.checks) {
					return null;
				}
				return provider.proposals.checks(target.change);
			},
		};
	}

	/** Resolve a target to its provider, throwing the guidance. */
	function bindTargetOrThrow(
		target: ReviewTarget,
		context: { probe?: RepoProbe },
	): BoundTarget {
		const resolved = resolveTarget(target, {
			...(deps.config ? { config: deps.config } : {}),
			...(context.probe ? { probe: context.probe } : {}),
		});
		if (!resolved.resolved) throw new Error(resolved.message);
		return bind(target, resolved.provider, resolved.repo);
	}

	return {
		probe,

		async resolve(input, cwd) {
			const probed = cwd ? await probe(cwd) : undefined;
			const resolution = resolveReference(input, {
				...(deps.config ? { config: deps.config } : {}),
				...(probed ? { probe: probed } : {}),
			});
			if (!resolution.resolved) throw new Error(resolution.message);
			const target: ReviewTarget = {
				kind: "proposal",
				change: resolution.change,
			};
			return bind(target, resolution.provider, resolution.change.repo);
		},

		async bound(change) {
			return bind(
				{ kind: "proposal", change },
				providerFor(change.provider),
				change.repo,
			);
		},

		async fromLocal(repoRoot, spec) {
			const probed = await probe(repoRoot);
			const repo: RepoLocator = {
				key: `local:${probed.repoRoot ?? repoRoot}`,
				localPath: probed.repoRoot ?? repoRoot,
			};
			const target: ReviewTarget =
				"refs" in spec
					? { kind: "stack", repo, refs: spec.refs }
					: { kind: "range", repo, base: spec.base, head: spec.head };
			return bindTargetOrThrow(target, { probe: probed });
		},

		openDraft: (target) => openDraft(target, draftDeps),
	};
}

/** Kept so the stub compiles against its imports. */
void [openDraft, parseUnifiedDiff, resolveReference, resolveTarget, run];

export type { DraftDeps };
