/**
 * Deriving a stack from GitHub, which records none.
 *
 * GitHub knows only each pull request's base and head branch
 * names, so a stack has to be inferred by matching one
 * request's base against another's head. That inference is
 * wrong at the edges by construction: a merged parent
 * disappears from the open listing and the chain simply ends,
 * a renamed branch breaks the link, and two forks can use the
 * same branch name. This is why every stack reports its
 * provenance, and why this one always reports `derived`.
 *
 * The walk follows fan-out downwards, because a branch with two
 * children is a real shape people build and reporting only one
 * of them would be a lie of omission.
 */

import type { ChangeRef, Proposal } from "../../change.js";
import type { LocalBranch, StackingFacet } from "../../provider.js";
import type { Stack, StackNode } from "../../stack.js";
import type { Exec } from "../exec.js";
import { githubProposals } from "./proposals.js";

/** How far to walk in each direction before giving up. */
const MAX_DEPTH = 8;

/** Build the stacking facet. */
export function githubStacking(exec: Exec): StackingFacet {
	const proposals = githubProposals(exec);

	/** The single open change whose head is this branch. */
	async function byHead(
		ref: ChangeRef,
		branch: string,
	): Promise<Proposal | undefined> {
		const found = await proposals.list?.(ref.repo, {
			state: "open",
			head: branch,
		});
		return found?.[0];
	}

	/** Every open change based on this branch. */
	async function byBase(ref: ChangeRef, branch: string): Promise<Proposal[]> {
		return (
			(await proposals.list?.(ref.repo, { state: "open", base: branch })) ?? []
		);
	}

	return {
		async stack(subject: ChangeRef | LocalBranch): Promise<Stack> {
			if (!("id" in subject)) {
				throw new Error(
					"the GitHub provider derives a stack from a pull request, not a bare branch",
				);
			}
			const cursorProposal = await proposals.fetch(subject);

			// Upwards: follow base to the change whose head it is.
			const seen = new Set<string>([cursorProposal.head]);
			const ancestors: Proposal[] = [];
			let climbing = cursorProposal.base;
			for (let depth = 0; depth < MAX_DEPTH; depth++) {
				const parent = await byHead(subject, climbing);
				if (!parent || seen.has(parent.head)) break;
				seen.add(parent.head);
				ancestors.unshift(parent);
				climbing = parent.base;
			}

			// Downwards: every change based on a branch we hold,
			// breadth first, so a fan-out reports both sides.
			const descendants: { proposal: Proposal; parent: string }[] = [];
			let frontier = [cursorProposal.head];
			for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
				const next: string[] = [];
				for (const branch of frontier) {
					for (const child of await byBase(subject, branch)) {
						if (seen.has(child.head)) continue;
						seen.add(child.head);
						descendants.push({ proposal: child, parent: branch });
						next.push(child.head);
					}
				}
				frontier = next;
			}

			const ordered: StackNode[] = [];
			ancestors.forEach((proposal, index) => {
				const parent = index === 0 ? undefined : ancestors[index - 1].head;
				ordered.push({
					ref: proposal.head,
					...(parent ? { parent } : {}),
					...(proposal.headCommit ? { headCommit: proposal.headCommit } : {}),
					proposal,
				});
			});

			const cursor = ordered.length;
			const cursorParent = ancestors.at(-1)?.head;
			ordered.push({
				ref: cursorProposal.head,
				...(cursorParent ? { parent: cursorParent } : {}),
				...(cursorProposal.headCommit
					? { headCommit: cursorProposal.headCommit }
					: {}),
				proposal: cursorProposal,
			});

			for (const { proposal, parent } of descendants) {
				ordered.push({
					ref: proposal.head,
					parent,
					...(proposal.headCommit ? { headCommit: proposal.headCommit } : {}),
					proposal,
				});
			}

			const trunk = ancestors[0]?.base ?? cursorProposal.base;
			return {
				provenance: "derived",
				trunk,
				nodes: ordered,
				cursor,
			};
		},
	};
}
