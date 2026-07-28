/**
 * Reading and writing the conversation on a GitHub change.
 *
 * Three of GitHub's habits are absorbed here rather than
 * leaked. It calls the two sides of a diff LEFT and RIGHT,
 * which is a display convention, so the neutral old and new
 * are translated at this boundary. It keeps review threads in
 * GraphQL and reactions in REST, with different id systems, so
 * message ids are minted with a prefix saying which route they
 * belong to. And it pages review threads a hundred at a time,
 * so the reader keeps asking until GitHub says there is no
 * more; stopping at the first page silently loses the tail of
 * a long review.
 */

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, DiffSide } from "../../anchor.js";
import type { ChangeRef, RepoLocator } from "../../change.js";
import type {
	Message,
	Posted,
	Reaction,
	ReactionCount,
	Review,
	Thread,
	Verdict,
	WireReview,
} from "../../conversation.js";
import type { ConversationFacet } from "../../provider.js";
import type { Exec } from "../exec.js";
import { run } from "../exec.js";
import { GHOST, ownerRepoFromKey } from "./claims.js";

/** Message id prefixes, naming which REST route owns the id. */
const REVIEW_COMMENT = "rc:";
const ISSUE_COMMENT = "ic:";

/** How many threads to ask for per page. GitHub's own cap. */
const THREAD_PAGE_SIZE = 100;

const THREADS_QUERY = `query PrReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: 50) {
            nodes {
              id
              databaseId
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;

const REPLY_MUTATION = `mutation AddThreadReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
  }) {
    comment { id url }
  }
}`;

const RESOLVE_MUTATION = `mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

