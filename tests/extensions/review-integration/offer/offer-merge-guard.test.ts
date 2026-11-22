/**
 * V19 of the validation plan: what a refused head guard says.
 *
 * `expectedHead` is the only guard against merging work nobody looked at, so
 * it fires on the day somebody pushed while you were reading. What it said
 * was GitHub's own words, "Head branch was modified", passed through.
 *
 * Those words name a cause, and the cause is often false. Both times the
 * guard fired during this quest the branch had not been touched: the
 * expectation was wrong, completed from an eight-character prefix rather than
 * read. The message sends the reader looking for a push that never happened,
 * and the one fact that would end the search, which head the change is
 * actually at, is known here and was not being said.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AuthoringCapabilities,
	type Change,
	clearReviewProviders,
	clearTargetBindings,
	registerReviewProvider,
} from "../../../../lib/core/review/index.ts";
import { packageConfigPath } from "../../../../lib/internal/paths.ts";
import { stubProvider } from "../../../support/stub-provider.ts";
import {
	activate,
	HEADLESS,
	toolNamed,
} from "../../support/review-extension.ts";

const AT = "b8210c7420448a5390ca3b2d8bc65c5ceab2af0f";
const CLAIMED = "b8210c7409c9c25e5c62ac0cbe0d84d8c2ea0d33";

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

/**
 * The change as the backend reports it, sitting at a known head.
 *
 * Named against a stub provider rather than `github`, because `activate()`
 * registers the extension's real providers into the same process-wide
 * registry and a stub sharing an id is silently replaced by one that talks to
 * the network.
 */
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

/** A head the change moves to when a push lands. */
const PUSHED = "0f3c9a1d7e2b4c6a8d0e1f2a3b4c5d6e7f8a9b0c";

/**
 * A backend that merges, and records whether it was ever asked to. Its
 * change is at AT, or at PUSHED once `movedOnce` is true.
 */
function mergingProvider(movedOnce: () => boolean = () => false) {
	const merges: unknown[] = [];
	const provider = stubProvider({
		id: "meteorite",
		priority: 50,
		claimRepo: () => ({ key: "meteorite:shop/world" }),
		claimReference: (input) => ({
			provider: "meteorite",
			repo: { key: "meteorite:shop/world" },
			id: input,
			label: `shop/world#${input}`,
		}),
		capabilities: { authoring: CAN_MERGE },
		facets: {
			changes: {
				fetch: async () =>
					movedOnce() ? { ...proposal, headCommit: PUSHED } : proposal,
				diff: unused("diff a change"),
			},
			authoring: {
				propose: unused("propose a change"),
				edit: unused("edit a change"),
				close: unused("close a change"),
				merge: async (_change: unknown, request: unknown) => {
					merges.push(request);
					return { kind: "merged" as const, commit: "deadbeefcafe" };
				},
			},
		},
	});
	return { provider, merges };
}

/** Name `command` as the stub repo's merge gate in the package config. */
function gateIs(command: string): void {
	mkdirSync(dirname(packageConfigPath()), { recursive: true });
	writeFileSync(
		packageConfigPath(),
		JSON.stringify({
			version: 1,
			sections: {
				review: {
					merge: {
						gates: { "meteorite:shop/world": { command, minutes: 1 } },
					},
				},
			},
		}),
	);
}

async function offer(params: Record<string, unknown>) {
	const stub = activate();
	const tool = toolNamed(stub, "review_offer");
	return await tool.execute("1", params, undefined, undefined, HEADLESS);
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
	rmSync(packageConfigPath(), { force: true });
});

describe("merging behind a head guard", () => {
	it("names both heads when the expectation does not match", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		const answer = await offer({
			action: "merge",
			change: "438",
			expectedHead: CLAIMED,
		});

		const said = JSON.stringify(answer);
		// The head asked for and the head it is at, both said, so the reader
		// can see at a glance that the two share a prefix and diverge after it.
		expect(said).toContain(CLAIMED);
		expect(said).toContain(AT);
		// And nothing is merged on the strength of a stale expectation.
		expect(merges).toEqual([]);
	});

	it("merges when the expectation matches", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "merge",
			change: "438",
			expectedHead: AT,
		});

		expect(merges).toHaveLength(1);
	});

	it("hands the backend the whole head a short prefix matched", async () => {
		// GitHub refuses any `sha` but all forty characters, and a prefix the
		// guard had accepted went through as it was 23 times.
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "merge",
			change: "438",
			expectedHead: AT.slice(0, 12),
		});

		expect(merges).toEqual([{ expectedHead: AT }]);
	});

	it("refuses a prefix too short to guard anything", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		const answer = await offer({
			action: "merge",
			change: "438",
			expectedHead: AT.slice(0, 4),
		});

		expect(JSON.stringify(answer)).toContain("too short to guard anything");
		expect(merges).toEqual([]);
	});

	it("merges the head its repo's gate passed when no expectation is given", async () => {
		// Without it, a push landing while the gate ran was merged though
		// no gate had read it. The gate refuses any head but AT.
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);
		gateIs(`test ${AT} =`);
		const checkout = mkdtempSync(join(tmpdir(), "gated-"));

		try {
			await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}

		expect(
			merges,
			"the backend is held to the head the gate was handed",
		).toEqual([{ expectedHead: AT }]);
	});

	it("refuses a merge when a push landed while the gate ran", async () => {
		// Not every backend keeps expectedHead, so the head is read again
		// once the gate passes rather than left to the backend.
		const checkout = mkdtempSync(join(tmpdir(), "gated-"));
		const pushed = join(checkout, "pushed");
		const { provider, merges } = mergingProvider(() => existsSync(pushed));
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(pushed)} && test ${AT} =`);

		let answer: unknown;
		try {
			answer = await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal names the head it moved to",
		).toContain(`moved to ${PUSHED.slice(0, 12)} while its merge gate read`);
		expect(merges, "nothing the gate didn't read is merged").toEqual([]);
	});

	it("refuses a merge when the package config can't be parsed", async () => {
		// A stray comma used to read as no gate at all, so every gated repo
		// merged ungated.
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);
		mkdirSync(dirname(packageConfigPath()), { recursive: true });
		writeFileSync(packageConfigPath(), '{ "version": 1, }');

		const answer = await offer({ action: "merge", change: "438" });

		const said = JSON.stringify(answer);
		expect(said, "the config's path and failure are named").toContain(
			`Could not parse package config at ${packageConfigPath()}`,
		);
		expect(said, "the refusal says why it stopped").toContain(
			"names a merge gate can't be known",
		);
		expect(merges, "nothing merges past an unread config").toEqual([]);
	});

	it("still merges when no expectation is given", async () => {
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);

		await offer({
			action: "merge",
			change: "438",
		});

		expect(merges).toHaveLength(1);
	});
});
