/**
 * Merging is the moment a change stops being in play.
 *
 * Nothing said so, so an attachment outlived the change it named and
 * every later call still preferred it. A session that had shipped
 * eight changes was carrying eight of them, and each one hijacked the
 * calls whose subject is a repo: naming a checkout was answered with
 * "the change in play is on ..." eight times over, once per pop.
 *
 * Enqueuing is deliberately not the same event. A queued change has
 * been accepted for a batch that may still fail, which is precisely
 * the state in which it is still yours to watch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGED_PATHS_MS } from "../../../../extensions/review-integration/changed-paths.ts";
import { queuedHere } from "../../../../extensions/review-integration/queued.ts";
import {
	type AuthoringCapabilities,
	type Change,
	clearReviewProviders,
	clearTargetBindings,
	registerReviewProvider,
} from "../../../../lib/core/review/index.ts";
import { SESSION_LANDED } from "../../../../lib/internal/session/landings.ts";
import { stubProvider } from "../../../support/stub-provider.ts";
import {
	activate,
	HEADLESS,
	toolNamed,
} from "../../support/review-extension.ts";

const AT = "b8210c7420448a5390ca3b2d8bc65c5ceab2af0f";

const CAN_MERGE: AuthoringCapabilities = {
	propose: false,
	proposeStack: false,
	reviewersAt: "never",
	retarget: "never",
	setDraft: false,
	close: false,
	reopen: false,
	merge: true,
	labels: false,
	assignees: false,
	identifies: "login",
	rerunChecks: false,
	refusesWhileEnqueued: false,
};

const unused = (method: string) => async (): Promise<never> => {
	throw new Error(`this test never asks a provider to ${method}`);
};

const proposal: Change = {
	ref: {
		provider: "meteorite",
		repo: { key: "meteorite:shop/world" },
		id: "438",
		label: "shop/world#438",
	},
	title: "Make a Panel Cover What It Is Drawn Over",
	body: "### 🌐 Situation\n\nIt did not.\n",
	state: "open",
	draft: false,
	author: { id: "Jitsusama" },
	base: "main",
	head: "jitsusama/validate-pr-arc",
	headCommit: AT,
	url: "https://example.invalid/438",
};

/** The changes a backend was asked to fetch into a checkout, to diff them there. */
const fetchedAsRef: string[] = [];

/**
 * A backend whose merge lands, or is taken into a queue. Its merge
 * names the commit it landed as unless `commit` says otherwise, and
 * `readBack` is the change it reads back afterwards. Its diff is
 * `diff` when given, one that never answers when that is "hangs",
 * else one it can't read. Its changes are checked out at `checkout`
 * when given, so a diff it refuses could be read there instead.
 */
function backend(outcome: {
	kind: "merged" | "enqueued";
	commit?: string | null;
	readBack?: Partial<Change>;
	diff?: string;
	checkout?: string;
}) {
	return stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => ({ key: "meteorite:shop/world" }),
		claimReference: (input) => ({
			provider: "meteorite",
			repo: {
				key: "meteorite:shop/world",
				...(outcome.checkout ? { localPath: outcome.checkout } : {}),
			},
			id: input,
			label: `shop/world#${input}`,
		}),
		capabilities: { authoring: CAN_MERGE },
		facets: {
			changes: {
				fetch: async () => ({ ...proposal, ...outcome.readBack }),
				diff:
					outcome.diff === undefined
						? async () => {
								throw new Error("this backend can't read a diff");
							}
						: outcome.diff === "hangs"
							? () => new Promise<string>(() => {})
							: async () => outcome.diff ?? "",
				fetchAsRef: async (ref) => {
					fetchedAsRef.push(ref.id);
					return "refs/fetched";
				},
			},
			authoring: {
				propose: unused("propose a change"),
				edit: unused("edit a change"),
				close: unused("close a change"),
				merge: async () =>
					outcome.kind === "merged"
						? {
								kind: "merged" as const,
								...(outcome.commit === null
									? {}
									: { commit: outcome.commit ?? "deadbeefcafe" }),
							}
						: { kind: "enqueued" as const },
			},
		},
	});
}

/** Attach 438, then merge it, and report what is left attached. */
async function attachThenMerge(
	outcome: Parameters<typeof backend>[0],
	asked: { person?: string } = {},
) {
	registerReviewProvider(backend(outcome));
	const stub = activate();
	const review = toolNamed(stub, "review");
	const offer = toolNamed(stub, "review_offer");

	await review.execute(
		"attach",
		{ action: "attach", change: "438" },
		undefined,
		undefined,
		HEADLESS,
	);
	const merged = await offer.execute(
		"merge",
		{ action: "merge", change: "438", ...asked },
		undefined,
		undefined,
		HEADLESS,
	);
	const listed = await review.execute(
		"list",
		{},
		undefined,
		undefined,
		HEADLESS,
	);
	return {
		merged: JSON.stringify(merged),
		listed: JSON.stringify(listed),
		landed: stub.emitted
			.filter((one) => one.event === SESSION_LANDED)
			.map((one) => one.data),
	};
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
});

describe("what merging does to the attachment", () => {
	it("lets the change go once it has landed", async () => {
		const { listed } = await attachThenMerge({ kind: "merged" });

		expect(listed).not.toContain("shop/world#438");
	});

	it("says so, rather than letting it be discovered", async () => {
		// A registry cleared in silence is the thing that makes the next
		// refusal unreadable.
		const { merged } = await attachThenMerge({ kind: "merged" });

		expect(merged).toContain("etached");
	});

	it("keeps a change the queue has only accepted", async () => {
		// It lands when the queue reaches it, and not at all if its checks
		// fail, so it is still the thing being watched.
		const { listed } = await attachThenMerge({ kind: "enqueued" });

		expect(listed).toContain("shop/world#438");
	});
});

