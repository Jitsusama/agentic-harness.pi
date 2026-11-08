/**
 * A failing assertion says what was wrong.
 *
 * An expect that hands its matcher only true or false, by `toBe` with a
 * boolean, `toBeTruthy` or `toBeFalsy`, fails saying only that false was
 * not true. The value that made it false was thrown away before the
 * matcher saw it, so the reader has to rerun the test, often with a log
 * line added, to learn anything. So an expect either hands its matcher
 * the value itself, as `toBe(b)`, `toContain(x)`, `toMatch(/^p/)` or
 * `toMatchObject({ ok: true })` do, or carries a message, as its second
 * argument, saying in plain words what should have held. This is rule 8
 * of the repo-quality-standard skill.
 *
 * Only an expect written on one line is read. One a formatter has broken
 * over several lines is missed, which lets some through but never fails a
 * file that keeps the rule. An expect whose argument list holds a comma
 * outside any bracket or string carries a message, and passes.
 *
 * A file still holding a bare one is listed below, with why, and the list
 * fails once that file no longer holds any, so it only shrinks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** A line holding an expect whose matcher is told only true or false. */
const BARE =
	/expect\([^;]*\)\.(toBe\((true|false)\)|toBeTruthy\(\)|toBeFalsy\(\))/;

/** What follows an expect's closing bracket when it is told only true or false. */
const BOOLEAN_MATCHER =
	/^\.(toBe\((true|false)\)|toBeTruthy\(\)|toBeFalsy\(\))/;

/** Files still holding a bare boolean expect, each with why. */
const BATCHED =
	"its bare boolean expects are being replaced folder by folder; see the repo-quality-standard skill's rule 8";

