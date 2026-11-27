/**
 * How a session answers its person: first, from what it already holds,
 * and for the whole quest when he asks where things stand.
 *
 * Two shapes recurred in 1JQPPC's loop 2 on 26 November. The person
 * asked something and waited while the session read and ran before it
 * said a word (c6eb7796). And when he asked "where are we at", about
 * six times a day by its keyword count, cells answered for their latest
 * step, one review round, rather than the quest (16af4e70: TKVCSI,
 * IHHRPH, MZ5YL7). A peer's question already carries "answer it now,
 * before anything else" (mesh-workflow's delivery); nothing said the
 * same of the person's own.
 *
 * Said as a standing context, the stock way the harness tells every
 * session something that stands: frozen into the prompt at the first
 * turn, so a live session hears it once without a turn of its own, and
 * never said again, since the words never change.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerStandingContext,
	type StandingContextWording,
} from "../../../lib/prompt/index.ts";

const LABEL = "[Answering the person]";

/** What the session is told about answering its person. */
export const ANSWERING_THE_PERSON = [
	"When the person writes to you, rather than a peer on the mesh or a tool's answer, say something to him first from what this session already holds, in a line or two. Then read or run what you need, saying what you're checking.",
	"When he asks where things stand, answer for the whole quest before the latest step, from its README and plans: what's live on his machines, what's merged and waiting on a switch or install, what's open and its date, and what waits on him. With no quest loaded, answer for the work this session holds.",
].join(" ");

/** How the rule reads in the prompt. It never changes, so never says a change. */
export const ANSWER_THE_PERSON: StandingContextWording = {
	customType: "answer-the-person",
	inPrompt: (text) => `\n\n${LABEL} ${text}`,
	changed: (text) => `${LABEL} Now: ${text ?? "nothing stands."}`,
};

/** Tell every session how to answer its person, as it next works. */
export function registerAnsweringThePerson(pi: ExtensionAPI): void {
	registerStandingContext(pi, ANSWER_THE_PERSON, () => ANSWERING_THE_PERSON);
}
