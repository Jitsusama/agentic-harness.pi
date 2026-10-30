/**
 * Every guard this package declares, in one place.
 *
 * Each extension declares the guards it fires on load, so a guard's
 * default holds whether or not the policy workflow is installed: a name
 * nobody declared resolves to block. Keeping the declarations here means
 * two extensions sharing a guard (the prose gate, say) declare the same
 * thing, and `/guards` lists one entry for it.
 *
 * Defaults follow one rule: a guard blocks where a mistake reaches other
 * people, cannot be undone, or has one right form, and redirects
 * everywhere else. So an approval that only lands on this machine or on
 * a change the owner controls redirects, going ahead and showing the
 * person what it would have asked; one that reaches other people
 * directly (Slack, mail, calendar) blocks. A form guard blocks, since a
 * PR, issue or commit is read by others and its refusal says exactly how
 * to retry. A safety guard blocks only what cannot be brought back.
 *
 * The rest redirect: the agent hears the refusal and its remedy in its
 * own tool result, and a call made again unchanged goes through as an
 * override, so a guard that is wrong about a write cannot corner it.
 * That is where the quest's write gates sit, since most of what they
 * refused since June was work that was fine.
 */

import { declareGuard, type GuardDeclaration } from "../../guardian/policy.ts";

const declare = (d: GuardDeclaration) => d;

