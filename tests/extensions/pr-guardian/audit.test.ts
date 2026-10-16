import { composePrBody } from "@jitsusama/agentic-harness.core/sections";
import { describe, expect, it } from "vitest";
import { auditPublished } from "../../../extensions/pr-guardian/audit.ts";

const SECTIONS = {
	tldr: "Merging with a short commit id now works the first time.",
	problem: "Merging failed 23 times because GitHub wants the full id.",
	solution: "Merge expands a short id before it asks GitHub.",
	validation: "A test sends a short id and checks the full one arrives.",
};

function gh(action: "create" | "edit", body: string): string {
	const target = action === "edit" ? " 12" : "";
	return `gh pr ${action}${target} --title "Merge Short Ids" --body-file - <<'EOF'\n${body}\nEOF`;
}

const long = `${Array.from({ length: 60 }, () => "word").join(" ")}.`;

describe("auditing a published PR description", () => {
	it("says nothing about a description in its shape", () => {
		expect(
			auditPublished(gh("create", composePrBody(SECTIONS)), new Set()),
		).toBe(undefined);
	});

	it("says nothing about a command that is not a PR", () => {
		expect(auditPublished("git status", new Set())).toBeUndefined();
	});

	it("names what is wrong and the tool to fix it with", () => {
		const audit = auditPublished(
			gh("edit", composePrBody({ ...SECTIONS, tldr: long })),
			new Set(),
		);
		expect(audit?.message).toContain("#12");
		expect(audit?.message).toContain("TL;DR is 60 words");
		expect(audit?.message).toContain("review_offer edit");
	});

	it("catches the retired three-section shape", () => {
		const audit = auditPublished(
			gh("create", "### Situation\n\nOld.\n\n### Resolution\n\nOld."),
			new Set(),
		);
		expect(audit?.message).toContain("TL;DR");
	});

	it("says each description's problems once", () => {
		const command = gh("create", composePrBody({ ...SECTIONS, tldr: long }));
		const first = auditPublished(command, new Set());
		expect(first).toBeDefined();
		const said = new Set([first?.signature ?? ""]);
		expect(auditPublished(command, said)).toBeUndefined();
	});
});
