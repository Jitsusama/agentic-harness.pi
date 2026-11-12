/**
 * How every review tool's call and answer read in the transcript.
 *
 * Apart from the rest of what the tools share, because a resumed
 * session draws its history before any tool has run: these load at
 * start with the registrations, and what a call does loads on its
 * first use (see each tool's `-tool.ts`).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderToolCall } from "../../../lib/ui/tool-call.ts";
import { firstText } from "../../../lib/ui/tool-result.ts";
import { boardsOf, roundCardLines } from "../progress.ts";
import type { Answer } from "./shared.ts";

/** Whether an answer carried a refusal. */
export function isRefusal(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		"error" in details &&
		Boolean((details as { error?: unknown }).error)
	);
}

/**
 * How much of a long answer is shown before Ctrl-O is needed.
 *
 * Chosen so every write answer arrives whole: the longest of them is a
 * batch outcome, a line per item and a url under each. Reads are what
 * this is for, and a diff has no length worth guessing at.
 */
const PREVIEW_LINES = 12;

/** How many lines preview a digest, which stands above them. */
const DIGEST_PREVIEW_LINES = 6;

/**
 * The one line a tool offers about what it just did.
 *
 * A shared renderer has only prose to work with, and prose cannot be
 * summarized without guessing. The tool knows: it counted the files, it
 * ran the round, it published the plan. Where one is offered the
 * collapsed view opens with it, the way every other collapsed result in
 * this package opens with a mark and a count.
 */
function digestOf(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const said = (details as { summary?: unknown }).summary;
	return typeof said === "string" && said !== "" ? said : undefined;
}

/**
 * The renderer every review tool shares.
 *
 * A read can answer with hundreds of lines, and painting all of them
 * pushes the conversation that asked for it off the screen. The
 * collapsed form keeps the head and says how much it is holding; Ctrl-O
 * gives the rest. Short answers are untouched, since a hint under a
 * one-line result is noise about nothing.
 */
export function renderAnswer(
	result: Answer,
	theme: Theme,
	options?: { expanded?: boolean },
	reuse?: unknown,
): Text {
	const text = firstText(result);
	const digest = digestOf(result.details);
	const shown = options?.expanded
		? text
		: digest
			? digested(text, digest, theme)
			: clipped(text, theme);
	const said = isRefusal(result.details) ? theme.fg("error", shown) : shown;
	// A round's board, as it stood when the call returned, opens the card.
	// The board left in the frame this arrived, from the rows this now
	// holds, so the screen neither jumps nor leaves them blank.
	const boards = boardsOf(result.details).flatMap((one) =>
		roundCardLines(one, theme),
	);
	const painted = [...boards, said].join("\n");
	// Pi hands back what this returned last time so a redraw updates one
	// component. Building a new one strands the old beside it, which is
	// the ghost row above a finished call.
	if (reuse instanceof Text) {
		reuse.setText(painted);
		return reuse;
	}
	return new Text(painted, 0, 0);
}

/** The head of an answer, with a count of what is not being shown. */
function clipped(text: string, theme: Theme): string {
	const lines = text.split("\n");
	if (lines.length <= PREVIEW_LINES) return text;
	const withheld = lines.length - PREVIEW_LINES;
	return [
		...lines.slice(0, PREVIEW_LINES),
		theme.fg("muted", `... ${withheld} more`),
	].join("\n");
}

/** A digest, a few lines under it, and what is left. */
function digested(text: string, digest: string, theme: Theme): string {
	const lines = text.split("\n");
	const preview = lines.slice(0, DIGEST_PREVIEW_LINES);
	const withheld = lines.length - preview.length;
	return [
		digest,
		...preview,
		...(withheld > 0 ? [theme.fg("muted", `... ${withheld} more`)] : []),
	].join("\n");
}

/**
 * How a tool call reads in the transcript.
 *
 * This used to bold the tool and the action together, which meant the two ran
 * into each other and neither stood out. The shared line bolds the tool alone, so
 * the eye finds which tool without reading the row, and the action reads as that
 * tool's own word.
 */
export function renderInvocation(
	theme: Theme,
	tool: string,
	action: string | undefined,
	subject: string | undefined,
	reuse?: unknown,
): Text {
	return renderToolCall(
		{
			tool,
			...(action ? { action } : {}),
			...(subject ? { subject } : {}),
		},
		theme,
		reuse instanceof Text ? reuse : undefined,
	);
}
