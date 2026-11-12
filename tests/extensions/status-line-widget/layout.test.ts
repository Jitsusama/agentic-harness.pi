/**
 * pi's status line, read for what it says at each width.
 *
 * The line speaks the prompt's language: the folder told from its root,
 * the branch at the right with its marks, fields two spaces apart, each
 * shown only while it's true. As the window narrows it gives way a step at
 * a time in a written order, so these read the words at widths where each
 * step has just been taken.
 */

import { describe, expect, it } from "vitest";
import type { GitState } from "../../../extensions/status-line-widget/git.ts";
import {
	type Facts,
	layout,
	type Piece,
	STEPS,
	width,
} from "../../../extensions/status-line-widget/layout.ts";
import { told } from "../../../extensions/status-line-widget/place.ts";
import { DEFAULT_MARKS } from "../../../extensions/status-line-widget/where.ts";

const MARKS = {
	...DEFAULT_MARKS,
	branch: "B",
	thinking: "T",
};

const CLEAN: GitState = {
	workdir: "/w/src",
	branch: "jitsusama/status-line-language",
	unstaged: false,
	staged: false,
	untracked: false,
	conflicted: false,
	ahead: 0,
	behind: 0,
	op: null,
};

function facts(over: Partial<Facts> = {}): Facts {
	return {
		place: {
			lead: "",
			parts: ["dotfiles", "modules", "neovim"],
			first: "text",
		},
		git: CLEAN,
		branch: null,
		model: "claude-opus-5-5",
		thinking: "high",
		statuses: [],
		panel: null,
		context: [
			{ role: "muted", text: "◑" },
			{ role: "muted", text: " 45.2k" },
		],
		contextShare: [
			{ role: "muted", text: "◑" },
			{ role: "muted", text: " 23%" },
		],
		rate: "∂ $0.04",
		total: "Σ $1.23",
		marks: MARKS,
		...over,
	};
}

/** A status written as words, as the budget's was on 11 November. */
const WORDS = "R claude-max 82% of 5 h · resets 14:00";

function text(pieces: readonly Piece[]): string {
	return pieces.map((piece) => piece.text).join("");
}

/** Both sides as words, with a bar where the space between them falls. */
function read(f: Facts, columns: number): string {
	const { left, right } = layout(f, columns);
	return right.length > 0 ? `${text(left)} | ${text(right)}` : text(left);
}

/** The widest the line is with these steps taken, found by narrowing. */
function widthAt(f: Facts, columns: number): number {
	const { left, right } = layout(f, columns);
	return width(left) + (right.length > 0 ? 2 : 0) + width(right);
}

describe("pi's status line in a broker's worktree", () => {
	// Joel, 11 November: "the branch has its own area in the status bar
	// already", of a path area that read the broker's folder name, which
	// carries the branch too.
	const tree =
		"/h/trees/worktree-github-Jitsusama-agentic-harness.pi-feat-shell-edit-guard";
	const files: Record<string, string> = {
		[`${tree}/.git`]: "gitdir: /h/src/harness/.git/worktrees/wt\n",
		"/h/src/harness/.git/worktrees/wt/commondir": "../..\n",
		"/h/src/harness/.git/config":
			'[remote "origin"]\n\turl = git@github.com:Jitsusama/agentic-harness.pi.git\n',
	};
	const place = told(
		`${tree}/lib`,
		["zone.nix", ".git"],
		"/h",
		(file) => file === `${tree}/.git`,
		(file) => files[file] ?? null,
	);
	const line = read(
		facts({ place, git: { ...CLEAN, branch: "feat/shell-edit-guard" } }),
		200,
	);

	it("names the branch once, in its own area", () => {
		expect(
			line.split("shell-edit-guard").length - 1,
			`how often the branch is named in "${line}"`,
		).toBe(1);
	});

	it("names the repository, never the broker's folder", () => {
		expect(line, "the path area").toMatch(/^agentic-harness\.pi\/lib /);
		expect(line, "the broker's folder name").not.toContain("worktree-");
	});
});

