/**
 * The git provider: a repo with no forge behind it.
 *
 * This is the provider that proves the contract is honest.
 * A checkout has topology and diffs and no conversation
 * anywhere, so it implements stacking and nothing else, and a
 * consumer that asks whether it can post a review gets a
 * straight no rather than a method that throws.
 *
 * Parentage comes from the upstream a branch records, which is
 * what every local stacking tool surveyed uses and what plain
 * `git branch --set-upstream-to` writes. Reading only that,
 * plus merge-base for the fork point, keeps this provider
 * truthful about ordinary git; the tool-specific conventions
 * (metadata refs, state files) each make a further fidelity
 * claim and belong in providers of their own.
 */

import type { Capabilities } from "../../capabilities.js";
import type { ChangeRef, RepoLocator } from "../../change.js";
import type {
	LocalBranch,
	RepoProbe,
	ReviewProvider,
	StackingFacet,
} from "../../provider.js";
import type { Stack, StackNode } from "../../stack.js";
import type { Exec, ProviderDeps } from "../exec.js";
import { run } from "../exec.js";

/** Provider id. */
export const GIT_PROVIDER_ID = "git";

/**
 * Claim priority. Last: a bare checkout is the fallback when
 * no forge recognizes the repo, never the first answer.
 */
const GIT_PRIORITY = 900;

/** How far to walk before deciding the config is cyclic. */
const MAX_DEPTH = 16;

/** The repo key a local checkout gets. */
function localKey(repoRoot: string): string {
	return `local:${repoRoot}`;
}

/** A branch name, however the caller spelled it. */
function branchName(ref: string): string {
	return ref.replace(/^refs\/heads\//, "");
}

/** What a bare repo can do. */
function gitCapabilities(): Capabilities {
	return { stacking: { provenance: "derived", fanOut: true } };
}

/** Build the stacking facet over a checkout. */
function gitStacking(exec: Exec): StackingFacet {
	/** The branch this one tracks, when it records one. */
	async function upstreamOf(
		root: string,
		branch: string,
	): Promise<string | undefined> {
		const result = await exec("git", [
			"-C",
			root,
			"config",
			"--get",
			`branch.${branch}.merge`,
		]);
		// A branch with no upstream exits nonzero, which is an
		// answer rather than a failure.
		if (result.code !== 0) return undefined;
		const value = result.stdout.trim();
		return value ? branchName(value) : undefined;
	}

	/** Every branch paired with the upstream it records. */
	async function upstreamMap(root: string): Promise<Map<string, string>> {
		const stdout = await run(
			exec,
			"git",
			[
				"-C",
				root,
				"for-each-ref",
				"--format=%(refname:short)|%(upstream:short)",
				"refs/heads",
			],
			"listing branches",
		);
		const pairs = new Map<string, string>();
		for (const line of stdout.split("\n")) {
			const [branch, upstream] = line.split("|");
			if (!branch || !upstream) continue;
			pairs.set(branch.trim(), branchName(upstream.trim()));
		}
		return pairs;
	}

	async function tipOf(
		root: string,
		branch: string,
	): Promise<string | undefined> {
		const result = await exec("git", ["-C", root, "rev-parse", branch]);
		return result.code === 0 ? result.stdout.trim() : undefined;
	}

	async function forkPointOf(
		root: string,
		branch: string,
		parent: string,
	): Promise<string | undefined> {
		const result = await exec("git", [
			"-C",
			root,
			"merge-base",
			parent,
			branch,
		]);
		return result.code === 0 ? result.stdout.trim() : undefined;
	}

	return {
		async stack(subject: ChangeRef | LocalBranch): Promise<Stack> {
			if ("id" in subject) {
				throw new Error(
					"the git provider reads a stack from a branch, not a hosted change",
				);
			}
			const root = subject.repo.localPath;
			if (!root) {
				throw new Error(`${subject.repo.key} has no local checkout to read`);
			}
			const cursorBranch = branchName(subject.ref);

			// Upwards: follow each branch's recorded upstream.
			const ancestors: string[] = [];
			const seen = new Set<string>([cursorBranch]);
			let climbing = await upstreamOf(root, cursorBranch);
			let trunk: string | undefined;
			for (let depth = 0; depth < MAX_DEPTH && climbing; depth++) {
				if (seen.has(climbing)) break;
				const above = await upstreamOf(root, climbing);
				if (!above) {
					// The branch that tracks nothing is the trunk, and
					// the trunk is not part of the stack.
					trunk = climbing;
					break;
				}
				seen.add(climbing);
				ancestors.unshift(climbing);
				climbing = above;
			}

			// Downwards: whoever records one of ours as upstream.
			const pairs = await upstreamMap(root);
			const descendants: { branch: string; parent: string }[] = [];
			let frontier = [cursorBranch];
			for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
				const next: string[] = [];
				for (const parent of frontier) {
					for (const [branch, upstream] of pairs) {
						if (upstream !== parent || seen.has(branch)) continue;
						seen.add(branch);
						descendants.push({ branch, parent });
						next.push(branch);
					}
				}
				frontier = next;
			}

			const chain = [...ancestors, cursorBranch];
			const nodes: StackNode[] = [];
			for (const [index, branch] of chain.entries()) {
				const parent = index === 0 ? trunk : chain[index - 1];
				nodes.push(
					await describe(
						root,
						branch,
						index === 0 ? undefined : parent,
						parent,
					),
				);
			}
			for (const { branch, parent } of descendants) {
				nodes.push(await describe(root, branch, parent, parent));
			}

			return {
				provenance: "derived",
				...(trunk ? { trunk } : {}),
				nodes,
				cursor: ancestors.length,
			};
		},
	};

	/**
	 * One node. `parent` is the link to report; `against` is
	 * what to measure the fork point from, which for a root is
	 * the trunk even though the trunk is not its parent in the
	 * stack.
	 */
	async function describe(
		root: string,
		branch: string,
		parent: string | undefined,
		against: string | undefined,
	): Promise<StackNode> {
		const headCommit = await tipOf(root, branch);
		const forkPoint = against
			? await forkPointOf(root, branch, against)
			: undefined;
		return {
			ref: branch,
			...(parent ? { parent } : {}),
			...(headCommit ? { headCommit } : {}),
			...(forkPoint ? { forkPoint } : {}),
		};
	}
}

/** Build the git provider. */
export function createGitProvider(deps: ProviderDeps): ReviewProvider {
	return {
		id: GIT_PROVIDER_ID,
		priority: GIT_PRIORITY,

		claimReference(input: string, repo?: RepoLocator): ChangeRef | null {
			// Without a repo there is nothing to read a branch or a
			// range against, so this is not ours to claim.
			if (!repo) return null;
			const trimmed = input.trim();
			if (!trimmed) return null;
			return { provider: GIT_PROVIDER_ID, repo, id: trimmed };
		},

		claimRepo(probe: RepoProbe): RepoLocator | null {
			if (!probe.repoRoot) return null;
			return { key: localKey(probe.repoRoot), localPath: probe.repoRoot };
		},

		capabilities: gitCapabilities,
		stacking: gitStacking(deps.exec),
	};
}
