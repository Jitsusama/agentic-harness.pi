/**
 * GitHub-backed implementation of `PrSearch`.
 *
 * Looks up open PRs in a fixed repository by their head or
 * base branch using GraphQL. Used by stack discovery; kept
 * thin so the walker stays pure and the production wiring
 * stays out of the unit test surface.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runGraphQL } from "../../lib/internal/github/graphql.js";
import type { PrSearch, StackEntry } from "./stack.js";

const BY_HEAD_QUERY = `query PrByHead(
  $owner: String!,
  $repo: String!,
  $head: String!
) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, headRefName: $head, first: 1) {
      nodes { number title baseRefName headRefName }
    }
  }
}`;

const BY_BASE_QUERY = `query PrByBase(
  $owner: String!,
  $repo: String!,
  $base: String!
) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, baseRefName: $base, first: 25) {
      nodes { number title baseRefName headRefName }
    }
  }
}`;

interface PrNode {
	number: number;
	title: string;
	baseRefName: string;
	headRefName: string;
}

interface ByHeadResponse {
	data?: { repository?: { pullRequests?: { nodes?: PrNode[] } } };
}

interface ByBaseResponse {
	data?: { repository?: { pullRequests?: { nodes?: PrNode[] } } };
}

/**
 * Build a `PrSearch` scoped to a specific repository.
 *
 * Each call to `findByHead` / `findByBase` runs one GraphQL
 * query. The walker calls these at most `maxDepth * 2` times
 * for a typical stack discovery.
 */
export function createGitHubPrSearch(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
): PrSearch {
	return {
		async findByHead(branch) {
			const response = await runGraphQL<ByHeadResponse>(pi, BY_HEAD_QUERY, {
				owner,
				repo,
				head: branch,
			});
			const node = response.data?.repository?.pullRequests?.nodes?.[0];
			return node ? toEntry(owner, repo, node) : null;
		},
		async findByBase(branch) {
			const response = await runGraphQL<ByBaseResponse>(pi, BY_BASE_QUERY, {
				owner,
				repo,
				base: branch,
			});
			const nodes = response.data?.repository?.pullRequests?.nodes ?? [];
			return nodes.map((n) => toEntry(owner, repo, n));
		},
	};
}

function toEntry(owner: string, repo: string, node: PrNode): StackEntry {
	return {
		reference: { owner, repo, number: node.number },
		title: node.title,
		baseRefName: node.baseRefName,
		headRefName: node.headRefName,
	};
}