/** The package's guards, by name. */
export const GUARDS = {
	commit: declare({
		name: "commit",
		class: "approval",
		description: "Shows a commit message before git commit runs",
		defaultMode: "redirect",
		groups: ["git"],
	}),
	commitVerification: declare({
		name: "commit-verification",
		class: "form",
		description: "Refuses a commit while verification reports errors",
		// A commit stays on this machine and is amended in a moment, and
		// the errors it names are sometimes stale, so the agent hears them
		// and may go ahead rather than being stopped outright.
		defaultMode: "redirect",
		groups: ["git"],
	}),
	history: declare({
		name: "history",
		class: "safety",
		description: "Shows a rebase, stash drop or leased force push",
		defaultMode: "redirect",
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
		class: "form",
		description:
			"Refuses an amend and an unquoted commit heredoc, naming the form to retry",
		defaultMode: "block",
		groups: ["git"],
	}),
	gitCli: declare({
		name: "git-cli",
		class: "form",
		description:
			"Splits a chained commit, gh pr or gh issue so each panel shows one",
		defaultMode: "block",
		groups: ["git"],
		follows: ["commit", "pr", "issue"],
	}),
	stash: declare({
		name: "stash",
		class: "form",
		description: "Refuses git stash saving work, pointing at a branch instead",
		// A stash is undone by popping it, so the agent hears the remedy
		// and a repeat goes ahead.
		defaultMode: "redirect",
		groups: ["git", "shell"],
	}),
	shellEdit: declare({
		name: "shell-edit",
		class: "form",
		description:
			"Refuses a shell rewrite of a tracked file, pointing at edit and write",
		// A repeat goes ahead: a generated file is sometimes tracked, and
		// rewriting it whole from the shell is then the point.
		defaultMode: "redirect",
		groups: ["shell"],
	}),
	sleep: declare({
		name: "sleep",
		class: "form",
		description:
			"Refuses a sleep of ten seconds or more, pointing at background work",
		defaultMode: "redirect",
		groups: ["shell"],
	}),
	mixedTurn: declare({
		name: "mixed-turn",
		class: "form",
		description:
			"Refuses VM work chained after a build in one call, which holds a VM slot through the build, printing the split",
		defaultMode: "redirect",
		groups: ["shell"],
	}),
	pr: declare({
		name: "pr",
		class: "approval",
		description: "Shows a pull request's title and body before gh pr runs",
		defaultMode: "redirect",
		groups: ["github"],
	}),
	issue: declare({
		name: "issue",
		class: "approval",
		description: "Shows an issue's title and body before gh issue runs",
		defaultMode: "redirect",
		groups: ["github"],
	}),
	host: declare({
		name: "host",
		class: "form",
		description: "Sends a change on a host gh cannot see to the review tools",
		defaultMode: "block",
		groups: ["github"],
	}),
	githubCli: declare({
		name: "github-cli",
		class: "form",
		description: "Holds gh bodies to the shapes the guardians can read",
		defaultMode: "block",
		groups: ["github"],
	}),
	attribution: declare({
		name: "attribution",
		class: "form",
		description: "Refuses a gh command it cannot attribute",
		defaultMode: "block",
		groups: ["github"],
	}),
	prose: declare({
		name: "prose",
		class: "form",
		description: "Refuses authored text that breaks the prose standard",
		defaultMode: "block",
		groups: ["format"],
	}),
	sections: declare({
		name: "sections",
		class: "form",
		description:
			"Refuses a PR or issue body without its sections, or a PR section out of its shape",
		defaultMode: "block",
		groups: ["format"],
	}),
	titles: declare({
		name: "titles",
		class: "form",
		description: "Refuses a PR or issue title out of its convention",
		defaultMode: "block",
		groups: ["format"],
	}),
	reviewOffer: declare({
		name: "review-offer",
		class: "approval",
		description: "Shows what review_offer is about to do to a change",
		defaultMode: "redirect",
		groups: ["review"],
	}),
	reviewSay: declare({
		name: "review-say",
		class: "approval",
		description: "Shows a reply, comment or resolution before it posts",
		defaultMode: "redirect",
		groups: ["review"],
	}),
	reviewPublish: declare({
		name: "review-publish",
		class: "approval",
		description: "Shows a drafted review before it publishes",
		defaultMode: "redirect",
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
	// Only a hold's sender may otherwise end it, so this one asks: the
	// agent says it has the person's word, and only the person can say so.
	meshEndHold: declare({
		name: "mesh-end-hold",
		class: "approval",
		description: "Asks before ending another session's hold on your word",
		defaultMode: "block",
		groups: ["send"],
	}),
	questRecord: declare({
		name: "quest-record",
		class: "form",
		description: "Keeps quest folders to their record's shape",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questOwnedFields: declare({
		name: "quest-owned-fields",
		class: "form",
		description:
			"Sends hand edits of a quest's stage, status, id or kind to the verb that owns them",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questDocumentRead: declare({
		name: "quest-document-read",
		class: "form",
		description:
			"Sends a shell search or whole read of a quest document to quest show",
		// A repeat goes ahead: a session that needs the raw file, to check
		// what the quest tool wrote, says so by asking again.
		defaultMode: "redirect",
		groups: ["quest"],
	}),
	questTemp: declare({
		name: "quest-temp",
		class: "form",
		description: "Sends system temp writes to the quest's workspace",
		defaultMode: "redirect",
		groups: ["quest"],
	}),
	questPlanStage: declare({
		name: "quest-plan-stage",
		class: "form",
		description:
			"Defers edits to tracked code while a plan is in think or draft",
		defaultMode: "block",
		groups: ["quest"],
	}),
	questUntrackedTree: declare({
		name: "quest-untracked-tree",
		class: "form",
		description:
			"Adopts a git tree a quest in build writes into; block refuses instead",
		defaultMode: "redirect",
		groups: ["quest"],
	}),
	questHomeless: declare({
		name: "quest-homeless",
		class: "form",
		description: "Refuses a build write outside every git tree",
		defaultMode: "redirect",
		groups: ["quest"],
	}),
	// A VM here only slows this machine, and the refusal says how to send
	// it, so a run that truly needs this machine goes ahead when made again.
	vmHere: declare({
		name: "vm-here",
		class: "form",
		description:
			"Refuses a public repo's VM check or test the builder could take but the interceptor can't send",
		defaultMode: "redirect",
		groups: ["shell"],
	}),
} as const;

/** Declare the named guards, as an extension does on load. */
export function declareGuards(...guards: GuardDeclaration[]): void {
	for (const guard of guards) declareGuard(guard);
}
