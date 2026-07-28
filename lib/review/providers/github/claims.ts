/**
 * What GitHub recognizes as one of its own.
 *
 * Pure pattern matching, deliberately separate from anything
 * that runs a command, because claiming happens on every
 * resolution and must stay cheap. The Graphite URL is included
 * because it is a different view onto the same pull request,
 * not a different backend.
 */

import type { ChangeRef, RepoLocator } from "../../change.js";
import type { RepoProbe } from "../../provider.js";

/** Provider id, used as the prefix of every repo key it mints. */
export const GITHUB_PROVIDER_ID = "github";

const PULL_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const GRAPHITE_URL =
	/^https?:\/\/app\.graphite\.com\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/;
const SHORT_FORM = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/;
const BARE_NUMBER = /^#?(\d+)$/;

const HTTPS_REMOTE =
	/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const SSH_REMOTE = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/;

/** The repo key GitHub uses: `github:owner/repo`. */
export function githubRepoKey(owner: string, repo: string): string {
	return `${GITHUB_PROVIDER_ID}:${owner}/${repo}`;
}

/** Owner and repo from a GitHub remote URL, if it is one. */
export function ownerRepoFromRemote(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	const https = HTTPS_REMOTE.exec(remoteUrl);
	if (https) return { owner: https[1], repo: https[2] };
	const ssh = SSH_REMOTE.exec(remoteUrl);
	if (ssh) return { owner: ssh[1], repo: ssh[2] };
	return null;
}

/** Owner and repo from a repo key this provider minted. */
export function ownerRepoFromKey(
	key: string,
): { owner: string; repo: string } | null {
	const prefix = `${GITHUB_PROVIDER_ID}:`;
	if (!key.startsWith(prefix)) return null;
	const [owner, repo] = key.slice(prefix.length).split("/");
	return owner && repo ? { owner, repo } : null;
}

function change(owner: string, repo: string, number: string): ChangeRef {
	return {
		provider: GITHUB_PROVIDER_ID,
		repo: { key: githubRepoKey(owner, repo) },
		id: number,
	};
}

/**
 * Recognize a reference. A bare number needs a repo to belong
 * to, and only counts when that repo is one of GitHub's: a
 * number typed while standing in a gitstream checkout is not a
 * GitHub pull request.
 */
export function claimGitHubReference(
	input: string,
	repo?: RepoLocator,
): ChangeRef | null {
	const trimmed = input.trim();

	const pull = PULL_URL.exec(trimmed);
	if (pull) return change(pull[1], pull[2], pull[3]);

	const graphite = GRAPHITE_URL.exec(trimmed);
	if (graphite) return change(graphite[1], graphite[2], graphite[3]);

	const short = SHORT_FORM.exec(trimmed);
	if (short) return change(short[1], short[2], short[3]);

	const bare = BARE_NUMBER.exec(trimmed);
	if (!bare || !repo) return null;
	const owned = ownerRepoFromKey(repo.key);
	return owned ? change(owned.owner, owned.repo, bare[1]) : null;
}

/** Recognize a checkout by its remotes. */
export function claimGitHubRepo(probe: RepoProbe): RepoLocator | null {
	for (const remoteUrl of probe.remoteUrls ?? []) {
		const owned = ownerRepoFromRemote(remoteUrl);
		if (!owned) continue;
		return {
			key: githubRepoKey(owned.owner, owned.repo),
			remoteUrl,
			...(probe.repoRoot ? { localPath: probe.repoRoot } : {}),
		};
	}
	return null;
}
