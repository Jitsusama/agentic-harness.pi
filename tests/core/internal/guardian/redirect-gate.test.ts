import { afterEach, describe, expect, it } from "vitest";
import { runRedirectGate } from "../../../../lib/core/internal/guardian/redirect-gate.ts";
import type { AuthoringCapabilities } from "../../../../lib/core/review/index.ts";
import {
	clearReviewProviders,
	registerReviewProvider,
} from "../../../../lib/core/review/index.ts";
import type { GateDeps } from "../../../../lib/gate/index.ts";
import { stubProvider } from "../../../support/stub-provider.ts";

afterEach(() => {
	clearReviewProviders();
});

/** A provider that can open a change, for the redirect to point at. */
const CAN_PROPOSE: AuthoringCapabilities = {
	propose: true,
	proposeStack: false,
	reviewersAt: "never",
	retarget: "never",
	setDraft: false,
	close: false,
	reopen: false,
	merge: false,
	labels: false,
	assignees: false,
	identifies: "unknown",
	rerunChecks: false,
	refusesWhileEnqueued: false,
};

/** A signature store nothing has blocked yet, that records what blocks. */
function freshDeps(): GateDeps & { blocked: string[] } {
	const blocked: string[] = [];
	return {
		blocked,
		readSignatures: () => blocked,
		persistSignature: (signature: string) => {
			blocked.push(signature);
		},
	};
}

/** A fake exec answering `git remote get-url origin` with one URL. */
function execReturning(url: string | undefined) {
	return async (_command: string, _args: string[]) => ({
		code: url === undefined ? 1 : 0,
		stdout: url ?? "",
		stderr: "",
	});
}

describe("redirecting gh pr create to a repo's own provider", () => {
	it("does nothing to an edit, only a create", async () => {
		registerReviewProvider(
			stubProvider({
				id: "meteorite",
				priority: 10,
				claimRepo: () => ({ key: "meteorite:world", remoteUrls: [] }),
				capabilities: { authoring: CAN_PROPOSE },
			}),
		);

		const result = await runRedirectGate(freshDeps(), {
			action: "edit",
			cwd: "/repo",
			exec: execReturning("git@example.com:world.git"),
		});

		expect(result).toBeUndefined();
	});

	it("does nothing without a directory or a way to ask git", async () => {
		expect(
			await runRedirectGate(freshDeps(), {
				action: "create",
				cwd: undefined,
				exec: execReturning("git@example.com:world.git"),
			}),
		).toBeUndefined();
		expect(
			await runRedirectGate(freshDeps(), {
				action: "create",
				cwd: "/repo",
				exec: undefined,
			}),
		).toBeUndefined();
	});

	it("does nothing when the checkout has no remote", async () => {
		const result = await runRedirectGate(freshDeps(), {
			action: "create",
			cwd: "/repo",
			exec: execReturning(undefined),
		});

		expect(result).toBeUndefined();
	});

	it("does nothing when nothing is registered for this repo", async () => {
		const result = await runRedirectGate(freshDeps(), {
			action: "create",
			cwd: "/repo",
			exec: execReturning("git@example.com:nowhere.git"),
		});

		expect(result).toBeUndefined();
	});

	it("does not redirect a repo GitHub itself serves", async () => {
		// Redirecting a repo the "github" provider claims would say "served
		// by the github provider, not by GitHub", which contradicts itself.
		registerReviewProvider(
			stubProvider({
				id: "github",
				priority: 10,
				claimRepo: () => ({ key: "github:o/r", remoteUrls: [] }),
				capabilities: { authoring: CAN_PROPOSE },
			}),
		);

		const result = await runRedirectGate(freshDeps(), {
			action: "create",
			cwd: "/repo",
			exec: execReturning("git@github.com:o/r.git"),
		});

		expect(result).toBeUndefined();
	});

	it("does not redirect to a provider that cannot open a change", async () => {
		registerReviewProvider(
			stubProvider({
				id: "readonly",
				priority: 10,
				claimRepo: () => ({ key: "readonly:o/r", remoteUrls: [] }),
				// No authoring facet at all: cannot propose.
			}),
		);

		const result = await runRedirectGate(freshDeps(), {
			action: "create",
			cwd: "/repo",
			exec: execReturning("git@example.com:o/r.git"),
		});

		expect(result).toBeUndefined();
	});

	it("blocks a create against a repo another provider serves", async () => {
		registerReviewProvider(
			stubProvider({
				id: "meteorite",
				priority: 10,
				claimRepo: () => ({ key: "meteorite:world", remoteUrls: [] }),
				capabilities: { authoring: CAN_PROPOSE },
			}),
		);

		const result = await runRedirectGate(freshDeps(), {
			action: "create",
			cwd: "/repo",
			exec: execReturning("git@example.com:world.git"),
		});

		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("meteorite"),
		});
		expect((result as { reason: string }).reason).toContain(
			"review_offer propose",
		);
	});

	it("relents once the same redirect has been blocked before", async () => {
		registerReviewProvider(
			stubProvider({
				id: "meteorite",
				priority: 10,
				claimRepo: () => ({ key: "meteorite:world", remoteUrls: [] }),
				capabilities: { authoring: CAN_PROPOSE },
			}),
		);
		const deps = freshDeps();
		const subject = {
			action: "create",
			cwd: "/repo",
			exec: execReturning("git@example.com:world.git"),
		};

		const first = await runRedirectGate(deps, subject);
		expect(first).toMatchObject({ block: true });

		const second = await runRedirectGate(deps, subject);
		expect(second).toBeUndefined();
	});
});
