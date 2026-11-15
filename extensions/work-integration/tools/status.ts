/**
 * What has changed inside a held tree, and which branch or commit it is
 * on.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { citeListing } from "../../../lib/core/result/listing.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import type { WorkHistory } from "../../../lib/core/work/history.ts";
import { GLYPH } from "../render.ts";
import { type Answer, say } from "./shared.ts";

/** Say whether a tree is clean, or list what changed in it. */
export async function statusOf(
	history: WorkHistory,
	found: HeldTree,
	ctx: ExtensionContext,
): Promise<Answer> {
	const state = await history.status(found.path);
	const head = await history.head(found.path);
	const at = head.branch
		? `on ${head.branch}`
		: `detached at ${head.commit.slice(0, 12)}`;
	if (state.changed.length === 0) {
		return say(`${GLYPH.clean} ${found.identity.key} is clean, ${at}.`, {
			ok: true,
			clean: true,
		});
	}
	const lines = state.changed.map((c) => `   ${c.kind} ${c.path}`);
	return say(
		citeListing(openSessionStore(ctx), {
			view: `${GLYPH.dirty} ${found.identity.key} has ${state.changed.length} changed paths, ${at}.\n${lines.join("\n")}`,
			records: [...state.changed],
			unit: "paths",
			narrowing: "Query the stored result for the paths you need.",
		}),
		{ ok: true, clean: false, changed: state.changed.length },
	);
}
