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
import type { Proposal, RepoLocator, ReviewTarget } from "./change.js";
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
				return provider.proposals.diff(target.change);
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
