/**
 * Say who owns a line Joel said into the void, for the void to route.
 *
 * The void runs this with his line, `Attached:` rows and all, on
 * standard input, in the step that writes the line to its day file. It
 * prints each place the line could go, best first, one a line as
 * `<address>\t<quest title>\t<how it matched>`, then a `tried:` line
 * saying what was looked at, which goes to the orchestrator when no
 * place fits. It reads only: open quests' READMEs and, when a pull
 * request is attached, the last two days of mesh messages and the
 * files it touches, asked of Delta through `dt` or of GitHub through
 * `gh` with the sign-ins already on the machine (about a second).
 *
 *   printf '%s' "$LINE" | node scripts/void-owner.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dataDir, stateDir } from "../lib/internal/paths.ts";
import { discoverQuests } from "../lib/internal/quest/discovery.ts";
import { isRecord } from "../lib/internal/record.ts";
import {
	type OpenQuest,
	type Placement,
	type PullRequest,
	placeLine,
} from "../lib/internal/void-owner.ts";

/** The void's own addresses and the orchestrator's, which only pass lines on. */
export const RELAYS: ReadonlySet<string> = new Set([
	"8GYNJ6",
	"E9DE8111",
	"WCJQSG",
]);

const CLOSED = new Set(["concluded", "retired"]);
const DELTA_HOSTS = new Set(["delta.shopify.io", "src.shopify.io"]);
const DELTA_ORIGIN = "https://delta.shopify.io";
const GITHUB_HOST = "github.com";
const FILES_PAGE = "files?per_page=100";
/** Joel waits on the void's answer, so a slow listing is given up on. */
const ASK_TIMEOUT_MS = 10_000;
const DAYS_OF_MESSAGES = 2;
const DAY_MS = 86_400_000;

/** Every open quest under `questsRoot`, as placing a line reads it. */
export function openQuests(questsRoot: string): OpenQuest[] {
	const { index } = discoverQuests(questsRoot);
	return [...index.quests.values()]
		.filter((entry) => !CLOSED.has(entry.doc.frontMatter.status))
		.map((entry) => {
			const fm = entry.doc.frontMatter;
			const repos = (fm.trees ?? []).flatMap((tree) => [
				...(tree.repoRoot ? [basename(tree.repoRoot)] : []),
				...(tree.zones ?? []),
			]);
			return {
				id: fm.id,
				title: entry.doc.title ?? fm.id,
				...(fm.short ? { short: fm.short } : {}),
				...(fm.parent ? { parent: fm.parent } : {}),
				aliases: fm.aliases,
				body: entry.doc.body,
				repos,
			};
		});
}

/**
 * The senders of the mesh messages under `messagesDir` from the last
 * two days whose text holds any of `needles`, one entry a message.
 */
export function sendersIn(
	messagesDir: string,
	needles: readonly string[],
	now = Date.now(),
): string[] {
	const folders = [messagesDir];
	for (let day = 0; day < DAYS_OF_MESSAGES; day += 1) {
		const name = new Date(now - day * DAY_MS).toISOString().slice(0, 10);
		folders.push(join(messagesDir, name));
	}
	const senders: string[] = [];
	for (const folder of folders) {
		if (!existsSync(folder)) continue;
		for (const name of readdirSync(folder)) {
			if (!name.endsWith(".json")) continue;
			const sender = senderIfHolds(join(folder, name), needles);
			if (sender) senders.push(sender);
		}
	}
	return senders;
}

function senderIfHolds(
	path: string,
	needles: readonly string[],
): string | undefined {
	let message: unknown;
	try {
		message = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Moved to its day's folder or half written as it was read.
		return undefined;
	}
	if (!isRecord(message)) return undefined;
	const { text, from } = message;
	if (typeof text !== "string" || typeof from !== "string") return undefined;
	return needles.some((needle) => text.includes(needle)) ? from : undefined;
}

/** Runs a command and gives back what it printed, throwing when it fails. */
export type Run = (command: string, args: readonly string[]) => string;

/**
 * The paths a pull request touches, from the first page of its files,
 * or nothing when its host can't be asked or the asking fails.
 */
export function filesOf(
	pull: PullRequest,
	run: Run = asked,
): string[] | undefined {
	const request = requestFor(pull);
	if (!request) return undefined;
	let listing: unknown;
	try {
		listing = JSON.parse(run(request.command, request.args));
	} catch {
		// Not signed in, timed out, or not a listing: the line is placed
		// without its files rather than held up.
		return undefined;
	}
	if (!Array.isArray(listing)) return undefined;
	return listing.flatMap((file) =>
		isRecord(file) && typeof file.filename === "string" ? [file.filename] : [],
	);
}

function requestFor(
	pull: PullRequest,
): { command: string; args: string[] } | undefined {
	const route = `repos/${pull.repo}/pulls/${pull.number}/${FILES_PAGE}`;
	if (pull.host && DELTA_HOSTS.has(pull.host))
		return {
			command: "dt",
			args: [
				"api",
				"--host",
				DELTA_ORIGIN,
				"-R",
				pull.repo,
				`/api/v3/${route}`,
			],
		};
	if (pull.host === GITHUB_HOST) return { command: "gh", args: ["api", route] };
	return undefined;
}

function asked(command: string, args: readonly string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		timeout: ASK_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/** A placement as the void reads it: a line a place, then what was tried. */
export function printed(placement: Placement): string {
	const lines = placement.candidates.map(
		(c) => `${c.address}\t${c.title}\t${c.how}`,
	);
	lines.push(`tried: ${placement.tried.join("; ") || "nothing was attached"}`);
	return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
	const line = readFileSync(0, "utf8");
	const messagesDir = join(stateDir("mesh-workflow"), "messages");
	const placement = placeLine(line, {
		quests: openQuests(join(dataDir("quest-workflow"), "quests")),
		sendersOf: (needles) => sendersIn(messagesDir, needles),
		filesOf: (pull) => filesOf(pull),
		relays: RELAYS,
	});
	process.stdout.write(printed(placement));
}
