import { describe, expect, it } from "vitest";
import type { Proposal } from "../../../lib/review/index.js";
import {
	auditPrompt,
	councilPrompt,
	critiquePrompt,
	judgePrompt,
	parseUnifiedDiff,
	stackPrompt,
} from "../../../lib/review/index.js";

// A valid hunk: the header promises two old lines and three new
// ones, so the body has to deliver them. An earlier version of this
// fixture stopped after the addition, and the ranges it produced
// were correct about a diff that could not exist.
const diff = parseUnifiedDiff(`diff --git a/lib/a.ts b/lib/a.ts
--- a/lib/a.ts
+++ b/lib/a.ts
@@ -10,2 +10,3 @@ function held() {
 const before = 1;
+const added = 2;
 const after = 3;
`);

function proposal(over: Partial<Proposal> = {}): Proposal {
	return {
		ref: {
			provider: "github",
			repo: { key: "github:Shopify/world" },
			id: "42",
			label: "Shopify/world#42",
		},
		title: "Close the handle",
		body: "It leaked on the error path.",
		state: "open",
		draft: false,
		author: { id: "evan", name: "evan" },
		base: "main",
		head: "topic",
		...over,
	};
}

describe("what a discovery reviewer is told", () => {
	it("carries the title and body the author wrote", () => {
		const prompt = councilPrompt({ proposal: proposal(), diff });

		expect(prompt).toContain("Close the handle");
		expect(prompt).toContain("It leaked on the error path.");
	});

	it("carries the diff", () => {
		expect(councilPrompt({ proposal: proposal(), diff })).toContain(
			"+const added = 2;",
		);
	});

	it("says where an anchor may land", () => {
		// Without this a reviewer names a line it read in the file and
		// the anchor degrades for nothing.
		expect(councilPrompt({ proposal: proposal(), diff })).toContain(
			"lib/a.ts: new 10-12 | old 10-11",
		);
	});

	it("says what happens to a finding that anchors elsewhere", () => {
		// Telling a reviewer the rule without the consequence invites it
		// to treat the rule as advisory.
		expect(councilPrompt({ proposal: proposal(), diff })).toMatch(
			/degrade|as a whole/i,
		);
	});

	it("does not spell out the JSON, which the skill owns", () => {
		// A contract in two places drifts, and the copy in the prompt is
		// the one nobody updates.
		const prompt = councilPrompt({ proposal: proposal(), diff });

		expect(prompt).not.toContain('"location"');
		expect(prompt).toMatch(/output contract/i);
	});

	it("tells a reviewer with nothing to say how to answer", () => {
		// Otherwise a clean review comes back as prose and reads as a
		// parse failure.
		expect(councilPrompt({ proposal: proposal(), diff })).toMatch(
			/empty findings list/i,
		);
	});

	it("survives a change with no body", () => {
		const prompt = councilPrompt({ proposal: proposal({ body: "" }), diff });

		expect(prompt).toContain("Close the handle");
		expect(prompt).not.toMatch(/described it/i);
	});

	it("says so when a change has no title", () => {
		expect(
			councilPrompt({ proposal: proposal({ title: "" }), diff }),
		).toContain("(no title)");
	});

	it("carries a per-pass intent when it is given one", () => {
		const prompt = councilPrompt({
			proposal: proposal(),
			diff,
			intent: "look hardest at the error paths",
		});

		expect(prompt).toContain("look hardest at the error paths");
	});

	it("leaves the intent section out entirely when there is none", () => {
		expect(councilPrompt({ proposal: proposal(), diff })).not.toMatch(
			/For this pass in particular/,
		);
	});

	it("leaves it out for a blank intent rather than showing an empty heading", () => {
		expect(
			councilPrompt({ proposal: proposal(), diff, intent: "   " }),
		).not.toMatch(/For this pass in particular/);
	});
});

describe("what a judge is told", () => {
	it("carries what the reviewers said", () => {
		const prompt = judgePrompt({
			proposal: proposal(),
			diff,
			findings: "[F1] hawk: this leaks",
		});

		expect(prompt).toContain("[F1] hawk: this leaks");
	});

	it("asks for the agreement to be recorded", () => {
		// The judge is the only pass that knows two reviewers found the
		// same thing, so if it does not say, nothing can.
		expect(
			judgePrompt({ proposal: proposal(), diff, findings: "x" }),
		).toContain("raisedBy");
	});

	it("tells the judge it may drop a finding entirely", () => {
		expect(judgePrompt({ proposal: proposal(), diff, findings: "x" })).toMatch(
			/drop/i,
		);
	});

	it("says plainly when the council raised nothing", () => {
		// An empty section would read as a rendering bug and invite the
		// judge to invent findings.
		expect(judgePrompt({ proposal: proposal(), diff, findings: "  " })).toMatch(
			/nothing was raised/i,
		);
	});

	it("still says where an anchor may land", () => {
		// A judge rewrites anchors as it merges findings, so it needs the
		// ranges as much as a reviewer does.
		expect(
			judgePrompt({ proposal: proposal(), diff, findings: "x" }),
		).toContain("lib/a.ts: new 10-12");
	});
});

