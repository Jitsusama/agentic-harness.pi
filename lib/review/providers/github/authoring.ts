/**
 * Making and changing pull requests on GitHub.
 *
 * Every write goes through the REST API with a JSON body on disk,
 * rather than through `gh pr create` and its siblings. The porcelain
 * commands are friendlier to type and worse to call: they infer the
 * base from the current checkout, they read a title out of the last
 * commit when one is not given, and their flags have defaults that
 * change what an omitted argument means. A caller here has already
 * decided all of that, and inference at this layer would quietly
 * overrule it.
 *
 * The body goes through a file for the same reason a commit message
 * does. A pull request body is prose with newlines, quotes and
 * backticks in it, and putting that on a command line is a quoting bug
 * waiting for the first person who writes a shell snippet in a
 * description.
 */

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeRef, Proposal, RepoLocator } from "../../change.js";
import type {
	AuthoringFacet,
	MergeRequest,
	ProposalDraft,
	ProposalEdit,
} from "../../provider.js";
import { type Exec, run } from "../exec.js";
import { githubChange, ownerRepoFromKey } from "./claims.js";

/** `owner/name`, as every GitHub route wants it. */
function slugOf(repo: RepoLocator): string {
	const owned = ownerRepoFromKey(repo.key);
	if (!owned) throw new Error(`${repo.key} is not a GitHub repo key`);
	return `${owned.owner}/${owned.repo}`;
}

/** Build the authoring facet. */
export function githubAuthoring(exec: Exec): AuthoringFacet {
	/**
	 * One API call carrying a JSON body.
	 *
	 * The temp file is cleaned up in a finally, and a failure to clean
	 * it up is swallowed: a leftover file is harmless, and letting it
	 * fail would turn a successful write into a reported error.
	 */
	async function send(
		method: "POST" | "PATCH" | "PUT",
		route: string,
		payload: Record<string, unknown>,
		what: string,
	): Promise<string> {
		const file = join(
			tmpdir(),
			`pi-review-authoring-${Date.now()}-${Math.random()}.json`,
		);
		try {
			await writeFile(file, JSON.stringify(payload), "utf8");
			return await run(
				exec,
				"gh",
				["api", "--method", method, route, "--input", file],
				what,
			);
		} finally {
			try {
				await unlink(file);
			} catch {
				// A leftover temp file is harmless, and failing to remove
				// one must not fail the write that already succeeded.
			}
		}
	}

	/** A GraphQL mutation, for the two things REST will not do. */
	async function mutate(
		query: string,
		id: string,
		what: string,
	): Promise<void> {
		await run(
			exec,
			"gh",
			["api", "graphql", "-f", `query=${query}`, "-F", `id=${id}`],
			what,
		);
	}

	/** The node id GitHub's GraphQL wants, which REST does not carry. */
	async function nodeId(ref: ChangeRef): Promise<string> {
		const stdout = await run(
			exec,
			"gh",
			["api", `repos/${slugOf(ref.repo)}/pulls/${ref.id}`, "--jq", ".node_id"],
			`reading the id of pull request ${ref.id}`,
		);
		return stdout.trim();
	}

	return {
		async propose(draft: ProposalDraft): Promise<Proposal> {
			const raw = await send(
				"POST",
				`repos/${slugOf(draft.repo)}/pulls`,
				{
					base: draft.base,
					head: draft.head,
					title: draft.title,
					body: draft.body,
					// Always sent, never omitted. This backend defaults to
					// ready and another defaults to draft, so an absent flag
					// means two different things and the same call would
					// produce a different change depending on where it landed.
					draft: draft.draft,
				},
				`proposing ${draft.head} onto ${draft.base}`,
			);
			return proposalFrom(draft.repo, raw);
		},

		async edit(ref: ChangeRef, edit: ProposalEdit): Promise<Proposal> {
			const payload: Record<string, unknown> = {};
			if (edit.title) {
				payload.title = edit.title.action === "clear" ? "" : edit.title.value;
			}
			if (edit.body) {
				payload.body = edit.body.action === "clear" ? "" : edit.body.value;
			}
			if (edit.base) {
				if (edit.base.action === "clear") {
					// A change with no base is not a change. Sending an empty
					// string here would be accepted as a branch named "" and
					// rejected far from the call that caused it.
					throw new Error(
						"A change has to target something, so its base cannot be cleared. Set it to another branch instead.",
					);
				}
				payload.base = edit.base.value;
			}

			const raw = await send(
				"PATCH",
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}`,
				payload,
				`editing pull request ${ref.id}`,
			);
			return proposalFrom(ref.repo, raw);
		},

		async setDraft(ref: ChangeRef, draft: boolean): Promise<void> {
			// Not a field on the pull request. GitHub moves a change
			// between draft and ready only through these two mutations,
			// which is why this is its own method rather than part of edit.
			const id = await nodeId(ref);
			await mutate(
				draft ? CONVERT_TO_DRAFT : MARK_READY,
				id,
				`${draft ? "returning" : "readying"} pull request ${ref.id}`,
			);
		},

		async close(ref: ChangeRef, comment?: string): Promise<void> {
			// The comment goes first. A close that fails afterwards still
			// leaves the reason behind, where the other order leaves a
			// silently shut change nobody can account for.
			if (comment !== undefined && comment.trim() !== "") {
				await send(
					"POST",
					`repos/${slugOf(ref.repo)}/issues/${ref.id}/comments`,
					{ body: comment },
					`saying why pull request ${ref.id} is being closed`,
				);
			}
			await send(
				"PATCH",
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}`,
				{ state: "closed" },
				`closing pull request ${ref.id}`,
			);
		},

		async reopen(ref: ChangeRef): Promise<void> {
			await send(
				"PATCH",
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}`,
				{ state: "open" },
				`reopening pull request ${ref.id}`,
			);
		},

		async merge(ref: ChangeRef, request: MergeRequest): Promise<void> {
			await send(
				"PUT",
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}/merge`,
				{
					// Only when asked. Which merge a repo wants is its settled
					// policy, and choosing one here would rewrite history a way
					// the project did not pick.
					...(request.method === undefined
						? {}
						: { merge_method: request.method }),
					...(request.expectedHead === undefined
						? {}
						: { sha: request.expectedHead }),
				},
				`merging pull request ${ref.id}`,
			);
		},

		async requestReviewers(ref: ChangeRef, actors: string[]): Promise<void> {
			// GitHub accepts an empty request and does nothing with it,
			// which would leave a caller believing it asked somebody.
			if (actors.length === 0) return;
			await send(
				"POST",
				`repos/${slugOf(ref.repo)}/pulls/${ref.id}/requested_reviewers`,
				{ reviewers: actors },
				`requesting reviewers on pull request ${ref.id}`,
			);
		},
	};

	/** The change the API handed back, read the way a fetch reads one. */
	function proposalFrom(repo: RepoLocator, stdout: string): Proposal {
		const raw: unknown = JSON.parse(stdout);
		if (typeof raw !== "object" || raw === null) {
			throw new Error("GitHub answered with something that is not a change.");
		}
		return restProposal(repo, raw as Record<string, unknown>);
	}
}

