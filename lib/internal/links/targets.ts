/**
 * Where a place opens: the URL handed to the browser or the desktop's
 * default program for it.
 *
 * A URL opens as it is. A path opens as a `file://` URL only when it
 * exists, so a click on a path that was never there opens nothing
 * rather than an error page. GitHub references open on github.com,
 * and a bare `#N` only when the session's repo says which repo it is.
 * A quest id opens its README, and a document id its file.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ownerRepoFromRemote } from "../../core/review/providers/github/claims.ts";
import { gitRules } from "../sandbox.ts";
import { gitRun } from "../tree-git.ts";
import type { Place } from "./places.ts";

/** A GitHub repo, by its owner and name. */
export interface GithubRepo {
	owner: string;
	repo: string;
}

/** What resolving a place needs to know about the machine and session. */
export interface PlaceWorld {
	/** The home folder a `~/` path is under. */
	home: string;
	/** The folder holding a quest folder for each quest id. */
	questsRoot: string;
	/** The session's GitHub repo, when it has one. */
	originRepo(): GithubRepo | undefined;
}

const GITHUB = "https://github.com";

/** Where each kind of document lives in its quest's folder, by id prefix. */
const DOCUMENT_FOLDER: Record<string, string> = {
	PLAN: "plans",
	RSCH: "research",
	BRIF: "briefs",
	RPRT: "reports",
};

/** A line, or a line and column, after a path, as compilers print them. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/** How long asking git for the origin may take before it counts as none. */
const GIT_TIMEOUT_MS = 2_000;

/** The URL a place opens, or nothing when it names nowhere that is there. */
export function targetOf(place: Place, world: PlaceWorld): string | undefined {
	switch (place.kind) {
		case "url":
			return place.text;
		case "github-ref":
			return githubTarget(place.text);
		case "issue-number": {
			const repo = world.originRepo();
			return repo
				? `${GITHUB}/${repo.owner}/${repo.repo}/issues/${place.text.slice(1)}`
				: undefined;
		}
		case "path":
			return pathTarget(place.text, world.home);
		case "quest-id":
			return questTarget(place.text, world.questsRoot);
	}
}

/**
 * The GitHub repo a folder's `origin` remote names, or nothing when
 * the folder is in no repo or its origin is not on GitHub.
 */
export function originRepoOf(cwd: string): GithubRepo | undefined {
	// Outside any sandbox, so held to where a sandboxed command couldn't
	// have set what git runs (tree-git.ts).
	const run = gitRun(cwd, ["remote", "get-url", "origin"], gitRules());
	if ("refused" in run) return;
	const result = spawnSync("git", run.args, {
		cwd,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return;
	return ownerRepoFromRemote(result.stdout.trim()) ?? undefined;
}

function githubTarget(ref: string): string | undefined {
	const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
	return match
		? `${GITHUB}/${match[1]}/${match[2]}/issues/${match[3]}`
		: undefined;
}

function pathTarget(path: string, home: string): string | undefined {
	const full = path.startsWith("~/") ? join(home, path.slice(2)) : path;
	for (const candidate of [full, full.replace(LINE_SUFFIX, "")]) {
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
	}
	return undefined;
}

function questTarget(id: string, questsRoot: string): string | undefined {
	const prefix = id.slice(0, 4);
	if (prefix === "QEST") {
		const readme = join(questsRoot, id, "README.md");
		return existsSync(readme) ? pathToFileURL(readme).href : undefined;
	}
	const folder = DOCUMENT_FOLDER[prefix];
	if (!folder) return undefined;
	const document = documentIn(questsRoot, folder, id);
	return document ? pathToFileURL(document).href : undefined;
}

/**
 * A document's file, found among the quests that could hold it: a
 * document is minted on or after its quest, so only quests of its date
 * or earlier are looked in, the newest first.
 */
function documentIn(
	questsRoot: string,
	folder: string,
	id: string,
): string | undefined {
	const minted = id.slice(5, 13);
	let quests: string[];
	try {
		quests = readdirSync(questsRoot);
	} catch {
		// No quests folder is no document, which is what nothing returns.
		return undefined;
	}
	const candidates = quests
		.filter(
			(quest) => quest.startsWith("QEST-") && quest.slice(5, 13) <= minted,
		)
		.sort()
		.reverse();
	for (const quest of candidates) {
		const document = join(questsRoot, quest, folder, `${id}.md`);
		if (existsSync(document)) return document;
	}
	return undefined;
}