describe("what a critic is told", () => {
	it("carries the findings put to it", () => {
		expect(
			critiquePrompt({
				proposal: proposal(),
				diff,
				findings: "[F7] this leaks",
			}),
		).toContain("[F7] this leaks");
	});

	it("names every position it may take", () => {
		const prompt = critiquePrompt({
			proposal: proposal(),
			diff,
			findings: "x",
		});

		for (const position of ["agree", "disagree", "qualify", "unsure"]) {
			expect(prompt, position).toContain(position);
		}
	});

	it("says silence is not agreement", () => {
		// The critic has to know there is no cost to leaving a finding
		// out, or it will guess to look thorough and manufacture the
		// consensus the round exists to test.
		expect(
			critiquePrompt({ proposal: proposal(), diff, findings: "x" }),
		).toMatch(/silence/i);
	});

	it("says a rationale is the whole value", () => {
		expect(
			critiquePrompt({ proposal: proposal(), diff, findings: "x" }),
		).toMatch(/rationale/i);
	});

	it("tells the critic it is not raising findings", () => {
		expect(
			critiquePrompt({ proposal: proposal(), diff, findings: "x" }),
		).toMatch(/not raising new findings/i);
	});

	it("says plainly when there is nothing to challenge", () => {
		expect(
			critiquePrompt({ proposal: proposal(), diff, findings: " " }),
		).toMatch(/nothing to challenge/i);
	});
});

describe("what a stack-wide reviewer is told", () => {
	const changes = [
		{ ref: "refs/heads/base", proposal: proposal(), diff },
		{ ref: "refs/heads/tip", proposal: proposal(), diff },
	];

	it("names every change by the ref a finding refers to it by", () => {
		const prompt = stackPrompt({ changes });

		expect(prompt).toContain("refs/heads/base");
		expect(prompt).toContain("refs/heads/tip");
	});

	it("keeps the changes in the order they apply", () => {
		const prompt = stackPrompt({ changes });

		expect(prompt.indexOf("refs/heads/base")).toBeLessThan(
			prompt.indexOf("refs/heads/tip"),
		);
	});

	it("tells the reviewer a spanning finding stays one finding", () => {
		// The failure this round exists to avoid: one observation reported
		// three times as three unrelated findings.
		expect(stackPrompt({ changes })).toMatch(/stays one finding/i);
	});

	it("asks for per-change findings too", () => {
		// A stack pass that only reports cross-change findings is half a
		// review, and a reviewer told only about spans will produce one.
		expect(stackPrompt({ changes })).toMatch(/on its own merits/i);
	});

	it("says to check whether a later change already fixes it", () => {
		expect(stackPrompt({ changes })).toMatch(/later change/i);
	});

	it("carries the intent when one is given", () => {
		expect(
			stackPrompt({ changes, intent: "watch the migration split" }),
		).toContain("watch the migration split");
	});
});

describe("what an auditor is told", () => {
	it("carries the threads put to it", () => {
		expect(
			auditPrompt({
				proposal: proposal(),
				diff,
				threads: "[T2] evan: this leaks",
			}),
		).toContain("[T2] evan: this leaks");
	});

	it("explains why elsewhere is its own answer", () => {
		// Folding it into addressed would send somebody looking in the
		// wrong diff, which is the specific harm worth naming.
		expect(auditPrompt({ proposal: proposal(), diff, threads: "x" })).toMatch(
			/stack|wrong diff/i,
		);
	});

	it("says unclear beats a guess", () => {
		expect(auditPrompt({ proposal: proposal(), diff, threads: "x" })).toMatch(
			/better than a guess/i,
		);
	});

	it("tells the auditor it is not replying to anybody", () => {
		// The reply stays a human decision. An auditor that thought it
		// was answering would write to the author rather than to us.
		expect(auditPrompt({ proposal: proposal(), diff, threads: "x" })).toMatch(
			/not replying/i,
		);
	});

	it("carries the stack when the change sits in one", () => {
		expect(
			auditPrompt({
				proposal: proposal(),
				diff,
				threads: "x",
				stack: "world#41 then world#42",
			}),
		).toContain("world#41 then world#42");
	});

	it("leaves the stack section out when there is none", () => {
		expect(
			auditPrompt({ proposal: proposal(), diff, threads: "x" }),
		).not.toMatch(/rest of the stack/i);
	});

	it("says plainly when there is nothing to weigh", () => {
		expect(auditPrompt({ proposal: proposal(), diff, threads: " " })).toMatch(
			/nothing to weigh/i,
		);
	});
});

describe("a change with no diff at all", () => {
	it("says so rather than showing an empty section", () => {
		const empty = parseUnifiedDiff("");

		expect(councilPrompt({ proposal: proposal(), diff: empty })).toContain(
			"(no files changed)",
		);
	});

	it("still tells the reviewer anchoring is impossible", () => {
		const empty = parseUnifiedDiff("");

		expect(councilPrompt({ proposal: proposal(), diff: empty })).toMatch(
			/no line in this change/i,
		);
	});
});
