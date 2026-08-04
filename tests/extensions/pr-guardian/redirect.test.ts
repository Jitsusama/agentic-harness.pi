/**
 * Sending `gh pr create` to the tool that can actually reach the repo.
 *
 * Skill descriptions and a resident reminder both help somebody who
 * wonders whether another tool exists. Neither helps the case that keeps
 * happening: reaching for `gh pr create` without wondering at all, in a
 * repo whose changes GitHub cannot see, and reading "Could not resolve to
 * a PullRequest" as a wrong number.
 *
 * So the guardian says it at the moment it matters. Block once, relent on
 * a repeat exactly as the title, section and prose gates do, so it cannot
 * loop and a person who means `gh` can still have it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { PrCommand } from "../../../extensions/pr-guardian/parse.js";
import { createPrGuardian } from "../../../extensions/pr-guardian/review.js";
import {
	clearReviewProviders,
	registerReviewProvider,
} from "../../../lib/review/index.js";
import { stubProvider } from "../../lib/review/support/stub-provider.js";

const cleanBody = [
	"### 🌐 Situation",
	"The thing was broken.",
	"",
	"### 🔧 Resolution",
	"We fixed it.",
	"",
	"### 🔬 Validation",
	"A test proves it.",
].join("\n");

function prCommand(action: "create" | "edit" = "create"): PrCommand {
	return {
		action,
		title: "A Descriptive Title",
		body: cleanBody,
		prNumber: action === "edit" ? "2001696" : null,
	};
}

/** A pi/ctx pair with no UI, remembering what signatures were stored. */
function context(stored: string[] = []): {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	stored: string[];
} {
	// exec sits on the extension API, which is what the guardian factory
	// captures, rather than on the per-call context.
	const pi = {
		appendEntry: (_type: string, data: string) => {
			stored.push(data);
		},
		exec: async () => ({
			code: 0,
			stdout: "git@gitstream.shopify.io:shop/world.git",
			stderr: "",
		}),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		cwd: "/src/world",
		sessionManager: {
			getEntries: () =>
				stored.map((data) => ({
					type: "custom",
					customType: "gate-block-signature",
					data,
				})),
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, stored };
}

/** A provider that claims this checkout and can open changes. */
function hostingProvider() {
	return stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => ({ key: "meteorite:shop/world" }),
		capabilities: {
			authoring: {
				propose: true,
				proposeStack: true,
				reviewersAt: "creation",
				retarget: "stack",
				setDraft: false,
				close: true,
				reopen: false,
				merge: true,
				labels: true,
				assignees: true,
				identifies: "email",
				rerunChecks: false,
				refusesWhileEnqueued: true,
			},
		},
	});
}

afterEach(() => clearReviewProviders());

describe("redirecting gh pr create to the review tools", () => {
	it("blocks and names the tool when a provider serves the checkout", async () => {
		registerReviewProvider(hostingProvider());
		const { pi, ctx } = context();

		const result = await createPrGuardian(pi).review(prCommand(), ctx);

		expect(result && "block" in result).toBe(true);
		const reason = result && "reason" in result ? result.reason : "";
		expect(reason).toContain("review_offer");
		expect(reason).toContain("meteorite");
	});

	it("relents on a repeat, so it cannot loop", async () => {
		registerReviewProvider(hostingProvider());
		const stored: string[] = [];
		const first = context(stored);
		await createPrGuardian(first.pi).review(prCommand(), first.ctx);

		// Same command again, with the signature the first block stored.
		const second = context(stored);
		const result = await createPrGuardian(second.pi).review(
			prCommand(),
			second.ctx,
		);

		expect(result).toBeUndefined();
	});

	it("says nothing when no provider claims the checkout", async () => {
		// A plain GitHub repo, where `gh` is the right tool.
		const { pi, ctx } = context();

		const result = await createPrGuardian(pi).review(prCommand(), ctx);

		expect(result).toBeUndefined();
	});

	it("leaves an edit alone, since -R may name another repo", async () => {
		// Creating uses the branch in this checkout, so the checkout's
		// provider is the right question. An edit names a change that may
		// live anywhere, and the skills cover that case in words.
		registerReviewProvider(hostingProvider());
		const { pi, ctx } = context();

		const result = await createPrGuardian(pi).review(prCommand("edit"), ctx);

		expect(result).toBeUndefined();
	});
});
