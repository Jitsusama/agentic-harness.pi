/**
 * Publishing a held tree's branch, once whoever hosts it has said whether
 * it may go, and saying a push with nothing new as that rather than as a
 * publish.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Exec } from "../../../lib/core/exec/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import type { WorkHistory } from "../../../lib/core/work/history.ts";
import { cautionsFrom, refusalFrom } from "../../../lib/core/work/objection.ts";
import { createGitPublisher } from "../../../lib/core/work/publish.ts";
import { objectionsTo } from "../broker.ts";
import { GLYPH } from "../render.ts";
import { type Answer, refuse, say } from "./shared.ts";

/** Push a tree's branch, replacing what the remote has when asked. */
export async function publish(
	pi: ExtensionAPI,
	exec: Exec,
	history: WorkHistory,
	found: HeldTree,
	replace: boolean | undefined,
): Promise<Answer> {
	// Ask before publishing, because the reason not to is often a
	// fact this layer cannot see. On a backend with a merge queue,
	// pushing to an enqueued branch ejects it and everything batched
	// with it, and that is knowledge the hosting layer holds.
	const head = await history.head(found.path);
	let cautions: readonly string[] = [];
	if (head.branch !== undefined) {
		const objected = await objectionsTo(pi, {
			repoKey: found.identity.key,
			branch: head.branch,
			treePath: found.path,
			replacing: replace === true,
		});
		const blocked = refusalFrom(objected);
		if (blocked !== undefined) {
			return refuse(`${GLYPH.refused} ${blocked}`);
		}
		// Kept for after the push. A caution decorates what
		// happened rather than becoming what happened.
		cautions = cautionsFrom(objected);
	}
	const publisher = createGitPublisher({ exec });
	const outcome = await publisher.push(
		found.path,
		replace ? { replace: true } : undefined,
	);
	if (outcome.kind === "refused") {
		return refuse(`${GLYPH.refused} ${outcome.reason}`);
	}
	if (outcome.kind === "already-there") {
		// Said rather than dressed as a push, because "published"
		// about a no-op is how somebody concludes their commit went
		// up when it did not.
		return say(
			`${GLYPH.clean} ${outcome.remote}/${outcome.branch} already has this. Nothing to publish.`,
			{ ok: true, branch: outcome.branch, published: false },
		);
	}
	const notes = [
		outcome.tracked ? "tracking it from now on" : undefined,
		outcome.replaced ? "replacing what was there" : undefined,
	].filter((note) => note !== undefined);
	return say(
		[
			`${GLYPH.tree} ${outcome.branch} published to ${outcome.remote}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}.`,
			...cautions.map((caution) => `   ${GLYPH.dirty} ${caution}`),
		].join("\n"),
		{
			ok: true,
			branch: outcome.branch,
			published: true,
			...(cautions.length > 0 ? { cautions } : {}),
		},
	);
}