describe("pi's status line at its full width", () => {
	it("says where, the model and how hard it thinks, the meter and the branch", () => {
		expect(read(facts(), 200)).toBe(
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04 Σ $1.23  B jitsusama/status-line-language",
		);
	});

	it("draws the folder's root in text, the folders between muted and the folder strong", () => {
		const { left } = layout(facts(), 200);

		expect(left.slice(0, 3)).toEqual([
			{ role: "text", text: "dotfiles" },
			{ role: "muted", text: "/modules/" },
			{ role: "strong", text: "neovim" },
		]);
	});

	it("colours only the thinking mark, leaving its word muted", () => {
		const { left } = layout(facts(), 200);

		expect(left).toContainEqual({ role: "thinking", text: "T" });
		expect(left).toContainEqual({ role: "muted", text: "high" });
	});

	it("says nothing of thinking while it's off", () => {
		expect(read(facts({ thinking: "off" }), 200)).not.toContain("T");
	});

	it("writes the tree's changes and the upstream in git's notation after the branch", () => {
		const git = {
			...CLEAN,
			unstaged: true,
			staged: true,
			untracked: true,
			ahead: 2,
			behind: 1,
		};

		expect(read(facts({ git }), 200)).toMatch(
			/B jitsusama\/status-line-language \*\+\? \u21912\u21931$/,
		);
	});

	it("writes only what holds, in git's order", () => {
		const ending = (over: Partial<GitState>) =>
			read(facts({ git: { ...CLEAN, ...over } }), 200).split("language")[1];

		expect(ending({ untracked: true, unstaged: true })).toBe(" *?");
		expect(ending({ staged: true })).toBe(" +");
		expect(ending({ behind: 4 })).toBe(" \u21934");
	});

	it("writes nothing after the branch when the tree is clean and in step", () => {
		expect(read(facts(), 200)).toMatch(/B jitsusama\/status-line-language$/);
	});

	it("takes pi's own branch, unmarked, when no engine has answered", () => {
		expect(read(facts({ git: null, branch: "main" }), 200)).toMatch(
			/Σ \$1\.23 {2}B main$/,
		);
	});

	it("says no branch outside a repository", () => {
		expect(read(facts({ git: null, branch: null }), 200)).toMatch(/Σ \$1\.23$/);
	});

	it("leaves the panel's height unsaid at the usual height and says it otherwise", () => {
		expect(read(facts({ panel: "■" }), 200)).toContain("| ■  ◑ 45.2k");
		expect(read(facts(), 200)).toContain("| ◑ 45.2k");
	});

	it("places each extension's mark whole, two spaces from the next", () => {
		const { right } = layout(facts({ statuses: ["⚑", "⧗ 2"] }), 200);

		expect(text(right)).toMatch(/^⚑ {2}⧗ 2 {2}◑ 45\.2k/);
		expect(right[0]).toEqual({ role: "painted", text: "⚑" });
	});
});

describe("what git is in the middle of", () => {
	it("draws a rebase as its steps, the one under way in the warning colour", () => {
		const git = { ...CLEAN, op: { name: "rebase", at: 2, of: 4 } };
		const { left } = layout(facts({ git }), 200);

		expect(text(left)).toContain("neovim  rebase ◆◈◇◇  claude");
		expect(left).toContainEqual({ role: "warning", text: "◈" });
	});

	it("draws the step under way in the alert colour while a conflict waits", () => {
		const git = {
			...CLEAN,
			conflicted: true,
			op: { name: "rebase", at: 1, of: 2 },
		};

		expect(layout(facts({ git }), 200).left).toContainEqual({
			role: "alert",
			text: "◈",
		});
	});

	it("counts a long rebase rather than drawing every step", () => {
		const git = { ...CLEAN, op: { name: "rebase", at: 3, of: 12 } };

		expect(read(facts({ git }), 200)).toContain("rebase 3/12");
	});

	it("names a merge after its mark", () => {
		const git = { ...CLEAN, op: { name: "merge" } };

		expect(read(facts({ git }), 200)).toContain("neovim  ◈ merge  claude");
	});
});

