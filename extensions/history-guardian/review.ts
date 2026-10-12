/**
 * History guardians, one per severity.
 *
 * A risky command (rebase, stash drop, leased force push) can be
 * undone with some effort, so by default it is reported and runs. An
 * irrecoverable one (reset --hard, clean -f, branch -D, checkout -- .,
 * a bare force push) cannot, so by default it is refused with the safe
 * form named; a bare force push has a safe form the gate can apply
 * itself, so it is leased and reported instead of refused.
 *
 * Each segment of a chained command is judged on its own, since core
 * reports only the first pattern a whole command matches and a rebase
 * chained before a reset would otherwise hide the reset.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type DestructiveMatch,
	detectDestructiveCommand,
} from "@jitsusama/agentic-harness.core/guardian/history-gate";
import {
	ALLOW,
	type CommandGuardian,
	formatRedirectBlock,
	type GuardianResult,
	reportGuard,
} from "../../lib/guardian/index.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/index.ts";
import { promptSingle, renderMarkdown } from "../../lib/ui/index.ts";

const DESTRUCTIVE_ACTIONS = [{ key: "r", label: "Reject" }];

/** Where one shell command ends and the next begins. */
const SEGMENT_BREAK = /&&|\|\||[;|\n]/;

/** A match with the safe form core names for an irrecoverable command. */
export type HistoryMatch = DestructiveMatch & {
	remedy?: string;
	rewrite?: string;
};

/** What the history guardians found in one command. */
export interface HistoryFindings {
	/** The command as it was given. */
	readonly command: string;
	/** One match per segment that matched, in order. */
	readonly matches: readonly HistoryMatch[];
}

/**
 * Every history match in a command, segment by segment. Matching runs
 * on the command with quoted data and heredoc bodies stripped, so a
 * message that mentions a command is not mistaken for it.
 */
export function findHistoryMatches(command: string): HistoryMatch[] {
	const visible = stripShellData(stripHeredocBodies(command));
	const matches: HistoryMatch[] = [];
	for (const segment of visible.split(SEGMENT_BREAK)) {
		const match: HistoryMatch | null = detectDestructiveCommand(segment.trim());
		if (match) matches.push(match);
	}
	return matches;
}

function findingsOf(
	command: string,
	severity: DestructiveMatch["severity"],
): HistoryFindings | null {
	const matches = findHistoryMatches(command).filter(
		(m) => m.severity === severity,
	);
	return matches.length > 0 ? { command, matches } : null;
}

/** The command with every rewritable segment replaced, or null. */
export function rewriteAll(findings: HistoryFindings): string | null {
	let command = findings.command;
	for (const match of findings.matches) {
		if (!match.rewrite || !command.includes(match.command)) return null;
		command = command.replace(match.command, match.rewrite);
	}
	return command;
}

function explain(findings: HistoryFindings, title: string): string {
	return [
		`**${title}**`,
		"",
		"```bash",
		findings.command,
		"```",
		"",
		...findings.matches.map(
			(m) => `- ${m.description}${m.remedy ? ` ${m.remedy}` : ""}`,
		),
	].join("\n");
}

/** Guardian for history rewrites that can be undone with effort. */
export const riskyHistoryGuardian: CommandGuardian<HistoryFindings> = {
	detect(command) {
		return findingsOf(command, "risky") !== null;
	},

	parse(command) {
		return findingsOf(command, "risky");
	},

	async review(
		parsed: HistoryFindings,
		ctx: ExtensionContext,
		mode = "block",
	): Promise<GuardianResult> {
		const title = "Risky Command";
		const markdown = explain(parsed, title);
		if (mode === "report") {
			reportGuard({
				guard: GUARDS.history.name,
				kind: "shown",
				title,
				body: markdown,
			});
			return ALLOW;
		}

		const result = await promptSingle(ctx, {
			title,
			content: (theme, width) => renderMarkdown(`⚠ ${markdown}`, theme, width),
			actions: DESTRUCTIVE_ACTIONS,
		});

		const context = `Original command:\n${parsed.command}`;
		if (!result) {
			return { block: true, reason: "User cancelled the command review." };
		}
		if (result.type === "redirect") {
			return formatRedirectBlock(result.note, context);
		}
		if (result.type === "action") {
			if (result.note) return formatRedirectBlock(result.note, context);
			if (result.key === "r") {
				return { block: true, reason: `User blocked: ${parsed.command}` };
			}
			return ALLOW;
		}
	},
};

/** Guardian for history commands that cannot be brought back. */
export const destructiveHistoryGuardian: CommandGuardian<HistoryFindings> = {
	detect(command) {
		return findingsOf(command, "irrecoverable") !== null;
	},

	parse(command) {
		return findingsOf(command, "irrecoverable");
	},

	async review(
		parsed: HistoryFindings,
		_ctx: ExtensionContext,
		mode = "block",
	): Promise<GuardianResult> {
		const guard = GUARDS.historyDestructive.name;
		if (mode === "report") {
			reportGuard({
				guard,
				kind: "waved",
				title: "Destructive Command",
				body: explain(parsed, "Destructive Command"),
			});
			return ALLOW;
		}

		const rewritten = rewriteAll(parsed);
		if (rewritten) {
			reportGuard({
				guard,
				kind: "fixed",
				title: "Leased the force push",
				body: `\`\`\`bash\n${rewritten}\n\`\`\`\n\nA bare force push overwrites whatever the remote holds; the lease refuses when it has moved since the last fetch.`,
			});
			return { rewrite: rewritten };
		}

		const reasons = parsed.matches.map(
			(m) => `${m.command}: ${m.description}${m.remedy ? ` ${m.remedy}` : ""}`,
		);
		return {
			block: true,
			reason: [
				"History guard: this cannot be undone once it runs.",
				...reasons,
				"If the user wants it run as it is, they can run it themselves or switch the guard with `/guards history-destructive report`.",
			].join("\n"),
		};
	},
};
