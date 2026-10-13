/**
 * Every guard this package declares, in one place.
 *
 * Each extension declares the guards it fires on load, so a guard's
 * default holds whether or not the policy workflow is installed: a name
 * nobody declared resolves to block. Keeping the declarations here means
 * two extensions sharing a guard (the prose gate, say) declare the same
 * thing, and `/guards` lists one entry for it.
 *
 * Defaults follow one rule. An approval that only lands on this machine
 * or on a change the owner controls reports. An approval that reaches
 * other people directly (Slack, mail, calendar) blocks. A redirect blocks,
 * since a refusal that says how to try again costs one turn. A safety
 * guard blocks only what cannot be brought back.
 */

import { declareGuard, type GuardDeclaration } from "../../guardian/policy.ts";

const declare = (d: GuardDeclaration) => d;

/** The package's guards, by name. */
export const GUARDS = {
	commit: declare({
		name: "commit",
		class: "approval",
		description: "Shows a commit message before git commit runs",
		defaultMode: "report",
		groups: ["git"],
	}),
	commitVerification: declare({
		name: "commit-verification",
		class: "redirect",
		description: "Refuses a commit while verification reports errors",
		defaultMode: "block",
		groups: ["git"],
	}),
	history: declare({
		name: "history",
		class: "safety",
		description: "Shows a rebase, stash drop or leased force push",
		defaultMode: "report",
		groups: ["git"],
	}),
	historyDestructive: declare({
		name: "history-destructive",
		class: "safety",
		description:
			"Refuses reset --hard, clean -f, branch -D and checkout -- . with a safe form; leases a bare force push",
		defaultMode: "block",
		groups: ["git"],
	}),
	commitShape: declare({
		name: "commit-shape",
		class: "redirect",
		description:
			"Refuses an amend and an unquoted commit heredoc, naming the form to retry",
		defaultMode: "block",
		groups: ["git"],
	}),
	gitCli: declare({
		name: "git-cli",
		class: "redirect",
		description:
			"Splits a chained commit, gh pr or gh issue so each panel shows one",
		defaultMode: "block",
		groups: ["git"],
		follows: ["commit", "pr", "issue"],
	}),
	pr: declare({
		name: "pr",
		class: "approval",
		description: "Shows a pull request's title and body before gh pr runs",
		defaultMode: "report",
		groups: ["github"],
	}),
	issue: declare({
		name: "issue",
		class: "approval",
		description: "Shows an issue's title and body before gh issue runs",
		defaultMode: "report",
		groups: ["github"],
	}),
	host: declare({
		name: "host",
		class: "redirect",
		description: "Sends a change on a host gh cannot see to the review tools",
		defaultMode: "block",
		groups: ["github"],
	}),
	githubCli: declare({
		name: "github-cli",
		class: "redirect",
		description: "Holds gh bodies to the shapes the guardians can read",
		defaultMode: "block",
		groups: ["github"],
	}),
	attribution: declare({
		name: "attribution",
		class: "redirect",
		description: "Refuses a gh command it cannot attribute",
		defaultMode: "block",
		groups: ["github"],
	}),
	prose: declare({
		name: "prose",
		class: "redirect",
		description: "Refuses authored text that breaks the prose standard",
		defaultMode: "block",
		groups: ["format"],
	}),
	sections: declare({
		name: "sections",
		class: "redirect",
		description: "Refuses a PR or issue body without its sections",
		defaultMode: "block",
		groups: ["format"],
	}),
	titles: declare({
		name: "titles",
		class: "redirect",
		description: "Refuses a PR or issue title out of its convention",
		defaultMode: "block",
		groups: ["format"],
	}),
	reviewOffer: declare({
		name: "review-offer",
		class: "approval",
		description: "Shows what review_offer is about to do to a change",
		defaultMode: "report",
		groups: ["review"],
	}),
	reviewSay: declare({
		name: "review-say",
		class: "approval",
		description: "Shows a reply, comment or resolution before it posts",
		defaultMode: "report",
		groups: ["review"],
	}),
	reviewPublish: declare({
		name: "review-publish",
		class: "approval",
		description: "Shows a drafted review before it publishes",
		defaultMode: "report",
		groups: ["review"],
	}),
	slack: declare({
		name: "slack",
		class: "approval",
		description: "Asks before anything is sent to Slack",
		defaultMode: "block",
		groups: ["send"],
	}),
	google: declare({
		name: "google",
		class: "approval",
		description: "Asks before mail is sent or the calendar changes",
		defaultMode: "block",
		groups: ["send"],
	}),
	questRecord: declare({
		name: "quest-record",
		class: "redirect",
		description: "Keeps quest folders to their record's shape",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questOwnedFields: declare({
		name: "quest-owned-fields",
		class: "redirect",
		description:
			"Sends hand edits of a quest's stage, status, id or kind to the verb that owns them",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questTemp: declare({
		name: "quest-temp",
		class: "redirect",
		description: "Sends system temp writes to the quest's workspace",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questPlanStage: declare({
		name: "quest-plan-stage",
		class: "redirect",
		description:
			"Defers edits to tracked code while a plan is in think or draft",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questUntrackedTree: declare({
		name: "quest-untracked-tree",
		class: "redirect",
		description:
			"Adopts a git tree a quest in build writes into; block refuses instead",
		defaultMode: "report",
		groups: ["quest"],
	}),
	questHomeless: declare({
		name: "quest-homeless",
		class: "redirect",
		description: "Refuses a build write outside every git tree",
		defaultMode: "block",
		groups: ["quest"],
	}),
} as const;

/** Declare the named guards, as an extension does on load. */
export function declareGuards(...guards: GuardDeclaration[]): void {
	for (const guard of guards) declareGuard(guard);
}
