/**
 * How the mesh looks on screen, apart from what the model reads.
 *
 * The model is handed each message in full, with what its intent asks
 * and a reminder that it is context rather than a task, every time. The
 * person was shown all of that too, so one finding took a screen, and a
 * session waiting for its turn on the machine filled with other
 * sessions' talk until what it was doing was out of sight. On screen a
 * delivery is one narration line a message: who sent it, what kind it
 * is, and how it opens. Expanded, it is everything the model read.
 *
 * A glance is other peers' news, sent to nobody in this session, so it
 * is the model's alone and the screen shows nothing of it.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Message } from "../../lib/mesh/message.ts";
import { renderNarrationLine } from "../../lib/ui/narration.ts";
import { GLYPH } from "../../lib/ui/types.ts";

/** The source every mesh line is narrated under. */
const SOURCE = "mesh";

/** What a delivery's details hold, as far as the screen reads them. */
export interface Shown {
	readonly messages?: readonly Message[];
}

/** The lines a delivery shows: one a message, or all of it expanded. */
export function meshLines(
	content: string,
	details: Shown | undefined,
	theme: Theme,
	width: number,
	expanded: boolean,
): string[] {
	const messages = details?.messages ?? [];
	const heads =
		messages.length > 0
			? messages.map((message) =>
					renderNarrationLine(SOURCE, said(message), theme, {
						level:
							message.intent === "hold" || message.intent === "pivot"
								? "warn"
								: "info",
					}),
				)
			: [renderNarrationLine(SOURCE, opening(content), theme)];
	const lines = heads.map((head) =>
		truncateToWidth(head, width, GLYPH.ellipsis),
	);
	if (!expanded) return lines;
	return [
		...lines,
		...content
			.split("\n")
			.flatMap((part) => wrapTextWithAnsi(theme.fg("dim", part), width)),
	];
}

/**
 * One message as a line: its sender, the group it went to when it went
 * to one, its intent, and how it opens.
 */
function said(message: Message): string {
	const groups = message.to.filter((to) => to.startsWith("#"));
	const to = groups.length > 0 ? ` to ${groups.join(", ")}` : "";
	return [
		`${message.from}${to}`,
		message.intent,
		opening(withoutSender(message)),
	].join(` ${GLYPH.dot} `);
}

/**
 * Its text without the sender's name in front, which peers often write
 * ("P9R1KI: …") and the line already says.
 */
function withoutSender(message: Message): string {
	const named = `${message.from}:`;
	return message.text.startsWith(named)
		? message.text.slice(named.length).trimStart()
		: message.text;
}

/** The first line of some text, its spacing closed up. */
function opening(text: string): string {
	const first = text.split("\n").find((part) => part.trim() !== "") ?? "";
	return first.replace(/\s+/g, " ").trim();
}