const UNRESOLVE_MUTATION = `mutation UnresolveThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

/** GitHub's review event for each neutral verdict. */
const REVIEW_EVENT: Record<Verdict, string> = {
	approve: "APPROVE",
	"request-changes": "REQUEST_CHANGES",
	comment: "COMMENT",
};

/** The neutral verdict for each of GitHub's review states. */
function verdictOf(state: string): Verdict {
	if (state === "APPROVED") return "approve";
	if (state === "CHANGES_REQUESTED") return "request-changes";
	return "comment";
}

/** Reaction names GitHub accepts, which match the model's. */
const REACTION_NAMES: readonly Reaction[] = [
	"+1",
	"-1",
	"laugh",
	"confused",
	"heart",
	"hooray",
	"rocket",
	"eyes",
];

function slugOf(repo: RepoLocator): string {
	const owned = ownerRepoFromKey(repo.key);
	if (!owned) throw new Error(`${repo.key} is not a GitHub repo key`);
	return `${owned.owner}/${owned.repo}`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The counted reactions on a REST comment. */
function reactionsOf(value: unknown): ReactionCount[] {
	const raw = record(value);
	const counts: ReactionCount[] = [];
	for (const name of REACTION_NAMES) {
		const count = raw[name];
		if (typeof count === "number" && count > 0) {
			counts.push({ reaction: name, count });
		}
	}
	return counts;
}

/** A top-level comment, in the neutral shape. */
function messageFromIssueComment(raw: Record<string, unknown>): Message {
	const reactions = reactionsOf(raw.reactions);
	return {
		id: `${ISSUE_COMMENT}${String(raw.id ?? "")}`,
		author: { id: str(record(raw.user).login) ?? GHOST },
		body: str(raw.body) ?? "",
		...(str(raw.created_at) ? { createdAt: str(raw.created_at) } : {}),
		...(str(raw.html_url) ? { url: str(raw.html_url) } : {}),
		...(reactions.length > 0 ? { reactions } : {}),
	};
}

/** A thread comment from GraphQL, keyed for the REST routes. */
function messageFromThreadComment(raw: Record<string, unknown>): Message {
	const databaseId = raw.databaseId;
	const id =
		typeof databaseId === "number"
			? `${REVIEW_COMMENT}${databaseId}`
			: (str(raw.id) ?? "");
	return {
		id,
		author: { id: str(record(raw.author).login) ?? GHOST },
		body: str(raw.body) ?? "",
		...(str(raw.createdAt) ? { createdAt: str(raw.createdAt) } : {}),
		...(str(raw.url) ? { url: str(raw.url) } : {}),
	};
}

/** The anchor a thread carries, when it still has one. */
function anchorOf(raw: Record<string, unknown>): Anchor | undefined {
	const path = str(raw.path);
	if (!path) return undefined;
	const line = raw.line;
	if (typeof line !== "number") {
		// GitHub nulls the line when a force-push strands the
		// thread; the file is all that is left of the anchor.
		return { subject: "file", path };
	}
	const startLine = raw.startLine;
	const blob: DiffSide = str(raw.diffSide) === "LEFT" ? "old" : "new";
	return {
		subject: "line",
		path,
		blob,
		line,
		...(typeof startLine === "number" && startLine !== line
			? { startLine }
			: {}),
	};
}

function threadFrom(raw: Record<string, unknown>): Thread {
	const anchor = anchorOf(raw);
	return {
		id: str(raw.id) ?? "",
		resolved: raw.isResolved === true,
		stale: raw.isOutdated === true,
		...(anchor ? { anchor } : {}),
		comments: list(record(raw.comments).nodes).map((node) =>
			messageFromThreadComment(record(node)),
		),
	};
}

/** GitHub's wire shape for one anchored comment. */
function wireComment(anchor: Anchor, body: string): Record<string, unknown> {
	if (anchor.subject === "file") {
		return { path: anchor.path, body, subject_type: "file" };
	}
	const side = anchor.blob === "old" ? "LEFT" : "RIGHT";
	return {
		path: anchor.path,
		body,
		line: anchor.line,
		side,
		...(anchor.startLine !== undefined && anchor.startLine !== anchor.line
			? { start_line: anchor.startLine, start_side: side }
			: {}),
	};
}

/** Which REST route a message id belongs to. */
function reactionRoute(slug: string, message: Message): string {
	if (message.id.startsWith(REVIEW_COMMENT)) {
		const id = message.id.slice(REVIEW_COMMENT.length);
		return `repos/${slug}/pulls/comments/${id}/reactions`;
	}
	if (message.id.startsWith(ISSUE_COMMENT)) {
		const id = message.id.slice(ISSUE_COMMENT.length);
		return `repos/${slug}/issues/comments/${id}/reactions`;
	}
	throw new Error(
		`cannot tell what kind of comment ${message.id} is, so it cannot be reacted to`,
	);
}

/** Build the conversation facet. */
export function githubConversation(exec: Exec): ConversationFacet {
	async function api<T>(args: string[], what: string): Promise<T> {
		const stdout = await run(exec, "gh", ["api", ...args], what);
		return (stdout.trim() ? JSON.parse(stdout) : {}) as T;
	}

	/**
	 * Read a REST list in full.
	 *
	 * GitHub answers a list request with thirty records and says
	 * nothing about the rest, so a plain read of a busy pull
	 * request quietly loses its tail, which is where the recent
	 * argument is. `--paginate` walks every page and merges them
	 * into one array; asking for a hundred at a time is what
	 * keeps that from being a dozen round trips.
	 */
	async function apiList<T>(route: string, what: string): Promise<T> {
		const joiner = route.includes("?") ? "&" : "?";
		return api<T>(["--paginate", `${route}${joiner}per_page=100`], what);
	}

	async function graphql<T>(
		query: string,
		variables: Record<string, string | number>,
		what: string,
	): Promise<T> {
		const args = ["graphql", "-f", `query=${query}`];
		for (const [name, value] of Object.entries(variables)) {
			// gh uses -F for numbers and -f for raw strings.
			args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
		}
		return api<T>(args, what);
	}

	/** Post a JSON payload through a temp file. */
	async function postJson(
		route: string,
		payload: unknown,
		what: string,
	): Promise<Posted> {
		const file = join(
			tmpdir(),
			`pi-review-${Date.now()}-${Math.random()}.json`,
		);
		try {
			await writeFile(file, JSON.stringify(payload), "utf8");
			const raw = await api<unknown>(
				["--method", "POST", route, "--input", file],
				what,
			);
			const answer = record(raw);
			return {
				...(answer.id !== undefined ? { id: String(answer.id) } : {}),
				...(str(answer.html_url) ? { url: str(answer.html_url) } : {}),
			};
		} finally {
			// A leftover temp file is harmless; failing to clean one
			// up must not fail the operation that succeeded.
			await unlink(file).catch(() => {});
		}
	}

	return {
		async reviews(ref): Promise<Review[]> {
			const raw = await apiList<unknown>(
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}/reviews`,
				`reading reviews on pull request ${ref.id}`,
			);
			return list(raw).map((entry) => {
				const review = record(entry);
				const state = str(review.state) ?? "COMMENTED";
				return {
					id: String(review.id ?? ""),
					author: { id: str(record(review.user).login) ?? GHOST },
					verdict: verdictOf(state),
					nativeVerdict: state,
					body: str(review.body) ?? "",
					...(str(review.submitted_at)
						? { submittedAt: str(review.submitted_at) }
						: {}),
					...(str(review.html_url) ? { url: str(review.html_url) } : {}),
				};
			});
		},

		async threads(ref): Promise<Thread[]> {
			const owned = ownerRepoFromKey(ref.repo.key);
			if (!owned) throw new Error(`${ref.repo.key} is not a GitHub repo key`);

			const threads: Thread[] = [];
			let after: string | undefined;
			// Keep asking. A long review has more than one page, and
			// the tail is exactly where the unresolved threads are.
			for (;;) {
				const raw = await graphql<unknown>(
					THREADS_QUERY,
					{
						owner: owned.owner,
						repo: owned.repo,
						number: Number.parseInt(ref.id, 10),
						...(after ? { after } : {}),
					},
					`reading threads on pull request ${ref.id}`,
				);
				const page = record(
					record(record(record(record(raw).data).repository).pullRequest)
						.reviewThreads,
				);
				for (const node of list(page.nodes)) {
					threads.push(threadFrom(record(node)));
				}
				const info = record(page.pageInfo);
				const cursor = str(info.endCursor);
				if (info.hasNextPage !== true || !cursor) break;
				after = cursor;
			}
			return threads;
		},

		async messages(ref): Promise<Message[]> {
			const raw = await apiList<unknown>(
				`repos/${slugOf(ref.repo)}/issues/${ref.id}/comments`,
				`reading comments on pull request ${ref.id}`,
			);
			return list(raw).map((entry) => messageFromIssueComment(record(entry)));
		},

		async postReview(ref: ChangeRef, review: WireReview): Promise<Posted> {
			return postJson(
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}/reviews`,
				{
					event: REVIEW_EVENT[review.verdict],
					body: review.body,
					comments: review.comments.map((comment) =>
						wireComment(comment.anchor, comment.body),
					),
				},
				`posting a review on pull request ${ref.id}`,
			);
		},

		async reply(_ref, thread, body): Promise<Posted> {
			const raw = await graphql<unknown>(
				REPLY_MUTATION,
				{ threadId: thread.id, body },
				`replying to thread ${thread.id}`,
			);
			const comment = record(
				record(record(record(raw).data).addPullRequestReviewThreadReply)
					.comment,
			);
			return {
				...(str(comment.id) ? { id: str(comment.id) } : {}),
				...(str(comment.url) ? { url: str(comment.url) } : {}),
			};
		},

		async resolve(_ref, thread) {
			await graphql<unknown>(
				RESOLVE_MUTATION,
				{ threadId: thread.id },
				`resolving thread ${thread.id}`,
			);
		},

		async unresolve(_ref, thread) {
			await graphql<unknown>(
				UNRESOLVE_MUTATION,
				{ threadId: thread.id },
				`reopening thread ${thread.id}`,
			);
		},

		async comment(ref, body): Promise<Posted> {
			const raw = await api<unknown>(
				[
					"--method",
					"POST",
					`repos/${slugOf(ref.repo)}/issues/${ref.id}/comments`,
					"-f",
					`body=${body}`,
				],
				`commenting on pull request ${ref.id}`,
			);
			const answer = record(raw);
			return {
				...(answer.id !== undefined ? { id: String(answer.id) } : {}),
				...(str(answer.html_url) ? { url: str(answer.html_url) } : {}),
			};
		},

		async react(ref, subject, reaction) {
			await api<unknown>(
				[
					"--method",
					"POST",
					reactionRoute(slugOf(ref.repo), subject),
					"-f",
					`content=${reaction}`,
				],
				`reacting to ${subject.id}`,
			);
		},
	};
}