describe("pi's status line as the window narrows", () => {
	it("gives up the session's total first, leaving no mark in its place", () => {
		const full = widthAt(facts(), 300);

		expect(read(facts(), full - 1)).toBe(
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsusama/status-line-language",
		);
	});

	it("gives way in its written order, each step keeping the ones before", () => {
		const seen: string[] = [];
		for (let columns = 200; columns >= 10; columns--) {
			const line = read(facts(), columns);
			if (seen.at(-1) !== line) seen.push(line);
		}

		expect(seen).toEqual([
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04 Σ $1.23  B jitsusama/status-line-language",
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsusama/status-line-language",
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsus…anguage",
			"dotfiles/…/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsus…anguage",
			"dotfiles/…/neovim  claude-opus-5-5 T high | ◑ 23% ∂ $0.04  B jitsus…anguage",
			"dotfiles/…/neovim  opus-5-5 T high | ◑ 23% ∂ $0.04  B jitsus…anguage",
			"dotfiles/…/neovim  opus-5-5 | ◑ 23% ∂ $0.04  B jitsus…anguage",
			"dotfiles/…/neovim  opus-5-5 | ◑ 23% ∂ $0.04  B",
			"…/neovim  opus-5-5 | ◑ 23% ∂ $0.04  B",
			"…/neovim | ◑ 23% ∂ $0.04  B",
			"…/neovim | ◑ 23% ∂ $0.04",
			"neovim | ◑ 23% ∂ $0.04",
			"ne…im | ◑ 23% ∂ $0.04",
			"neovim",
		]);
	});

	it("gives up a status written as words first, and the marks one at a time after the model", () => {
		const marked = facts({ statuses: ["⚑", WORDS, "⧗ 2"], total: null });
		const seen: string[] = [];
		for (let columns = 200; columns >= 10; columns--) {
			const line = read(marked, columns);
			if (seen.at(-1) !== line) seen.push(line);
		}

		expect(seen.slice(0, 2), "words go before the line's own fields").toEqual([
			`dotfiles/modules/neovim  claude-opus-5-5 T high | ⚑  ${WORDS}  ⧗ 2  ◑ 45.2k ∂ $0.04  B jitsusama/status-line-language`,
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ⚑  ⧗ 2  ◑ 45.2k ∂ $0.04  B jitsusama/status-line-language",
		]);
		expect(seen.slice(-7), "marks go after the model, the last first").toEqual([
			"…/neovim | ⚑  ⧗ 2  ◑ 23% ∂ $0.04  B",
			"…/neovim | ⚑  ◑ 23% ∂ $0.04  B",
			"…/neovim | ◑ 23% ∂ $0.04  B",
			"…/neovim | ◑ 23% ∂ $0.04",
			"neovim | ◑ 23% ∂ $0.04",
			"ne…im | ◑ 23% ∂ $0.04",
			"neovim",
		]);
	});

	it("never draws wider than the window", () => {
		const busy = facts({
			statuses: ["⚑", "⧗ 2"],
			panel: "■",
			git: {
				...CLEAN,
				unstaged: true,
				untracked: true,
				ahead: 12,
				behind: 3,
				op: { name: "rebase", at: 2, of: 5 },
			},
		});
		for (let columns = 1; columns <= 220; columns++) {
			expect(widthAt(busy, columns)).toBeLessThanOrEqual(columns);
		}
	});

	it("keeps the rate for as long as anything but the folder's name is drawn", () => {
		for (let columns = 10; columns <= 200; columns++) {
			const { right } = layout(facts(), columns);
			if (right.length > 0) expect(text(right)).toContain("∂ $0.04");
		}
	});

	it("cuts the folder's own name in its middle when nothing else is left", () => {
		const long = facts({
			place: {
				lead: "",
				parts: ["root", "a-folder-with-a-very-long-name"],
				first: "text",
			},
		});

		expect(read(long, 12)).toBe("a-fol…g-name");
	});

	it("takes each step only where something is left to give way", () => {
		// Without a total, a branch or thinking, those steps change nothing,
		// so the line goes straight to the next that does.
		const bare = facts({ total: null, git: null, thinking: "off" });
		const seen: string[] = [];
		for (let columns = 200; columns >= 10; columns--) {
			const line = read(bare, columns);
			if (seen.at(-1) !== line) seen.push(line);
		}

		expect(seen).toEqual([
			"dotfiles/modules/neovim  claude-opus-5-5 | ◑ 45.2k ∂ $0.04",
			"dotfiles/…/neovim  claude-opus-5-5 | ◑ 45.2k ∂ $0.04",
			"dotfiles/…/neovim  claude-opus-5-5 | ◑ 23% ∂ $0.04",
			"dotfiles/…/neovim  opus-5-5 | ◑ 23% ∂ $0.04",
			"…/neovim  opus-5-5 | ◑ 23% ∂ $0.04",
			"…/neovim | ◑ 23% ∂ $0.04",
			"neovim | ◑ 23% ∂ $0.04",
			"ne…im | ◑ 23% ∂ $0.04",
			"neovim",
		]);
		expect(STEPS[0], "words give way before anything else").toBe("words");
	});
});

describe("pi's status line in Joel's windows", () => {
	// kitty's windows on optimus at 21:05 on 11 November: 78 at 76 columns
	// and one at 134. At 76, with the budget's and mesh quiet's words, the
	// line was the word dotfiles alone.
	const his = facts({
		place: { lead: "", parts: ["dotfiles"], first: "text" },
		git: { ...CLEAN, branch: "main", unstaged: true },
		statuses: [
			"⚑",
			WORDS,
			"mesh quiet · 3 peer notes kept off screen · ctrl+o opens",
		],
	});

	it.each([
		76, 134,
	])("keeps where, the model, the rate and the branch at %i columns", (columns) => {
		const line = read(his, columns);

		for (const kept of ["dotfiles", "opus-5-5", "∂ $0.04", "B main *", "⚑"]) {
			expect(line, `${kept} at ${columns} columns`).toContain(kept);
		}
		expect(
			widthAt(his, columns),
			"no wider than the window",
		).toBeLessThanOrEqual(columns);
	});

	it("is never the folder's name alone while the rate fits beside it", () => {
		for (let columns = 24; columns <= 220; columns++) {
			expect(read(his, columns), `at ${columns} columns`).toContain("∂ $0.04");
			expect(
				widthAt(his, columns),
				`at ${columns} columns`,
			).toBeLessThanOrEqual(columns);
		}
	});
});
