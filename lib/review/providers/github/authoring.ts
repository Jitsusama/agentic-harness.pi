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
import { type Exec, run } from "../../../exec/index.js";
import type { ChangeRef, Proposal, RepoLocator } from "../../change.js";
import type {
	AuthoringFacet,
	MergeOutcome,
	MergeRequest,
	ProposalDraft,
	ProposalEdit,
	SetEdit,
} from "../../provider.js";
import { githubChange, ownerRepoFromKey } from "./claims.js";
import { labelsAndAssignees } from "./fields.js";

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
		method: "POST" | "PATCH" | "PUT" | "DELETE",
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

	/** One API call with no body, for the routes that take none. */
	async function call(
		method: "DELETE" | "GET",
		route: string,
		what: string,
	): Promise<void> {
		await run(exec, "gh", ["api", "--method", method, route], what);
	}

	/**
	 * Apply a set edit to labels or assignees.
	 *
	 * Both live on the issue rather than the pull request. GitHub models a
	 * pull request as an issue with a branch attached, so `PATCH
	 * /pulls/{n}` takes a title, a body and a base and knows nothing about
	 * labels; the `/issues/{n}` routes own those. The pull request
	 * representation does report them on the way out, which is why reading
	 * costs nothing extra and writing costs a separate call.
	 *
	 * `add` and `remove` are native here, and that is the point of
	 * {@link SetEdit}: doing either through a wholesale replace means
	 * reading the current list and writing it back, which drops whatever
	 * anybody else changed in between.
	 */
	async function applySetEdit(
		ref: ChangeRef,
		field: "labels" | "assignees",
		edit: SetEdit<string>,
	): Promise<void> {
		const issue = `repos/${slugOf(ref.repo)}/issues/${ref.id}`;
		const what = `changing the ${field} of pull request ${ref.id}`;

		if (edit.action === "clear") {
			await send("PATCH", issue, { [field]: [] }, what);
			return;
		}
		if (edit.action === "set") {
			await send("PATCH", issue, { [field]: edit.value }, what);
			return;
		}
		if (edit.value.length === 0) return;
		if (edit.action === "add") {
			await send("POST", `${issue}/${field}`, { [field]: edit.value }, what);
			return;
		}
		// Removing differs between the two, which is GitHub's asymmetry
		// rather than a choice here: a label is named in the path, one call
		// each, and assignees come off together in a body.
		if (field === "assignees") {
			await send(
				"DELETE",
				`${issue}/assignees`,
				{ assignees: edit.value },
				what,
			);
			return;
		}
		for (const label of edit.value) {
			await call(
				"DELETE",
				`${issue}/labels/${encodeURIComponent(label)}`,
				what,
			);
		}
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
			const proposed = proposalFrom(draft.repo, raw);

			// A second call, because the create route does not take them: a
			// pull request is an issue with a branch, and labels belong to
			// the issue half. Sent after the change exists rather than not
			// at all, since a caller who asked for a label and silently did
			// not get one has no way to tell.
			if (draft.labels?.length) {
				await applySetEdit(proposed.ref, "labels", {
					action: "add",
					value: draft.labels,
				});
			}
			if (draft.assignees?.length) {
				await applySetEdit(proposed.ref, "assignees", {
					action: "add",
					value: draft.assignees,
				});
			}
			return proposed;
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

			if (edit.labels) await applySetEdit(ref, "labels", edit.labels);
			if (edit.assignees) await applySetEdit(ref, "assignees", edit.assignees);

			// Read the change back rather than PATCHing nothing, for an edit
			// that only touched labels. Sending an empty body here is
			// accepted and returns the change unchanged, so this is about
			// saying what happened rather than about correctness.
			const route = `repos/${slugOf(ref.repo)}/pulls/${ref.id}`;
			const raw =
				Object.keys(payload).length === 0
					? await run(
							exec,
							"gh",
							["api", route],
							`reading pull request ${ref.id} back`,
						)
					: await send(
							"PATCH",
							route,
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

		async merge(ref: ChangeRef, request: MergeRequest): Promise<MergeOutcome> {
			const answered = await send(
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
			// This endpoint lands the change then and there, so `merged` is the
			// honest word for it. A repo fronted by GitHub's own merge queue does
			// not merge through here at all, which is why there is no second case.
			//
			// The sha is passed on when the answer carries one and left out when
			// it does not, rather than being defaulted to the head we sent: absent
			// means unreported, and a commit is the one field a caller might go
			// and look up.
			const commit = shaFrom(answered);
			return { kind: "merged", ...(commit === undefined ? {} : { commit }) };
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

/** The commit a merge answer names, when it names one and the text parses. */
function shaFrom(answered: string): string | undefined {
	try {
		const body: unknown = JSON.parse(answered);
		if (typeof body !== "object" || body === null) return undefined;
		return str((body as Record<string, unknown>).sha);
	} catch {
		// The merge went through; only the sha is unreadable. Failing the call
		// over that would turn a landed change into a reported error, which is
		// the one outcome worse than not naming the commit.
		return undefined;
	}
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
		...labelsAndAssignees(raw),
	};
}
