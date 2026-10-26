/**
 * The advisor's decision core: everything about watching turns,
 * investigating suspicions and raising findings that does not
 * need a host's UI or extension runtime.
 *
 * The orchestration that ties this to a live session (subscribing
 * to turn events, running the review loop, delivering a finding as
 * a steer or a quiet note) is adapter-local: it needs a host's
 * event model and message-delivery primitives, which is exactly
 * the kind of thing this package's own design principles say stays
 * out. `advisorCharter`/`reviewPrompt` describe the review the
 * adapter runs through `completion`'s `runInvestigation`;
 * `investigationTools` is the read-only palette that investigation
 * calls; `parseFindings`/`channelFor` turn its reply into
 * deliverable notes; `isSubstantiveTurn` and the
 * enabled/disabled settings file round out what a host needs to
 * decide whether to run a review at all.
 */

export { advisorCharter, reviewPrompt } from "./charter.ts";
export type { Channel, Finding, Severity } from "./findings.ts";
export {
	channelFor,
	IMMUNE_WINDOW,
	nextImmuneTurns,
	parseFindings,
} from "./findings.ts";
export { loadAdvisorEnabled, saveAdvisorEnabled } from "./settings.ts";
export { isSubstantiveTurn } from "./substantive.ts";
export {
	globArgs,
	grepArgs,
	investigationTools,
	resolveWithinRoot,
} from "./tools.ts";
