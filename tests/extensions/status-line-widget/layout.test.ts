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
import { DEFAULT_MARKS } from "../../../extensions/status-line-widget/where.ts";

const MARKS = {
	...DEFAULT_MARKS,
	branch: "B",
	unsaved: "●",
	unpushed: "U",
	thinking: "T",
};

const CLEAN: GitState = {
	workdir: "/w/src",
	branch: "jitsusama/status-line-language",
	unsaved: false,
	conflicted: false,
	ahead: false,
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

	it("marks unsaved and unpushed work after the branch", () => {
		const git = { ...CLEAN, unsaved: true, ahead: true };

		expect(
			read(facts({ git }), 200).endsWith(
				"B jitsusama/status-line-language ● U",
			),
		).toBe(true);
	});

	it("takes pi's own branch, unmarked, when no engine has answered", () => {
		expect(
			read(facts({ git: null, branch: "main" }), 200).endsWith(
				"Σ $1.23  B main",
			),
		).toBe(true);
	});

	it("says no branch outside a repository", () => {
		expect(
			read(facts({ git: null, branch: null }), 200).endsWith("Σ $1.23"),
		).toBe(true);
	});

	it("leaves the panel's height unsaid at the usual height and says it otherwise", () => {
		expect(read(facts({ panel: "■" }), 200)).toContain("| ■  ◑ 45.2k");
		expect(read(facts(), 200)).toContain("| ◑ 45.2k");
	});

	it("places each extension's mark whole, two spaces from the next", () => {
		const { right } = layout(facts({ statuses: ["⚑", "⧗ 2"] }), 200);

		expect(text(right).startsWith("⚑  ⧗ 2  ◑ 45.2k")).toBe(true);
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
	it("gives up the session's total first, marking that something is hidden", () => {
		const full = widthAt(facts(), 300);

		expect(read(facts(), full - 1)).toBe(
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsusama/status-line-language  …",
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
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsusama/status-line-language  …",
			"dotfiles/modules/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsus…anguage  …",
			"dotfiles/…/neovim  claude-opus-5-5 T high | ◑ 45.2k ∂ $0.04  B jitsus…anguage  …",
			"dotfiles/…/neovim  claude-opus-5-5 T high | ◑ 23% ∂ $0.04  B jitsus…anguage  …",
			"dotfiles/…/neovim  opus-5-5 T high | ◑ 23% ∂ $0.04  B jitsus…anguage  …",
			"dotfiles/…/neovim  opus-5-5 | ◑ 23% ∂ $0.04  B jitsus…anguage  …",
			"dotfiles/…/neovim  opus-5-5 | ◑ 23% ∂ $0.04  B  …",
			"…/neovim  opus-5-5 | ◑ 23% ∂ $0.04  B  …",
			"…/neovim | ◑ 23% ∂ $0.04  B  …",
			"neovim",
		]);
	});

	it("never draws wider than the window", () => {
		const busy = facts({
			statuses: ["⚑", "⧗ 2"],
			panel: "■",
			git: {
				...CLEAN,
				unsaved: true,
				ahead: true,
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
			"…/neovim | ◑ 23% ∂ $0.04  …",
			"neovim",
		]);
		expect(STEPS[0]).toBe("total");
	});
});
