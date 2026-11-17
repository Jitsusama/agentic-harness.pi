/**
 * Why a quest made with no parent can't be made from where this session
 * stands, when it can't.
 *
 * A session whose quest sits in an orchestration, under one or heading
 * one, works for that orchestrator. A quest it makes at the top answers
 * to no orchestrator, and the sessions on it join no orchestration's
 * group, so nobody hears from them; on 15 November a Mac cell was left
 * unattached that way. So a create with no parent there is refused,
 * naming the parents it could use, rather than made at the top unsaid.
 * A quest that truly belongs at the top is made under one and moved
 * with `reparent`, a step nobody takes by leaving a field out.
 */

import { orchestrationOf } from "../../../lib/internal/quest/fields/orchestration.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";

/**
 * The refusal for a parentless quest made by a session on `loaded`,
 * given a way to read any quest's front matter; undefined when the
 * session is in no orchestration or has no quest loaded.
 */
export function parentlessRefusal(
	loaded: string | null | undefined,
	read: (quest: string) => QuestFrontMatter | undefined,
): string | undefined {
	if (!loaded) return undefined;
	const { by, heads } = orchestrationOf(loaded, read);
	const orchestrator = by ?? heads;
	if (!orchestrator) return undefined;
	const direct =
		by !== undefined
			? `, or parent "${by}" to make it answer to the orchestrator's quest directly`
			: "";
	return `This session's quest ${loaded} is in ${orchestrator}'s orchestration, so a quest made with no parent would answer to no orchestrator, and its sessions would join no orchestration's group. Pass parent "${loaded}" to make it under this quest${direct}. One that truly belongs at the top is made under one of them, then moved with \`quest reparent\` to \`null\`.`;
}
