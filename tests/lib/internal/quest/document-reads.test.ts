import { describe, expect, it } from "vitest";
import {
	documentRead,
	documentReadReason,
} from "../../../../lib/internal/quest/document-reads.ts";

const HOME = "/home/someone";
const QUESTS = `${HOME}/.local/share/pi/agentic-harness.pi/quest-workflow/quests`;
const PLAN = `${QUESTS}/QEST-20261025-85PKB2/plans/PLAN-20261025-QR647O.md`;
const shell = (command: string) =>
	documentRead("bash", { command }, HOME, HOME);

describe("which calls read a quest document the costly way", () => {
	it("knows a shell search or print of a document, by its id", () => {
		expect(shell(`grep -n "^## " ${PLAN}`)).toEqual({
			id: "PLAN-20261025-QR647O",
			how: "shell",
		});
		expect(
			shell(
				"sed -n '/^## /,$p' ~/.local/share/pi/agentic-harness.pi/quest-workflow/quests/QEST-20261025-85PKB2/research/RSCH-20261025-FUKUC5.md | head -90",
			),
		).toEqual({ id: "RSCH-20261025-FUKUC5", how: "shell" });
		expect(shell(`f=${PLAN}; wc -l $f; grep -n "^### " $f`)?.id).toBe(
			"PLAN-20261025-QR647O",
		);
	});

	it("knows a read of a whole document, from any spelling of its path", () => {
		expect(documentRead("read", { path: PLAN }, "/x", HOME)).toEqual({
			id: "PLAN-20261025-QR647O",
			how: "whole",
		});
		expect(
			documentRead(
				"read",
				{
					path: "~/.local/share/pi/agentic-harness.pi/quest-workflow/quests/QEST-20261025-QCXZEB/plans/PLAN-20261025-FZUA02.md",
				},
				"/x",
				HOME,
			)?.id,
		).toBe("PLAN-20261025-FZUA02");
	});

	it("knows a quests folder kept elsewhere, however a command spells it", () => {
		const root = `${HOME}/notes/quests`;
		const doc = "QEST-20261025-QCXZEB/plans/PLAN-20261025-FZUA02.md";
		for (const spelled of [
			`${root}/${doc}`,
			`~/notes/quests/${doc}`,
			`$HOME/notes/quests/${doc}`,
		]) {
			expect(
				documentRead("bash", { command: `cat ${spelled}` }, HOME, HOME, root)
					?.id,
				spelled,
			).toBe("PLAN-20261025-FZUA02");
		}
		expect(
			documentRead(
				"bash",
				{ command: `cat ~/notes/quests/${doc}` },
				HOME,
				HOME,
			),
		).toBeUndefined();
	});

	it("leaves alone what is not a costly read of a document", () => {
		expect(
			documentRead("read", { path: PLAN, offset: 10, limit: 40 }, "/x", HOME),
		).toBeUndefined();
		for (const command of [
			`ls ${QUESTS}/QEST-20261025-85PKB2/plans`,
			`grep -n x ${QUESTS}/QEST-20261025-85PKB2/README.md`,
			`sed -i 's/a/b/' ${PLAN}`,
			`cat > $TMPDIR/note.md <<'EOF'\ngrep -n x ${PLAN}\nEOF`,
			"grep -rn PLAN-20261025-QR647O lib",
		]) {
			expect(shell(command), command).toBeUndefined();
		}
		expect(documentRead("edit", { path: PLAN }, "/x", HOME)).toBeUndefined();
	});

	it("names the quest tool's call that answers instead", () => {
		const reason = documentReadReason({
			id: "PLAN-20261025-QR647O",
			how: "shell",
		});
		expect(reason).toContain("reads PLAN-20261025-QR647O from the shell");
		expect(reason).toContain("`quest show` with id PLAN-20261025-QR647O");
	});
});
