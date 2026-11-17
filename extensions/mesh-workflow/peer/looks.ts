/**
 * The person's looks: asking their hosts what became of the changes they
 * point at, and resolving those whose change or quest has ended.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveReference } from "../../../lib/core/review/index.ts";
import {
	heldBy,
	type Look,
	type LookResolution,
	looksDue,
	looksIn,
	looksListed,
	type Pointer,
	resolveLooks,
	resolveLooksOfQuests,
} from "../../../lib/mesh/looks.ts";
import {
	ASK_EVERY_MS,
	askable,
	markResolved,
	queryFor,
	resolutionsFrom,
	takeTurnToAsk,
} from "../../../lib/mesh/looks-github.ts";
import {
	askableElsewhere,
	type HostedState,
	resolutionsElsewhere,
} from "../../../lib/mesh/looks-hosted.ts";
import { expiredText, keepLooks } from "../looks-clock.ts";

/** How often a session looks whether it's its turn to ask GitHub about looks. */
export const LOOKS_CHECK_MS = 60_000;

/** How long one ask of GitHub about looks may take. */
const LOOKS_ASK_TIMEOUT_MS = 30_000;

/**
 * Ask the hosts of the changes the person's waiting looks point at about
 * them, when it's this session's turn, and mark what merged, closed or
 * got their review resolved: GitHub in one query, and every other host
 * through the review provider that claims the look's URL. A host that
 * can't be asked now leaves its looks waiting for the next turn.
 */
export async function askAboutLooks(
	pi: Pick<ExtensionAPI, "exec">,
	dir: string,
	session: string,
	listed?: readonly Look[],
): Promise<void> {
	try {
		const looks = listed ?? looksIn(dir);
		const now = Date.now();
		const asked = askable(looks);
		const elsewhere = askableElsewhere(looks, Math.floor(now / ASK_EVERY_MS));
		if (asked.length === 0 && elsewhere.length === 0) return;
		if (!takeTurnToAsk(dir, session, now)) return;
		await Promise.all([
			askGitHubAboutLooks(pi, dir, asked),
			askHostsAboutLooks(dir, elsewhere),
		]);
	} catch {
		// The looks unreadable now: asked again next turn.
	}
}

/** Ask GitHub, in one query, about the looks at its pull requests. */
async function askGitHubAboutLooks(
	pi: Pick<ExtensionAPI, "exec">,
	dir: string,
	asked: ReturnType<typeof askable>,
): Promise<void> {
	if (asked.length === 0) return;
	try {
		const ran = await pi.exec(
			"gh",
			[
				"api",
				"graphql",
				"-f",
				`query=${queryFor(asked.map((one) => one.pull))}`,
			],
			{ timeout: LOOKS_ASK_TIMEOUT_MS },
		);
		// Not on its exit: one pull request GitHub can't find (deleted, or
		// a repo now private) makes gh exit 1 with the others' answers still
		// in its data, as a live ask on 8 November showed.
		if (ran.stdout.trim() === "") return;
		markResolved(dir, resolutionsFrom(asked, JSON.parse(ran.stdout)));
	} catch {
		// GitHub unreachable or its answer unreadable: asked again next turn.
	}
}

/** Ask each other host, through its review provider, about the looks at its changes. */
async function askHostsAboutLooks(
	dir: string,
	asked: ReturnType<typeof askableElsewhere>,
): Promise<void> {
	if (asked.length === 0) return;
	try {
		markResolved(dir, await resolutionsElsewhere(asked, hostedStateOf));
	} catch {
		// The looks unwritable now: asked again next turn.
	}
}

/**
 * Where a change stands on the host whose review provider claims its
 * URL, or none when no provider claims it. A host slower than
 * {@link LOOKS_ASK_TIMEOUT_MS} counts as unanswered.
 */
async function hostedStateOf(change: string): Promise<HostedState | undefined> {
	const found = resolveReference(change);
	if (!found.resolved || !found.provider.changes) return undefined;
	const fetched = found.provider.changes.fetch(found.change);
	const late = new Promise<undefined>((settle) => {
		setTimeout(() => settle(undefined), LOOKS_ASK_TIMEOUT_MS).unref();
	});
	return (await Promise.race([fetched, late]))?.state;
}

/** What the agent reads when looks of its own expired off the person's list. */
const LOOKS_EXPIRED = "mesh-looks-expired";

/**
 * Tell the agent, with its next turn, which of its looks expired off the
 * person's list, so it doesn't count on him having seen them.
 */
export function tellLooksExpired(
	pi: Pick<ExtensionAPI, "sendMessage">,
	expired: Parameters<typeof expiredText>[0],
): void {
	const content = expiredText(expired);
	if (content === undefined) return;
	pi.sendMessage(
		{ customType: LOOKS_EXPIRED, content, display: true },
		{ triggerTurn: false },
	);
}

/**
 * One tick of the looks clock for `owner`, a session and its quest: the
 * looks of ended quests resolve, their hosts are asked about the
 * changes the rest point at, and what was seen or is past its time
 * leaves, the agent told what expired. The list is read once off the
 * thread, since a host runs every conversation's clock on one, and a
 * step reads it again, at once, only when it has something to write,
 * so it never writes over what another session changed meanwhile.
 * Whether a look's quest ended is still read on the thread: a stat of
 * its README each tick, kept parsed while it stands.
 */
export async function keepLooksFor(
	pi: Pick<ExtensionAPI, "exec" | "sendMessage">,
	dir: string,
	owner: Pointer,
	ended: (quest: string) => boolean,
): Promise<void> {
	const looks = await looksListed(dir);
	const due = looksDue(looks, (look) => heldBy(look, owner), ended);
	if (due.ended) endLooksOfQuests(dir, ended);
	// What ended quests left is read again rather than asked about.
	void askAboutLooks(pi, dir, owner.session, due.ended ? undefined : looks);
	if (due.seen || due.expired) tellLooksExpired(pi, keepLooks(dir, owner));
}

/**
 * Mark the person's standing looks for a quest that `ended` says has
 * ended resolved, so nothing it asked of him outlives it (Joel, 11
 * November: "if it is no longer applicable ... it should disappear").
 * A look list that can't be written now is tried again on the next tick.
 */
export function endLooksOfQuests(
	dir: string | undefined,
	ended: (quest: string) => boolean,
): void {
	if (!dir) return;
	try {
		resolveLooksOfQuests(dir, ended);
	} catch {
		// The looks stay waiting until the next tick.
	}
}

/**
 * Mark the person's looks at a change that merged or closed resolved, so
 * nothing asks them to look at what no longer needs them (Joel, 8
 * November). A look list that can't be written now keeps them waiting.
 */
export function resolveLooksAt(
	dir: string | undefined,
	url: string,
	how: LookResolution,
): void {
	if (!dir) return;
	try {
		resolveLooks(dir, url, how);
	} catch {
		// The looks stay waiting, for the person to clear by hand.
	}
}
