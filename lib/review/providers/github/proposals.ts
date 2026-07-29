/**
 * Reading changes from GitHub.
 *
 * GitHub says a merged pull request is `closed` with a
 * `merged_at` timestamp, and calls a draft a state in one API
 * and a flag in another. The neutral model says merged is its
 * own state and draft is a flag, so the translation happens
 * here, once, rather than in every caller that has to decide
 * what `closed` meant.
 */

import type { ChangeState, Proposal, RepoLocator } from "../../change.js";
import type { Check, CheckState, ChecksRollup } from "../../checks.js";
import type { ChangeFilter, ProposalsFacet } from "../../provider.js";
import type { Exec } from "../exec.js";
import { run } from "../exec.js";
import { GHOST, githubChange, ownerRepoFromKey } from "./claims.js";

/** Where a materialized change lands, so it is easy to spot. */
const LOCAL_REF_PREFIX = "refs/pi-review/github";

/** The `owner/repo` a ref belongs to, or a clear failure. */
function slugOf(repo: RepoLocator): string {
	const owned = ownerRepoFromKey(repo.key);
	if (!owned) {
		throw new Error(`${repo.key} is not a GitHub repo key`);
	}
	return `${owned.owner}/${owned.repo}`;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error(`GitHub returned no ${what}`);
	}
	return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function nested(value: unknown, key: string): Record<string, unknown> {
	const record = asRecord(value, "object");
	const inner = record[key];
	return typeof inner === "object" && inner !== null
		? (inner as Record<string, unknown>)
		: {};
}