const WAITING: Record<string, string> = {
	"tests/core/advisor/settings.test.ts": BATCHED,
	"tests/core/advisor/substantive.test.ts": BATCHED,
	"tests/core/attribution/commit-hook.test.ts": BATCHED,
	"tests/core/browser/behind.test.ts": BATCHED,
	"tests/core/browser/bounded.test.ts": BATCHED,
	"tests/core/browser/capture.test.ts": BATCHED,
	"tests/core/browser/clip.test.ts": BATCHED,
	"tests/core/browser/emulation.test.ts": BATCHED,
	"tests/core/browser/environment.test.ts": BATCHED,
	"tests/core/browser/hydration.test.ts": BATCHED,
	"tests/core/browser/interaction.test.ts": BATCHED,
	"tests/core/browser/motion.test.ts": BATCHED,
	"tests/core/browser/navigation.test.ts": BATCHED,
	"tests/core/browser/observation.test.ts": BATCHED,
	"tests/core/browser/pair.test.ts": BATCHED,
	"tests/core/browser/signals.test.ts": BATCHED,
	"tests/core/browser/slack-extract.test.ts": BATCHED,
	"tests/core/browser/telemetry.test.ts": BATCHED,
	"tests/core/browser/tracing.test.ts": BATCHED,
	"tests/core/browser/typography.test.ts": BATCHED,
	"tests/core/governance/store.test.ts": BATCHED,
	"tests/core/internal/guardian/commit-format.test.ts": BATCHED,
	"tests/core/internal/guardian/prose-gate.test.ts": BATCHED,
	"tests/core/internal/quest/record-audit.test.ts": BATCHED,
	"tests/core/internal/quest/workspace.test.ts": BATCHED,
	"tests/core/lsp/external.test.ts": BATCHED,
	"tests/core/lsp/standalone/standalone.integration.test.ts": BATCHED,
	"tests/core/notes/id.test.ts": BATCHED,
	"tests/core/notes/verbs.test.ts": BATCHED,
	"tests/core/observability/ledger/verifier.test.ts": BATCHED,
	"tests/core/package/git-scoping.test.ts": BATCHED,
	"tests/core/process/process.test.ts": BATCHED,
	"tests/core/quest/config.test.ts": BATCHED,
	"tests/core/quest/lifecycle-and-verbs.test.ts": BATCHED,
	"tests/core/quest/machine.test.ts": BATCHED,
	"tests/core/quest/render-rows.test.ts": BATCHED,
	"tests/core/result/location.test.ts": BATCHED,
	"tests/core/result/spill.test.ts": BATCHED,
	"tests/core/result/store.test.ts": BATCHED,
	"tests/core/sections/compose.test.ts": BATCHED,
	"tests/core/sections/depth.test.ts": BATCHED,
	"tests/core/sections/detect.test.ts": BATCHED,
	"tests/core/support/oauth-callback.ts": BATCHED,
	"tests/core/tree/git-worktree-stopping.test.ts": BATCHED,
	"tests/core/tree/git-worktree.test.ts": BATCHED,
	"tests/core/verify/run.test.ts": BATCHED,
	"tests/core/web/a11y/naming.test.ts": BATCHED,
	"tests/core/web/a11y/tree.test.ts": BATCHED,
	"tests/core/web/a11y/walk.test.ts": BATCHED,
	"tests/core/web/audit/axe.test.ts": BATCHED,
	"tests/core/web/audit/capture.test.ts": BATCHED,
	"tests/core/web/audit/contrast.test.ts": BATCHED,
	"tests/core/web/audit/structure.test.ts": BATCHED,
	"tests/core/web/audit/sweep.test.ts": BATCHED,
	"tests/core/web/audit/target.test.ts": BATCHED,
	"tests/core/web/audit/visual.test.ts": BATCHED,
	"tests/core/web/browser.test.ts": BATCHED,
	"tests/core/web/design/inventory.test.ts": BATCHED,
	"tests/core/web/design/typography.test.ts": BATCHED,
	"tests/core/web/element/actionable.test.ts": BATCHED,
	"tests/core/web/element/measure.test.ts": BATCHED,
	"tests/core/web/envelope/naming.test.ts": BATCHED,
	"tests/core/web/environment/devices.test.ts": BATCHED,
	"tests/core/web/environment/emulation.test.ts": BATCHED,
	"tests/core/web/environment/shaping.test.ts": BATCHED,
	"tests/core/web/environment/storage.test.ts": BATCHED,
	"tests/core/web/environment/tabs.test.ts": BATCHED,
	"tests/core/web/evaluate/outcome.test.ts": BATCHED,
	"tests/core/web/hydration/judge.test.ts": BATCHED,
	"tests/core/web/mermaid.test.ts": BATCHED,
	"tests/core/web/perf/heap.test.ts": BATCHED,
	"tests/core/web/perf/trace.test.ts": BATCHED,
	"tests/core/web/perf/vitals.test.ts": BATCHED,
	"tests/core/web/procs.test.ts": BATCHED,
	"tests/core/web/purity.test.ts": BATCHED,
	"tests/core/web/reader.test.ts": BATCHED,
	"tests/core/web/screenshot.test.ts": BATCHED,
	"tests/core/web/search.test.ts": BATCHED,
	"tests/core/web/session/recording.test.ts": BATCHED,
	"tests/core/web/snapshot/flatten.test.ts": BATCHED,
	"tests/core/web/snapshot/query.test.ts": BATCHED,
	"tests/core/web/sourcemap/mappings.test.ts": BATCHED,
	"tests/core/web/target/parse.test.ts": BATCHED,
	"tests/core/web/telemetry/dialogs.test.ts": BATCHED,
	"tests/core/web/telemetry/failure.test.ts": BATCHED,
	"tests/core/web/telemetry/har.test.ts": BATCHED,
	"tests/core/web/telemetry/lifecycle.test.ts": BATCHED,
	"tests/core/web/telemetry/network.test.ts": BATCHED,
	"tests/core/web/telemetry/requests.test.ts": BATCHED,
	"tests/core/web/wait/conditions.test.ts": BATCHED,
	"tests/core/work/custody.test.ts": BATCHED,
	"tests/core/work/end-to-end.test.ts": BATCHED,
	"tests/core/work/git-provider.test.ts": BATCHED,
	"tests/core/work/held-names.test.ts": BATCHED,
	"tests/core/work/history.test.ts": BATCHED,
	"tests/core/work/inplay.test.ts": BATCHED,
	"tests/core/work/memory.test.ts": BATCHED,
	"tests/core/work/publish.test.ts": BATCHED,
	"tests/core/work/rebase-settle.test.ts": BATCHED,
	"tests/core/work/rebase.test.ts": BATCHED,
	"tests/core/work/reclaim.test.ts": BATCHED,
	"tests/core/work/stacks-live.test.ts": BATCHED,
	"tests/core/work/survey.test.ts": BATCHED,
	"tests/core/work/sweep-live.test.ts": BATCHED,
	"tests/core/work/tidy-live.test.ts": BATCHED,
	"tests/core/work/tidy.test.ts": BATCHED,
	"tests/core/work/tree-identity.test.ts": BATCHED,
	"tests/extensions/advisor/stopping.test.ts": BATCHED,
	"tests/extensions/away-workflow/away.test.ts": BATCHED,
	"tests/extensions/away-workflow/carry-on.test.ts": BATCHED,
	"tests/extensions/away-workflow/reach.test.ts": BATCHED,
	"tests/extensions/away-workflow/wiring.test.ts": BATCHED,
	"tests/extensions/browser-integration/registry-turns.test.ts": BATCHED,
	"tests/extensions/browser-integration/registry.test.ts": BATCHED,
	"tests/extensions/commit-guardian/parse.test.ts": BATCHED,
	"tests/extensions/compaction-workflow/chain.test.ts": BATCHED,
	"tests/extensions/compaction-workflow/host.test.ts": BATCHED,
	"tests/extensions/compaction-workflow/kept-request.test.ts": BATCHED,
	"tests/extensions/convention-context/scope.test.ts": BATCHED,
	"tests/extensions/done-chime-widget/ring.test.ts": BATCHED,
	"tests/extensions/done-chime-widget/when.test.ts": BATCHED,
	"tests/extensions/gates-leave-the-queue.test.ts": BATCHED,
	"tests/extensions/git-cli-interceptor/policy.test.ts": BATCHED,
	"tests/extensions/history-guardian/review.test.ts": BATCHED,
	"tests/extensions/image-budget-workflow/rebudget.test.ts": BATCHED,
	"tests/extensions/job-workflow/cut-off.test.ts": BATCHED,
	"tests/extensions/job-workflow/host.test.ts": BATCHED,
	"tests/extensions/job-workflow/reload.test.ts": BATCHED,
	"tests/extensions/job-workflow/rollover.test.ts": BATCHED,
	"tests/extensions/job-workflow/tool.test.ts": BATCHED,
	"tests/extensions/loadout-workflow/skills.test.ts": BATCHED,
	"tests/extensions/lsp-integration/restarting.test.ts": BATCHED,
	"tests/extensions/lsp-integration/stopping.test.ts": BATCHED,
	"tests/extensions/mermaid-widget/content.test.ts": BATCHED,
	"tests/extensions/mesh-workflow/hand.test.ts": BATCHED,
	"tests/extensions/mesh-workflow/mesh.test.ts": BATCHED,
	"tests/extensions/mesh-workflow/pausing.test.ts": BATCHED,
	"tests/extensions/mesh-workflow/talks.test.ts": BATCHED,
	"tests/extensions/park-workflow/watch.test.ts": BATCHED,
	"tests/extensions/pr-guardian/redirect.test.ts": BATCHED,
	"tests/extensions/pr-guardian/review.test.ts": BATCHED,
	"tests/extensions/priority-workflow/push-hooks-guard.test.ts": BATCHED,
	"tests/extensions/quest-workflow/_helpers.ts": BATCHED,
	"tests/extensions/quest-workflow/alias-add-list.test.ts": BATCHED,
	"tests/extensions/quest-workflow/ancestors.test.ts": BATCHED,
	"tests/extensions/quest-workflow/born-readable.test.ts": BATCHED,
	"tests/extensions/quest-workflow/bulk-conclude.test.ts": BATCHED,
	"tests/extensions/quest-workflow/conclude-audit.test.ts": BATCHED,
	"tests/extensions/quest-workflow/conclude-by-id.test.ts": BATCHED,
	"tests/extensions/quest-workflow/concluded.test.ts": BATCHED,
	"tests/extensions/quest-workflow/cwd-auto-attach.test.ts": BATCHED,
	"tests/extensions/quest-workflow/discipline.test.ts": BATCHED,
	"tests/extensions/quest-workflow/document-verbs.test.ts": BATCHED,
	"tests/extensions/quest-workflow/ends-with-quest.test.ts": BATCHED,
	"tests/extensions/quest-workflow/first-turn-watch.test.ts": BATCHED,
	"tests/extensions/quest-workflow/focus-refusals.test.ts": BATCHED,
	"tests/extensions/quest-workflow/inventory.test.ts": BATCHED,
	"tests/extensions/quest-workflow/is-persisted-session.test.ts": BATCHED,
	"tests/extensions/quest-workflow/locate.test.ts": BATCHED,
	"tests/extensions/quest-workflow/matches-query.test.ts": BATCHED,
	"tests/extensions/quest-workflow/orchestrate.test.ts": BATCHED,
	"tests/extensions/quest-workflow/orchestrators.test.ts": BATCHED,
	"tests/extensions/quest-workflow/record-gate.test.ts": BATCHED,
	"tests/extensions/quest-workflow/render.test.ts": BATCHED,
	"tests/extensions/quest-workflow/reopen-verb.test.ts": BATCHED,
	"tests/extensions/quest-workflow/reparent.test.ts": BATCHED,
	"tests/extensions/quest-workflow/resolve-startup.test.ts": BATCHED,
	"tests/extensions/quest-workflow/scope-verbs.test.ts": BATCHED,
	"tests/extensions/quest-workflow/scoreboard-resize.test.ts": BATCHED,
	"tests/extensions/quest-workflow/scratch-removed.test.ts": BATCHED,
	"tests/extensions/quest-workflow/scratch.test.ts": BATCHED,
	"tests/extensions/quest-workflow/session-audit.test.ts": BATCHED,
	"tests/extensions/quest-workflow/session-identity.test.ts": BATCHED,
	"tests/extensions/quest-workflow/session-persist.test.ts": BATCHED,
	"tests/extensions/quest-workflow/session-registry.test.ts": BATCHED,
	"tests/extensions/quest-workflow/sessions-at-work.test.ts": BATCHED,
	"tests/extensions/quest-workflow/spawn-held.test.ts": BATCHED,
	"tests/extensions/quest-workflow/spawn-launcher.test.ts": BATCHED,
	"tests/extensions/quest-workflow/spawn-resume.test.ts": BATCHED,
	"tests/extensions/quest-workflow/stage-flow.test.ts": BATCHED,
	"tests/extensions/quest-workflow/terminal.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-add-cwd.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-adopt.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-gate.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-release-binding.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-signal.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-target.test.ts": BATCHED,
	"tests/extensions/quest-workflow/tree-verbs.test.ts": BATCHED,
	"tests/extensions/quest-workflow/trust-prompt.test.ts": BATCHED,
	"tests/extensions/quest-workflow/undo-generalized.test.ts": BATCHED,
	"tests/extensions/quest-workflow/verbs.test.ts": BATCHED,
	"tests/extensions/quest-workflow/weights.test.ts": BATCHED,
	"tests/extensions/quest-workflow/workspace-folder.test.ts": BATCHED,
	"tests/extensions/reload-workflow/still.test.ts": BATCHED,
	"tests/extensions/reload-workflow/wiring.test.ts": BATCHED,
	"tests/extensions/result-store-workflow/lifetime.test.ts": BATCHED,
	"tests/extensions/review-ask-panel.test.ts": BATCHED,
	"tests/extensions/review-ask-stopped.test.ts": BATCHED,
	"tests/extensions/review-built-in-personas.test.ts": BATCHED,
	"tests/extensions/review-checks-job.test.ts": BATCHED,
	"tests/extensions/review-fix-tree.test.ts": BATCHED,
	"tests/extensions/review-gate-batch.test.ts": BATCHED,
	"tests/extensions/review-gate-flush-payload.test.ts": BATCHED,
	"tests/extensions/review-gate-propose.test.ts": BATCHED,
	"tests/extensions/review-housekeeping-is-scoped.test.ts": BATCHED,
	"tests/extensions/review-indexed.test.ts": BATCHED,
	"tests/extensions/review-integration.test.ts": BATCHED,
	"tests/extensions/review-offer-sections.test.ts": BATCHED,
	"tests/extensions/review-offer-stack.test.ts": BATCHED,
	"tests/extensions/review-publish-tabs.test.ts": BATCHED,
	"tests/extensions/review-redirect-context.test.ts": BATCHED,
	"tests/extensions/review-settle.test.ts": BATCHED,
	"tests/extensions/review-starts-a-round-it-will-not-wait-for.test.ts":
		BATCHED,
	"tests/extensions/review-stop-settles-its-round.test.ts": BATCHED,
	"tests/extensions/rollover-workflow/wiring.test.ts": BATCHED,
	"tests/extensions/shell-habit-interceptor/sleep.test.ts": BATCHED,
	"tests/extensions/shell-workflow/hand-off.test.ts": BATCHED,
	"tests/extensions/shell-workflow/real-bash.test.ts": BATCHED,
	"tests/extensions/shell-workflow/reap.test.ts": BATCHED,
	"tests/extensions/slack-integration/context.test.ts": BATCHED,
	"tests/extensions/spend-workflow/audit-input.test.ts": BATCHED,
	"tests/extensions/spend-workflow/resources.test.ts": BATCHED,
	"tests/extensions/status-line-widget/layout.test.ts": BATCHED,
	"tests/extensions/subagent-workflow/cancellation.test.ts": BATCHED,
	"tests/extensions/subagent-workflow/digests.test.ts": BATCHED,
	"tests/extensions/subagent-workflow/fleet-in-background.test.ts": BATCHED,
	"tests/extensions/subagent-workflow/fleet-outlives-its-session.test.ts":
		BATCHED,
	"tests/extensions/subagent-workflow/progress-render.test.ts": BATCHED,
	"tests/extensions/subagent-workflow/run.test.ts": BATCHED,
	"tests/extensions/subagent-workflow/sizing.test.ts": BATCHED,
	"tests/extensions/verification-workflow/render.test.ts": BATCHED,
	"tests/extensions/verification-workflow/stopping.test.ts": BATCHED,
	"tests/extensions/work-branch-fresh-start.test.ts": BATCHED,
	"tests/extensions/work-indexed.test.ts": BATCHED,
	"tests/extensions/work-record-wrap.test.ts": BATCHED,
	"tests/extensions/work-settling.test.ts": BATCHED,
	"tests/extensions/work-stack-render.test.ts": BATCHED,
	"tests/extensions/work-subject-limit.test.ts": BATCHED,
	"tests/extensions/work-tree-line.test.ts": BATCHED,
	"tests/extensions/work-tree-signal.test.ts": BATCHED,
	"tests/extensions/work-warm-start.test.ts": BATCHED,
	"tests/lib/command/cwd.test.ts": BATCHED,
	"tests/lib/command/tokenize.test.ts": BATCHED,
	"tests/lib/compaction/contributions.test.ts": BATCHED,
	"tests/lib/compaction/failure.test.ts": BATCHED,
	"tests/lib/compaction/outcome.test.ts": BATCHED,
	"tests/lib/compaction/provider.test.ts": BATCHED,
	"tests/lib/compaction/selection/select.test.ts": BATCHED,
	"tests/lib/compaction/summary.test.ts": BATCHED,
	"tests/lib/compaction/trigger.test.ts": BATCHED,
	"tests/lib/completion/investigate.test.ts": BATCHED,
	"tests/lib/completion/resolve.test.ts": BATCHED,
	"tests/lib/completion/side.test.ts": BATCHED,
	"tests/lib/google/auth/dual-flow.test.ts": BATCHED,
	"tests/lib/google/auth/store.test.ts": BATCHED,
	"tests/lib/guardian/enforce.test.ts": BATCHED,
	"tests/lib/guardian/policy.test.ts": BATCHED,
	"tests/lib/guardian/register.test.ts": BATCHED,
	"tests/lib/ledger/branch.test.ts": BATCHED,
	"tests/lib/ledger/calls.test.ts": BATCHED,
	"tests/lib/ledger/dropped.test.ts": BATCHED,
	"tests/lib/ledger/verifier.test.ts": BATCHED,
	"tests/lib/mcp/ceiling.test.ts": BATCHED,
	"tests/lib/mcp/connection.test.ts": BATCHED,
	"tests/lib/mcp/content.test.ts": BATCHED,
	"tests/lib/mcp/frontend/defaults.test.ts": BATCHED,
	"tests/lib/mcp/frontend/events.test.ts": BATCHED,
	"tests/lib/mcp/store.test.ts": BATCHED,
	"tests/lib/mcp/surface/helpers.test.ts": BATCHED,
	"tests/lib/memory/paths.test.ts": BATCHED,
	"tests/lib/quest/append-journey.test.ts": BATCHED,
	"tests/lib/quest/discovery-toc-mentions.test.ts": BATCHED,
	"tests/lib/quest/harness-log.test.ts": BATCHED,
	"tests/lib/quest/id.test.ts": BATCHED,
	"tests/lib/quest/io.test.ts": BATCHED,
	"tests/lib/quest/journey-sweep.test.ts": BATCHED,
	"tests/lib/quest/sanitize.test.ts": BATCHED,
	"tests/lib/shell/parse.test.ts": BATCHED,
	"tests/lib/slack/auth/ensure-auth.test.ts": BATCHED,
	"tests/lib/slack/auth/setup-wizard.test.ts": BATCHED,
	"tests/lib/slack/auth/store.test.ts": BATCHED,
	"tests/lib/slack/blocks.test.ts": BATCHED,
	"tests/lib/terminal/niri.test.ts": BATCHED,
	"tests/lib/terminal/open.test.ts": BATCHED,
	"tests/lib/terminal/plan.test.ts": BATCHED,
	"tests/lib/terminal/settings.test.ts": BATCHED,
	"tests/lib/ui/dock-row-styles.test.ts": BATCHED,
	"tests/lib/ui/gate-close.test.ts": BATCHED,
	"tests/lib/ui/gate-queue.test.ts": BATCHED,
	"tests/lib/ui/gate-session-end.test.ts": BATCHED,
	"tests/lib/ui/gates-overlay.test.ts": BATCHED,
	"tests/lib/ui/panel-footer.test.ts": BATCHED,
	"tests/lib/ui/pipeline-progress.test.ts": BATCHED,
	"tests/lib/ui/scroll-region-bounds.test.ts": BATCHED,
	"tests/lib/ui/scroll-region-passive-rows.test.ts": BATCHED,
	"tests/lib/ui/view-while.test.ts": BATCHED,
	"tests/package/glyphs-are-owned.test.ts": BATCHED,
	"tests/package/one-glyph-set-for-spawned-work.test.ts": BATCHED,
	"tests/package/one-grace-for-a-departed-process.test.ts": BATCHED,
	"tests/package/prose-glyphs.test.ts": BATCHED,
	"tests/package/runtime-deps.test.ts": BATCHED,
	"tests/package/skill-frontmatter-fits.test.ts": BATCHED,
	"tests/package/stored-results.test.ts": BATCHED,
	"tests/package/the-journal-is-bound-on-disk.test.ts": BATCHED,
	"tests/screen/dock-hop.test.ts": BATCHED,
	"tests/screen/fleet-board.test.ts": BATCHED,
	"tests/screen/gate-conditions.test.ts": BATCHED,
	"tests/screen/gate-lifecycle.test.ts": BATCHED,
	"tests/screen/gate-widget.test.ts": BATCHED,
	"tests/screen/harness.test.ts": BATCHED,
	"tests/screen/pi-layout.test.ts": BATCHED,
	"tests/screen/round-board.test.ts": BATCHED,
	"tests/screen/toggle-gate.test.ts": BATCHED,
	"tests/setup/xdg-sandbox.test.ts": BATCHED,
};

