/**
 * Authoring in a held tree: recording a commit, held to the same prose
 * gate and commit format a shell commit meets, and making a branch from
 * where a remote holds it now.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Exec, spawnExec } from "../../../lib/core/exec/index.ts";
import { complaintsAbout } from "../../../lib/core/internal/guardian/commit-format.ts";
import { runProseGate } from "../../../lib/core/internal/guardian/prose-gate.ts";
import {
	createGitAuthor,
	namingComplaints,
} from "../../../lib/core/work/author.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import {
	FETCH_MS,
	FETCHED_LATELY_MS,
	refreshStart,
} from "../../../lib/core/work/fresh-start.ts";
import type { WorkHistory } from "../../../lib/core/work/history.ts";
import { sessionGateDeps } from "../../../lib/internal/gate/session-deps.ts";
import { count } from "../../../lib/ui/count.ts";
import { GLYPH } from "../render.ts";
import { recordMessage } from "./message.ts";
import { type Answer, refuse, say } from "./shared.ts";
import { sweepObjection } from "./sweep.ts";

/** What a commit is asked to say, and which paths it takes. */
export interface RecordAsk {
	subject?: string;
	body?: string;
	paths?: string[];
}

/** Stage and commit the work in a tree, once its message passes. */
export async function record(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	exec: Exec,
	history: WorkHistory,
	found: HeldTree,
	asked: RecordAsk,
): Promise<Answer> {
	if (!asked.subject) {
		return refuse(
			`${GLYPH.refused} Say what the commit is for, as a subject. Conventional form: type(scope): subject.`,
		);
	}
	// The same prose gate a commit typed into a shell meets. That one is
	// reached by intercepting the command, and this path never runs a
	// command: it commits through the exec seam directly, so it arrived
	// behind the guardian rather than in front of it. A convention
	// enforced on one road into the same repository and not the other is
	// not enforced, it is just inconvenient in one place.
	//
	// Only the gate is shared, not the review panel. Approving a message
	// is what a human does to a command they did not write; here the
	// subject and body are arguments in a tool call they can already see.
	//
	// The body is wrapped to 72 before either gate reads it, so a line
	// that is merely too wide is fixed rather than refused.
	const message = recordMessage(asked.subject, asked.body);
	const proposed = message.proposed;
	// A guardian result may also ask for a rewrite, which is a shell
	// concept: there is no command here to substitute. Narrowed by asking
	// what the value has rather than asserting what it is, so a third arm
	// added later is a type error here instead of a silent skip.
	const objection = runProseGate(sessionGateDeps(ctx, pi), proposed);
	if (objection !== undefined && "block" in objection) {
		return refuse(`${GLYPH.refused} ${objection.reason}`);
	}

	// The shape rules the guardian holds a shell commit to. It
	// shows them as warnings beside a panel and lets the person
	// decide, which works because somebody is looking. Nobody is
	// looking here, so the same rules have to refuse: a warning
	// returned after the commit has landed is a note about
	// history, and rewriting history is the expensive way to fix
	// a subject nobody had to accept in the first place.
	const shape = complaintsAbout(proposed);
	if (shape.length > 0) {
		return refuse(
			`${GLYPH.refused} That message does not meet the commit format: ${shape.join("; ")}.`,
		);
	}

	const author = createGitAuthor({ exec });
	const before = await history.status(found.path);
	if (before.changed.length === 0) {
		// Committing nothing succeeds at the git level and
		// leaves the caller believing work was recorded.
		return refuse(
			`${GLYPH.clean} Nothing to record in ${found.identity.key}: the tree is clean.`,
		);
	}
	const paths = asked.paths && asked.paths.length > 0 ? asked.paths : undefined;
	// Only a sweep is checked: naming paths says what is meant.
	const swept = paths ? undefined : sweepObjection(before.changed);
	if (swept !== undefined) {
		return refuse(`${GLYPH.refused} ${swept}`);
	}
	await author.stage(found.path, paths);
	await author.commit(found.path, {
		subject: asked.subject,
		...(message.body ? { body: message.body } : {}),
	});
	const head = await history.head(found.path);
	// What the commit holds, not what was changed before it: with paths
	// named, the rest stays uncommitted and was counted as recorded.
	const recorded = paths
		? before.changed.length - (await history.status(found.path)).changed.length
		: before.changed.length;
	const rewrapped = message.wrapped
		? " The body ran past 72 columns, so it was wrapped to fit."
		: "";
	return say(
		`${GLYPH.clean} Recorded ${count(recorded, "path")} in ${found.identity.key} at ${head.commit.slice(0, 12)}.${rewrapped}`,
		{
			ok: true,
			commit: head.commit,
			recorded,
		},
	);
}

/** Make a branch in a tree and check it out, naming where it starts. */
export async function makeBranch(
	exec: Exec,
	history: WorkHistory,
	found: HeldTree,
	asked: { name?: string; from?: string },
	signal: AbortSignal | undefined,
): Promise<Answer> {
	const { name, from } = asked;
	if (!name) {
		return refuse(`${GLYPH.refused} Name the branch to make.`);
	}
	const author = createGitAuthor({ exec });
	// A remote's branch is wanted as the remote holds it, not as the
	// last fetch left it; on a shorter clock than the call's, since
	// the branch can still be made from what is here. New work takes
	// a start a fetch moved lately as it stands (fresh-start.ts).
	const fresh = from
		? await refreshStart(
				spawnExec({
					...(signal ? { signal } : {}),
					timeoutMs: FETCH_MS,
				}),
				found.path,
				from,
				signal,
				{ fetchedWithin: FETCHED_LATELY_MS },
			)
		: undefined;
	const stale = fresh?.stale;
	const lately = fresh?.lately;
	try {
		await author.branch(
			found.path,
			name,
			fresh ? { from: fresh.start } : undefined,
		);
	} catch (error) {
		// A start point never fetched before has nothing to fall back
		// on, and git's "not a commit" alone hides that the fetch is
		// what went wrong.
		if (!stale) throw error;
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n${stale}`,
		);
	}
	// Named, so a branch cut from the wrong base shows at once
	// rather than after the work on it is built. A head that cannot
	// be read now is left out rather than reported as a failure,
	// since the branch exists and a retry would be refused for it.
	const commit = await history
		.head(found.path)
		.then((head) => head.commit)
		.catch(() => undefined);
	const where = `${commit ? `, at ${commit.slice(0, 12)}` : ""}${from ? ` from ${from}` : ""}`;
	// Said after the branch exists, because the name is workable
	// and the convention is a preference rather than a rule git
	// enforces. Refusing here would make a repo with its own
	// habits unusable through the tool.
	const naming = namingComplaints(name);
	return say(
		[
			`${GLYPH.tree} ${found.identity.key} is on ${name}${where}.`,
			...(stale ? [`   ${stale}`] : []),
			...(lately ? [`   ${lately}`] : []),
			...(naming.length === 0
				? []
				: [`   Against the convention: ${naming.join("; ")}.`]),
		].join("\n"),
		{
			ok: true,
			branch: name,
			...(commit ? { commit } : {}),
			...(from ? { fresh: stale === undefined && lately === undefined } : {}),
		},
	);
}
