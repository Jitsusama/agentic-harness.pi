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
 * leaving the tags to accumulate. Without one and not set to `off`,
 * the person is told once a session, since nothing else would say so.
 *
 * Tags and judgements are custom entries on the session unless
 * `PI_COMPACTION_SELECTION_STORE=memory` keeps them in the process, for
 * a host whose rebuilt sessions drop custom entries. Every compaction
 * records what the selection did under `details.contributions`, and
 * when the session recall tool is active each quote names its
 * paragraph, so the model can read it in place. `/compaction-status`
 * shows the classifier, the budget, the tags so far and how many
 * compactions on the branch quoted anything.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	answerCompactionStatus,
	SUMMARY_CONTRIBUTIONS,
} from "../../lib/compaction/index.ts";
import { classifierStatus } from "./classifier.ts";
import { excerptTokens, selectionContributor } from "./contribution.ts";
import { selectionSection } from "./status.ts";
import { memoryStore, selectionStoreKind, sessionStore } from "./store.ts";
import { tagger } from "./tagger.ts";

/** The tool whose presence makes excerpts name their paragraphs. */
const RECALL_TOOL = "session_recall";

export default function compactionSelectionProvider(pi: ExtensionAPI) {
	let session: ExtensionContext | undefined;
	const store =
		selectionStoreKind() === "memory"
			? memoryStore()
			: sessionStore((type, data) => pi.appendEntry(type, data));
	const status = classifierStatus();
	const tagging = tagger(store, status);
	const contributor = selectionContributor(() => session, {
		store,
		status,
		refs: () => recallIsActive(pi),
		caughtUp: (ctx) => {
			tagging.schedule(ctx);
			return tagging.idle();
		},
	});

	pi.events.on(SUMMARY_CONTRIBUTIONS, contributor.listener);
	answerCompactionStatus(pi.events, (branch) =>
		selectionSection(
			{
				classifier: status.current(),
				store,
				budget: excerptTokens(),
				refs: recallIsActive(pi),
			},
			branch,
		),
	);

	pi.on("session_start", async (_event, ctx) => {
		tagging.stop();
		contributor.stop();
		store.reset();
		status.reset();
		session = ctx;
		tagging.schedule(ctx);
	});
	pi.on("session_compact", async () => store.compacted());
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

/** Whether the recall tool is active, on a pi that can say. */
function recallIsActive(pi: ExtensionAPI): boolean {
	if (typeof pi.getActiveTools !== "function") return false;
	try {
		return pi.getActiveTools().includes(RECALL_TOOL);
	} catch {
		// Asked outside a session, there is no tool list to read; no refs.
		return false;
	}
}
