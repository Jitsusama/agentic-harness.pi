/**
 * Compaction Selection Provider extension.
 *
 * Quotes, after each compaction summary, the paragraphs of the dropped
 * conversation whose exact words matter: standing instructions,
 * corrections, goals, decisions and what is still open, among others.
 * A summary paraphrases, and a paraphrase is where a rule the user set
 * an hour ago loses the word that made it a rule.
 *
 * As the session runs, one of pi's classifier models tags each message's
 * paragraphs by kind, in the background, and the tags are recorded on
 * the session. When a summary is written ahead, the paragraphs the
 * compaction would quote are checked against what came after them,
 * so one since withdrawn or settled is not brought back. When the
 * compaction applies, the best of what is left within the budget is
 * appended to the summary, through the compaction host's summary
 * contributions.
 *
 * The classifier is the one `PI_COMPACTION_CLASSIFIER` names, or the
 * first Jev model in pi's catalog with credentials. It does nothing
 * without one, or with the variable set to `off`, and
 * `PI_COMPACTION_EXCERPT_TOKENS=0` turns the excerpts off while
 * leaving the tags to accumulate.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUMMARY_CONTRIBUTIONS } from "../../lib/compaction/index.ts";
import { selectionContributor } from "./contribution.ts";
import { tagger } from "./tagger.ts";

export default function compactionSelectionProvider(pi: ExtensionAPI) {
	let session: ExtensionContext | undefined;
	const tagging = tagger(pi);
	const contributor = selectionContributor(pi, () => session);

	pi.events.on(SUMMARY_CONTRIBUTIONS, contributor.listener);

	pi.on("session_start", async (_event, ctx) => {
		tagging.stop();
		contributor.stop();
		session = ctx;
		tagging.schedule(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		session = ctx;
		tagging.schedule(ctx);
	});
	pi.on("session_shutdown", async () => {
		tagging.stop();
		contributor.stop();
		session = undefined;
	});
}