describe("what merging says it landed", () => {
	// So the mesh keeps it in the session's presence, where an
	// orchestrator reads it rather than being told.
	it("names the change without its owner, and its title", async () => {
		const { landed } = await attachThenMerge({ kind: "merged" });

		expect(landed).toEqual([
			expect.objectContaining({
				ref: "world#438",
				what: "Make a Panel Cover What It Is Drawn Over",
			}),
		]);
	});

	it("carries the change's web page, since its ref drops the owner", async () => {
		const { landed } = await attachThenMerge({ kind: "merged" });

		expect(landed).toEqual([
			expect.objectContaining({ url: "https://example.invalid/438" }),
		]);
		expect(landed[0]).not.toHaveProperty("person");
	});

	it("carries the commit it landed as, so the launcher can tell when it reaches the machine", async () => {
		const { landed } = await attachThenMerge({ kind: "merged" });

		expect(landed).toEqual([
			expect.objectContaining({ commit: "deadbeefcafe" }),
		]);
	});

	it("takes the commit from the change read back when the merge didn't say", async () => {
		const { landed } = await attachThenMerge({
			kind: "merged",
			commit: null,
			readBack: { state: "merged", mergeCommit: "c0ffee00" },
		});

		expect(landed).toEqual([expect.objectContaining({ commit: "c0ffee00" })]);
	});

	it("takes the merge's own commit over the one read back", async () => {
		const { landed } = await attachThenMerge({
			kind: "merged",
			commit: "a11ce000",
			readBack: { state: "merged", mergeCommit: "c0ffee00" },
		});

		expect(landed).toEqual([expect.objectContaining({ commit: "a11ce000" })]);
	});

	it("reads back past a merge that answered with a blank commit", async () => {
		const { landed } = await attachThenMerge({
			kind: "merged",
			commit: " ",
			readBack: { state: "merged", mergeCommit: "c0ffee00" },
		});

		expect(landed).toEqual([expect.objectContaining({ commit: "c0ffee00" })]);
	});

	it("names no commit when neither the merge nor the change read back says one", async () => {
		const { landed } = await attachThenMerge({ kind: "merged", commit: null });

		expect(landed[0]).not.toHaveProperty("commit");
	});

	it("says the areas its files are in, so the mesh can say what its quest works on", async () => {
		const file = (path: string) =>
			`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
		const { landed } = await attachThenMerge({
			kind: "merged",
			diff: [
				file("extensions/review-integration/queued.ts"),
				file("tests/extensions/review-integration/queued.test.ts"),
			].join(""),
		});

		expect(landed).toEqual([
			expect.objectContaining({ areas: ["extensions/review-integration"] }),
		]);
	});

	it("says no areas when its diff can't be read, and still says it landed", async () => {
		const { landed } = await attachThenMerge({ kind: "merged" });

		expect(landed).toHaveLength(1);
		expect(landed[0]).not.toHaveProperty("areas");
	});

	// The council, 25 November: the engine's fallback for a diff its
	// backend refuses fetches into the checkout and diffs against a local
	// base that may be stale, taking in other people's commits.
	it("says it landed without areas, fetching nothing, when its backend refuses the diff", async () => {
		fetchedAsRef.length = 0;
		const { landed } = await attachThenMerge({
			kind: "merged",
			checkout: tmpdir(),
		});

		expect(landed).toHaveLength(1);
		expect(landed[0]).not.toHaveProperty("areas");
		expect(fetchedAsRef).toEqual([]);
	});

	it("says it landed without areas when its diff doesn't answer in time", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let done = false;
			const merging = attachThenMerge({
				kind: "merged",
				diff: "hangs",
			}).finally(() => {
				done = true;
			});
			// The bound's timer is set only once the merge's real file work
			// is done, so each step lets a real turn pass before moving the
			// clock; the test's own timeout ends a merge that never answers.
			while (!done) {
				await new Promise((next) => setImmediate(next));
				await vi.advanceTimersByTimeAsync(CHANGED_PATHS_MS);
			}
			const { landed } = await merging;

			expect(landed).toHaveLength(1);
			expect(landed[0]).not.toHaveProperty("areas");
		} finally {
			vi.useRealTimers();
		}
	});

	it("names the branch it landed on, so a stacked parent's is told from trunk", async () => {
		const { landed } = await attachThenMerge({ kind: "merged" });

		expect(landed).toEqual([expect.objectContaining({ onto: "main" })]);
	});

	it("carries the person's line the merge was asked to", async () => {
		const { landed } = await attachThenMerge(
			{ kind: "merged" },
			{ person: "Panels now cover\nwhat they're drawn over." },
		);

		expect(landed).toEqual([
			expect.objectContaining({
				person: "Panels now cover what they're drawn over.",
			}),
		]);
	});

	it("lands nothing the queue has only accepted, and watches it until it merges", async () => {
		const root = mkdtempSync(join(tmpdir(), "enqueued-"));
		vi.stubEnv("XDG_STATE_HOME", root);
		try {
			const { landed } = await attachThenMerge(
				{ kind: "enqueued" },
				{ person: "Nothing to try." },
			);

			expect(landed).toEqual([]);
			expect(queuedHere()).toEqual([
				expect.objectContaining({
					change: expect.objectContaining({ label: "shop/world#438" }),
					person: "Nothing to try.",
				}),
			]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