/** Move a ready change back to draft. */
const CONVERT_TO_DRAFT =
	"mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id } } }";

/** Move a draft change to ready. */
const MARK_READY =
	"mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }";

/** A string, or nothing. */
function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** A nested object, or an empty one. */
function nested(value: Record<string, unknown>, key: string) {
	const held = value[key];
	return typeof held === "object" && held !== null
		? (held as Record<string, unknown>)
		: {};
}

/**
 * One pull request as REST spells it.
 *
 * A local copy rather than the proposals facet's, because that one is
 * private to its module and exporting it would widen a surface only to
 * save a dozen lines. If a third caller appears, that is the moment to
 * move it.
 */
function restProposal(
	repo: RepoLocator,
	raw: Record<string, unknown>,
): Proposal {
	const id = String(raw.number ?? "");
	const state = raw.merged_at
		? "merged"
		: str(raw.state) === "closed"
			? "closed"
			: "open";
	return {
		ref: githubChange(repo, id),
		title: str(raw.title) ?? "",
		body: str(raw.body) ?? "",
		state,
		draft: raw.draft === true,
		author: { id: str(nested(raw, "user").login) ?? "" },
		base: str(nested(raw, "base").ref) ?? "",
		head: str(nested(raw, "head").ref) ?? "",
		...(str(nested(raw, "head").sha)
			? { headCommit: str(nested(raw, "head").sha) }
			: {}),
		...(str(raw.created_at) ? { createdAt: str(raw.created_at) } : {}),
		...(str(raw.updated_at) ? { updatedAt: str(raw.updated_at) } : {}),
		...(str(raw.html_url) ? { url: str(raw.html_url) } : {}),
	};
}