function num(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/** Who acted, or the ghost GitHub attributes orphaned work to. */
function actorFrom(login: unknown): { id: string } {
	return { id: str(login) ?? GHOST };
}

/**
 * How big the change is, from whichever of GitHub's spellings
 * answered: REST says `changed_files`, GraphQL and the CLI say
 * `changedFiles`.
 *
 * Each field is carried only when it is actually there. An
 * unreported count and a count of zero are different facts, and a
 * reader shown "0 files changed" would believe the wrong one.
 */
function sizeOf(raw: Record<string, unknown>): {
	additions?: number;
	deletions?: number;
	changedFiles?: number;
} {
	const additions = num(raw.additions);
	const deletions = num(raw.deletions);
	const changedFiles = num(raw.changedFiles) ?? num(raw.changed_files);
	return {
		...(additions !== undefined ? { additions } : {}),
		...(deletions !== undefined ? { deletions } : {}),
		...(changedFiles !== undefined ? { changedFiles } : {}),
	};
}

/**
 * GitHub's state plus its merge timestamp, as one state. A
 * closed pull request that merged is merged; one that did not
 * is closed.
 */
function stateOf(raw: Record<string, unknown>): ChangeState {
	if (str(raw.merged_at)) return "merged";
	const state = (str(raw.state) ?? "open").toLowerCase();
	if (state === "merged") return "merged";
	return state === "closed" ? "closed" : "open";
}

/** One pull request from the REST representation. */
function proposalFromRest(
	repo: RepoLocator,
	raw: Record<string, unknown>,
): Proposal {
	const id = String(raw.number ?? "");
	return {
		ref: githubChange(repo, id),
		title: str(raw.title) ?? "",
		body: str(raw.body) ?? "",
		state: stateOf(raw),
		draft: raw.draft === true,
		author: actorFrom(nested(raw, "user").login),
		base: str(nested(raw, "base").ref) ?? "",
		head: str(nested(raw, "head").ref) ?? "",
		...(str(nested(raw, "head").sha)
			? { headCommit: str(nested(raw, "head").sha) }
			: {}),
		...(str(raw.created_at) ? { createdAt: str(raw.created_at) } : {}),
		...(str(raw.updated_at) ? { updatedAt: str(raw.updated_at) } : {}),
		...(str(raw.html_url) ? { url: str(raw.html_url) } : {}),
		...sizeOf(raw),
	};
}

/**
 * One pull request from `gh pr list --json`, which is neither
 * REST nor GraphQL but a third spelling of the same thing.
 */
function proposalFromListing(
	repo: RepoLocator,
	raw: Record<string, unknown>,
): Proposal {
	const id = String(raw.number ?? "");
	const state = (str(raw.state) ?? "OPEN").toLowerCase();
	return {
		ref: githubChange(repo, id),
		title: str(raw.title) ?? "",
		body: str(raw.body) ?? "",
		state:
			state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
		draft: raw.isDraft === true,
		author: actorFrom(nested(raw, "author").login),
		base: str(raw.baseRefName) ?? "",
		head: str(raw.headRefName) ?? "",
		...(str(raw.url) ? { url: str(raw.url) } : {}),
		...sizeOf(raw),
	};
}

/** One check's state, from either of GitHub's two shapes. */
function checkStateOf(raw: Record<string, unknown>): CheckState {
	// Check runs report status plus conclusion; legacy statuses
	// report a single state.
	const status = (str(raw.status) ?? "").toUpperCase();
	const conclusion = (str(raw.conclusion) ?? "").toUpperCase();
	const legacy = (str(raw.state) ?? "").toUpperCase();

	if (status && status !== "COMPLETED") return "pending";
	const outcome = conclusion || legacy;
	if (!outcome) return "unreported";
	if (["SUCCESS", "NEUTRAL"].includes(outcome)) return "passing";
	if (["SKIPPED"].includes(outcome)) return "skipped";
	if (["PENDING", "EXPECTED", "QUEUED"].includes(outcome)) return "pending";
	return "failing";
}

/** Roll checks up, keeping unreported apart from failing. */
function rollUp(checks: Check[]): CheckState {
	if (checks.length === 0) return "unreported";
	if (checks.some((check) => check.state === "failing")) return "failing";
	if (checks.some((check) => check.state === "pending")) return "pending";
	if (checks.some((check) => check.state === "unreported")) return "pending";
	return "passing";
}

/** Build the proposals facet. */
export function githubProposals(exec: Exec): ProposalsFacet {
	async function json<T>(args: string[], what: string): Promise<T> {
		const stdout = await run(exec, "gh", args, what);
		return JSON.parse(stdout) as T;
	}

	return {
		async fetch(ref) {
			const raw = await json<unknown>(
				["api", `repos/${slugOf(ref.repo)}/pulls/${ref.id}`],
				`reading pull request ${ref.id}`,
			);
			return proposalFromRest(ref.repo, asRecord(raw, "pull request"));
		},

		async diff(ref) {
			return run(
				exec,
				"gh",
				["pr", "diff", ref.id, "--repo", slugOf(ref.repo)],
				`reading the diff of pull request ${ref.id}`,
			);
		},

		async checks(ref): Promise<ChecksRollup> {
			const raw = await json<unknown>(
				[
					"pr",
					"view",
					ref.id,
					"--repo",
					slugOf(ref.repo),
					"--json",
					"statusCheckRollup",
				],
				`reading checks on pull request ${ref.id}`,
			);
			const rollup = asRecord(raw, "checks").statusCheckRollup;
			const entries = Array.isArray(rollup) ? rollup : [];
			const checks = entries.map((entry) => {
				const record = asRecord(entry, "check");
				const name = str(record.name) ?? str(record.context) ?? "unnamed check";
				const url = str(record.detailsUrl) ?? str(record.targetUrl);
				return {
					name,
					state: checkStateOf(record),
					...(url ? { url } : {}),
				};
			});
			return { state: rollUp(checks), checks };
		},

		async list(repo: RepoLocator, filter: ChangeFilter) {
			const args = ["pr", "list", "--repo", slugOf(repo), "--json"];
			args.push(
				"number,title,body,state,isDraft,author,baseRefName,headRefName,url," +
					// Free in the same call, and a listing is exactly where
					// knowing which change is the big one earns its keep.
					"additions,deletions,changedFiles",
			);
			if (filter.state) args.push("--state", filter.state);
			if (filter.author) args.push("--author", filter.author);
			if (filter.base) args.push("--base", filter.base);
			if (filter.head) args.push("--head", filter.head);
			if (filter.limit !== undefined)
				args.push("--limit", String(filter.limit));
			const raw = await json<unknown>(args, "listing pull requests");
			const entries = Array.isArray(raw) ? raw : [];
			return entries.map((entry) =>
				proposalFromListing(repo, asRecord(entry, "pull request")),
			);
		},

		async fetchAsRef(ref, repoRoot) {
			const local = `${LOCAL_REF_PREFIX}/${ref.id}`;
			const remote = ref.repo.remoteUrl ?? "origin";
			await run(
				exec,
				"git",
				[
					"-C",
					repoRoot,
					"fetch",
					"--force",
					remote,
					`pull/${ref.id}/head:${local}`,
				],
				`fetching pull request ${ref.id}`,
			);
			return local;
		},
	};
}