/** A bare boolean expect: the file, its line and what the line says. */
interface Bare {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
		else if (entry.endsWith(".ts")) found.push(relative(ROOT, path));
	}
	return found;
}

/** Where the string opening at `at` closes, past any escaped quote in it. */
function closingQuote(text: string, at: number): number {
	const quote = text.charAt(at);
	for (let next = at + 1; next < text.length; next++) {
		if (text.charAt(next) === "\\") next++;
		else if (text.charAt(next) === quote) return next;
	}
	return text.length;
}

/**
 * The argument list opening at `open`: where it closes, and whether it
 * holds a comma outside any bracket or string, so a second argument. A
 * list that does not close on the line is none.
 */
function argumentsAt(
	text: string,
	open: number,
): { readonly close: number; readonly message: boolean } | undefined {
	let depth = 0;
	let message = false;
	for (let at = open; at < text.length; at++) {
		const char = text.charAt(at);
		if (char === '"' || char === "'" || char === "`") {
			at = closingQuote(text, at);
		} else if ("([{".includes(char)) {
			depth++;
		} else if (")]}".includes(char)) {
			depth--;
			if (depth === 0) return { close: at, message };
		} else if (char === "," && depth === 1) {
			message = true;
		}
	}
	return undefined;
}

/** Whether a line holds an expect told only true or false and given no message. */
function isBare(text: string): boolean {
	if (!BARE.test(text)) return false;
	for (const found of text.matchAll(/\bexpect\(/g)) {
		const list = argumentsAt(text, found.index + "expect".length);
		if (
			list !== undefined &&
			!list.message &&
			BOOLEAN_MATCHER.test(text.slice(list.close + 1))
		)
			return true;
	}
	return false;
}

/** Every bare boolean expect in the package's tests, wherever it is. */
function bareExpects(): Bare[] {
	return sourcesUnder(join(ROOT, "tests")).flatMap((file) =>
		readFileSync(join(ROOT, file), "utf8")
			.split("\n")
			.flatMap((text, index): Bare[] =>
				isBare(text) ? [{ file, line: index + 1, text: text.trim() }] : [],
			),
	);
}

describe("the package's expects", () => {
	const found = bareExpects();

	it("tell a bare boolean expect from one that says what failed", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by. The
		// matcher is joined on, so this file's own lines are none of them.
		const told = ".toBe(true);";
		expect(isBare(`expect(isAlive(pid))${told}`), "a bare one is found").toBe(
			true,
		);
		expect(
			isBare(`expect(isAlive(pid), \`process \${pid} is gone\`)${told}`),
			"one carrying a message passes",
		).toBe(false);
		expect(
			isBare(`expect(hears(["#a", "#b"], "#a"))${told}`),
			"a comma inside a bracket is no message",
		).toBe(true);
		expect(
			isBare(`expect(said.includes("a, b"))${told}`),
			"a comma inside a string is no message",
		).toBe(true);
	});

	it("each say what failed, not only that it did", () => {
		const bare = found
			.filter(({ file }) => !(file in WAITING))
			.map(({ file, line, text }) => `${file}:${line}: ${text}`);
		expect(
			bare,
			`these expects tell their matcher only true or false, so they fail saying only that false was not true: hand the matcher the value instead (toBe(b), toContain(x), toMatch(/^p/), toMatchObject({ ok: true })), or give the expect a message saying what should hold:\n${bare.join("\n")}`,
		).toEqual([]);
	});

	it("keep no file waiting that no longer holds a bare one", () => {
		const stale = Object.keys(WAITING).filter(
			(file) => !found.some((bare) => bare.file === file),
		);
		expect(
			stale,
			`waiting but holding no bare boolean expect now; take them out of WAITING:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
