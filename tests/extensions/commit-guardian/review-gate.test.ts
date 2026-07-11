import { afterEach, describe, expect, it } from "vitest";
import { createCommitGuardian } from "../../../extensions/commit-guardian/review.js";
import { setVerificationFailing } from "../../../lib/internal/verification/signal.js";

// Derive the pi and context types from the factory so the test never
// imports the pi package directly (which does not resolve for test
// files under this tsconfig).
type Guardian = ReturnType<typeof createCommitGuardian>;
type Pi = Parameters<typeof createCommitGuardian>[0];
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

async function review(message: string, ctx: Ctx) {
	const guardian = createCommitGuardian(fakePi());
	if (!guardian.review) throw new Error("guardian has no review step");
	return guardian.review({ message, isAmend: false }, ctx);
}

afterEach(() => setVerificationFailing(false));

describe("commit guardian review gate", () => {
	it("blocks with the bypass hint when verification is failing, even headless", async () => {
		setVerificationFailing(true);

		const result = await review("feat: x\n\nbody", fakeCtx(false));

		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("bypass");
	});

	it("blocks a prose violation before the review panel", async () => {
		const result = await review(
			"feat: x\n\nthis body uses an emdash \u2014 which prose bans",
			fakeCtx(true),
		);

		expect(result).toMatchObject({ block: true });
	});

	it("allows a clean commit headlessly without stalling", async () => {
		const result = await review(
			"docs: clarify setup\n\nThis explains the steps.",
			fakeCtx(false),
		);

		expect(result).toBeUndefined();
	});
});
