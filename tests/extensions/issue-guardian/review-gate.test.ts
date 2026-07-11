import { describe, expect, it } from "vitest";
import { createIssueGuardian } from "../../../extensions/issue-guardian/review.js";

// Derive the pi and context types from the factory so the test never
// imports the pi package directly (which does not resolve for test
// files under this tsconfig).
type Guardian = ReturnType<typeof createIssueGuardian>;
type Pi = Parameters<typeof createIssueGuardian>[0];
type Ctx = Parameters<NonNullable<Guardian["review"]>>[1];

function fakePi(): Pi {
	return { appendEntry: () => {} } as unknown as Pi;
}

function fakeCtx(hasUI: boolean): Ctx {
	return {
		hasUI,
		sessionManager: { getEntries: () => [] },
	} as unknown as Ctx;
}

const VALID_BODY = [
	"### 🌐 Situation",
	"The thing is broken.",
	"",
	"### 🎯 Outcome",
	"The thing works.",
	"",
	"### ✅ Acceptance",
	"The test passes.",
].join("\n");

async function review(title: string, body: string, ctx: Ctx) {
	const guardian = createIssueGuardian(fakePi());
	if (!guardian.review) throw new Error("guardian has no review step");
	return guardian.review(
		{ action: "create", title, body, issueNumber: null },
		ctx,
	);
}

describe("issue guardian review gate", () => {
	it("blocks a body missing the sanctioned sections", async () => {
		const result = await review(
			"Add Rate Limiting to Prevent API Abuse",
			"just plain text with no headings",
			fakeCtx(true),
		);

		expect(result).toMatchObject({ block: true });
	});

	it("blocks a prose violation once the sections pass", async () => {
		const result = await review(
			"Add Rate Limiting to Prevent API Abuse",
			VALID_BODY.replace("The thing works.", "The thing works \u2014 mostly."),
			fakeCtx(true),
		);

		expect(result).toMatchObject({ block: true });
	});

	it("allows a well-formed issue headlessly without stalling", async () => {
		const result = await review(
			"Add Rate Limiting to Prevent API Abuse",
			VALID_BODY,
			fakeCtx(false),
		);

		expect(result).toBeUndefined();
	});
});
