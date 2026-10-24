/**
 * The gate before a session ends another session's hold on the
 * person's word.
 *
 * Only a hold's sender ends it otherwise, and that is right while the
 * sender is there to: it knows when what it held off is safe again.
 * But when the person says a hold is over, as after a reboot they
 * watched finish, no other session could say so for them, and every
 * peer parked on it stayed parked. The agent claims the person's word,
 * so the person confirms it here; the `mesh-end-hold` guard blocks by
 * default, holds the call while they are away, and refuses it where
 * there is nobody to ask.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalUnder, fenced } from "../../lib/guardian/index.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import { clock, type Message, shortId } from "../../lib/mesh/message.ts";
import {
	frameTitle,
	type KeyAction,
	promptSingle,
	renderMarkdown,
} from "../../lib/ui/index.ts";

const REJECT: KeyAction[] = [{ key: "r", label: "Reject" }];

/** Why it may not be sent, or nothing once the person has said it may. */
export async function confirmEnd(
	ctx: ExtensionContext | undefined,
	hold: Message,
	text: string,
	waiting: readonly string[],
): Promise<string | undefined> {
	const title = "End Mesh Hold";
	const body = [
		`${hold.from}'s hold [${shortId(hold)}], sent at ${clock(hold)}:`,
		"",
		hold.text,
		"",
		waiting.length > 0
			? `It ends for ${waiting.join(", ")}, waiting on it, and for whoever else it reached.`
			: "It ends for whoever it reached.",
		"",
		`What they are told: ${text}`,
	].join("\n");
	const approval = approvalUnder(GUARDS.meshEndHold.name, title, () =>
		fenced(body),
	);
	if (approval.kind === "go") return undefined;
	if (approval.kind === "held") return approval.reason;
	if (!ctx?.hasUI) {
		return `only ${hold.from} may end [${shortId(hold)}] unless the person confirms it, and this session has nobody to ask. Ask ${hold.from} to answer its hold instead.`;
	}
	const result = await promptSingle(ctx, {
		want: { kind: "approval", said: `End ${hold.from}'s mesh hold` },
		content: (theme, width) => [
			` ${frameTitle(theme, title)}`,
			"",
			...renderMarkdown(body, theme, width),
		],
		actions: REJECT,
	});
	if (!result) return "the person closed the gate without ending the hold.";
	if (result.note) return `the person said: ${result.note}`;
	if (result.type === "action" && result.key === "r") {
		return "the person did not end the hold. Ask them what to do instead.";
	}
	return undefined;
}
