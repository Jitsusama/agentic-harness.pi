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

import { execFileSync } from "node:child_process";
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
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../../lib/guardian/policy.ts";
import { GUARDS } from "../../../../lib/internal/guardian/guards.ts";
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
 * change reads as `read` says, at AT unless a test moves it, on the
 * forge `forge` names.
 */
function mergingProvider(
	read: () => Change = () => proposal,
	forge = "meteorite",
) {
	const merges: unknown[] = [];
	const key = `${forge}:shop/world`;
	const provider = stubProvider({
		id: forge,
		priority: 50,
		claimRepo: () => ({ key }),
		claimReference: (input) => ({
			provider: forge,
			repo: { key },
			id: input,
			label: `shop/world#${input}`,
		}),
		capabilities: { authoring: CAN_MERGE },
		facets: {
			changes: {
				fetch: async () => {
					const change = read();
					return {
						...change,
						ref: { ...change.ref, provider: forge, repo: { key } },
					};
				},
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

/**
 * Name `command` as the stub repo's merge gate in the package config,
 * on the forge `forge` names, its base queued when `queued` says.
 */
function gateIs(command: string, forge = "meteorite", queued = false): void {
	mkdirSync(dirname(packageConfigPath()), { recursive: true });
	const gate = { command, minutes: 1, ...(queued ? { base: "queued" } : {}) };
	writeFileSync(
		packageConfigPath(),
		JSON.stringify({
			version: 1,
			sections: {
				review: {
					merge: {
						gates: { [`${forge}:shop/world`]: gate },
					},
				},
			},
		}),
	);
}

/**
 * A checkout whose origin, a bare repo beside it, has `main` and a
 * `later` commit on it to move `main` to, written by fast-import so no
 * commit is signed; `moveMain` is the shell line that moves it.
 */
function checkoutWithOrigin(): {
	checkout: string;
	root: string;
	moveMain: string;
} {
	const root = mkdtempSync(join(tmpdir(), "gated-"));
	const origin = join(root, "origin.git");
	const checkout = join(root, "checkout");
	execFileSync("git", ["init", "-q", "--bare", origin]);
	const stamp = "committer Test <test@example.com> 1700000000 +0000";
	execFileSync("git", ["--git-dir", origin, "fast-import", "--quiet"], {
		input: [
			"commit refs/heads/main",
			stamp,
			"data 5",
			"main",
			"",
			"commit refs/heads/later",
			stamp,
			"data 6",
			"later",
			"from refs/heads/main",
			"",
		].join("\n"),
	});
	execFileSync("git", ["init", "-q", checkout]);
	execFileSync("git", ["-C", checkout, "remote", "add", "origin", origin]);
	return {
		checkout,
		root,
		moveMain: `git --git-dir ${JSON.stringify(origin)} update-ref refs/heads/main refs/heads/later`,
	};
}

async function offer(
	params: Record<string, unknown>,
	ctx: typeof HEADLESS = HEADLESS,
) {
	const stub = activate();
	const tool = toolNamed(stub, "review_offer");
	return await tool.execute("1", params, undefined, undefined, ctx);
}

/**
 * A context whose person approves whatever they're asked, running
 * `meanwhile` while they're asked; the review-offer guard is set to
 * ask, as a blocking guard does.
 */
function approvingAfter(meanwhile: () => void): typeof HEADLESS {
	setSessionMode(GUARDS.reviewOffer.name, "block");
	return {
		...HEADLESS,
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: () => {},
			custom: async () => {
				meanwhile();
				return { type: "action", key: "y" };
			},
		},
	} as typeof HEADLESS;
}

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
	rmSync(packageConfigPath(), { force: true });
	restoreSessionModes({});
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
		const { checkout, root } = checkoutWithOrigin();

		try {
			await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			merges,
			"the backend is held to the head the gate was handed",
		).toEqual([{ expectedHead: AT }]);
	});

	it("refuses a merge when a push landed while the gate ran", async () => {
		// Not every backend keeps expectedHead, so the head is read again
		// once the gate passes rather than left to the backend.
		for (const expectedHead of [undefined, AT]) {
			const { checkout, root } = checkoutWithOrigin();
			const pushed = join(root, "pushed");
			const { provider, merges } = mergingProvider(() =>
				existsSync(pushed) ? { ...proposal, headCommit: PUSHED } : proposal,
			);
			registerReviewProvider(provider);
			gateIs(`touch ${JSON.stringify(pushed)} && test ${AT} =`);

			let answer: unknown;
			try {
				answer = await offer({
					action: "merge",
					change: "438",
					repo: checkout,
					...(expectedHead ? { expectedHead } : {}),
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
				clearReviewProviders();
				clearTargetBindings();
			}

			expect(
				JSON.stringify(answer),
				`the refusal names the head it moved to, expectedHead ${expectedHead ?? "left out"}`,
			).toContain(`moved to ${PUSHED.slice(0, 12)} while its merge gate read`);
			expect(
				merges,
				`nothing the gate didn't read is merged, expectedHead ${expectedHead ?? "left out"}`,
			).toEqual([]);
		}
	});

	it("refuses a merge when the base moved on origin while the gate ran", async () => {
		// Two gated merges overlapping: the other lands while this gate
		// reads the head onto the base as it was.
		const { checkout, root, moveMain } = checkoutWithOrigin();
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);
		gateIs(`${moveMain} && test ${AT} =`);

		let answer: unknown;
		try {
			answer = await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal says the base moved while the gate ran",
		).toContain("main moved on origin from");
		expect(merges, "a pair nothing built isn't merged").toEqual([]);
	});

	it("refuses a merge when the base moved on origin while it was being approved", async () => {
		// No backend guards the base, so a merge landing while the person
		// is asked is caught only by reading it once more.
		const { checkout, root, moveMain } = checkoutWithOrigin();
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);
		gateIs(`test ${AT} =`);
		let asked = false;

		let answer: unknown;
		try {
			answer = await offer(
				{ action: "merge", change: "438", repo: checkout },
				approvingAfter(() => {
					asked = true;
					execFileSync("bash", ["-c", moveMain]);
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(asked, "the person was asked").toBe(true);
		expect(
			JSON.stringify(answer),
			"the refusal says the base moved while it was approved",
		).toContain("moved on origin from");
		expect(JSON.stringify(answer), "and when").toContain(
			"while the merge was being approved",
		);
		expect(merges, "a pair nothing built isn't merged").toEqual([]);
	});

	it("merges past a base that moved, under a queue that lands it on the newest tip", async () => {
		// 23 November: World's main moved 40 times in 140 seconds, so a
		// gate comparing it refused nearly every merge Merge Garden would
		// have put onto the newest tip anyway.
		const { checkout, root, moveMain } = checkoutWithOrigin();
		const { provider, merges } = mergingProvider(() => proposal, "delta");
		registerReviewProvider(provider);
		gateIs(`${moveMain} && test ${AT} =`, "delta", true);

		try {
			await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(merges, "the gated head goes to the queue").toEqual([
			{ expectedHead: AT },
		]);
	});

	it("never reads a queued base, merging where no origin can be read", async () => {
		// A folder with no origin refuses an unqueued gate before it runs, as
		// the case below shows, so a queued merge here read no base.
		const root = mkdtempSync(join(tmpdir(), "gated-"));
		const ran = join(root, "ran");
		const { provider, merges } = mergingProvider(() => proposal, "delta");
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(ran)} && test ${AT} =`, "delta", true);

		let gateRan = false;
		try {
			await offer({ action: "merge", change: "438", repo: root });
			gateRan = existsSync(ran);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(gateRan, "the gate ran").toBe(true);
		expect(merges, "and its head went to the queue").toEqual([
			{ expectedHead: AT },
		]);
	});

	it("merges past a base that moved while a queued merge was approved", async () => {
		const { checkout, root, moveMain } = checkoutWithOrigin();
		const { provider, merges } = mergingProvider(() => proposal, "delta");
		registerReviewProvider(provider);
		gateIs(`test ${AT} =`, "delta", true);
		let asked = false;

		try {
			await offer(
				{ action: "merge", change: "438", repo: checkout },
				approvingAfter(() => {
					asked = true;
					execFileSync("bash", ["-c", moveMain]);
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(asked, "the person was asked").toBe(true);
		expect(merges, "the approved head goes to the queue").toEqual([
			{ expectedHead: AT },
		]);
	});

	it("refuses a head a queued gate refused", async () => {
		const { checkout, root } = checkoutWithOrigin();
		const { provider, merges } = mergingProvider(() => proposal, "delta");
		registerReviewProvider(provider);
		gateIs("echo not ready >&2; false", "delta", true);

		let answer: unknown;
		try {
			answer = await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal carries what the gate said",
		).toContain("not ready");
		expect(merges, "nothing merges").toEqual([]);
	});

	it("refuses a queued change that names no base, before its gate runs", async () => {
		const { checkout, root } = checkoutWithOrigin();
		const ran = join(root, "ran");
		const { provider, merges } = mergingProvider(
			() => ({ ...proposal, base: "" }),
			"delta",
		);
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(ran)} && test ${AT} =`, "delta", true);

		let answer: unknown;
		let gateRan = false;
		try {
			answer = await offer({ action: "merge", change: "438", repo: checkout });
			gateRan = existsSync(ran);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(JSON.stringify(answer), "the refusal says why").toContain(
			"names no base",
		);
		expect(gateRan, "the gate never ran").toBe(false);
		expect(merges, "nothing merges").toEqual([]);
	});

	it("still refuses a head that moved while a queued gate ran", async () => {
		const { checkout, root } = checkoutWithOrigin();
		const pushed = join(root, "pushed");
		const { provider, merges } = mergingProvider(
			() =>
				existsSync(pushed) ? { ...proposal, headCommit: PUSHED } : proposal,
			"delta",
		);
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(pushed)} && test ${AT} =`, "delta", true);

		let answer: unknown;
		try {
			answer = await offer({ action: "merge", change: "438", repo: checkout });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal names the head it moved to",
		).toContain(`moved to ${PUSHED.slice(0, 12)} while its merge gate read`);
		expect(merges, "nothing the gate didn't read is merged").toEqual([]);
	});

	it("refuses a queued base on a forge that merges when asked", async () => {
		// Not `github`, whose real provider activate() registers over a stub
		// of that id; any forge but a queue's is refused alike.
		const { checkout, root } = checkoutWithOrigin();
		const ran = join(root, "ran");
		const { provider, merges } = mergingProvider(() => proposal, "gitea");
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(ran)} && test ${AT} =`, "gitea", true);

		let answer: unknown;
		let gateRan = false;
		try {
			answer = await offer({ action: "merge", change: "438", repo: checkout });
			gateRan = existsSync(ran);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal says why its base must be read",
		).toContain("gitea isn't known here to land every change through a queue");
		expect(gateRan, "the gate never ran").toBe(false);
		expect(merges, "nothing merges").toEqual([]);
	});

	it("merges once approved when the base stayed put", async () => {
		const { checkout, root } = checkoutWithOrigin();
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);
		gateIs(`test ${AT} =`);

		try {
			await offer(
				{ action: "merge", change: "438", repo: checkout },
				approvingAfter(() => {}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(merges, "the approved merge lands").toEqual([{ expectedHead: AT }]);
	});

	it("refuses before its gate runs when the base can't be read", async () => {
		// A folder with no origin: nothing could tell a merge landing
		// while the gate ran, so the gate isn't spent finding that out.
		const root = mkdtempSync(join(tmpdir(), "gated-"));
		const ran = join(root, "ran");
		const { provider, merges } = mergingProvider();
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(ran)} && test ${AT} =`);

		let answer: unknown;
		let gateRan = false;
		try {
			answer = await offer({ action: "merge", change: "438", repo: root });
			gateRan = existsSync(ran);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal says the base couldn't be read",
		).toContain("base is on origin couldn't be read");
		expect(
			JSON.stringify(answer),
			"a folder git can't read origin in is mended by naming a checkout",
		).toContain("name a checkout of the repo with `repo`");
		expect(gateRan, "the gate never ran").toBe(false);
		expect(merges, "nothing merges").toEqual([]);
	});

	it("refuses before its gate runs when the backend reports no head", async () => {
		// The head named as expectedHead used to be gated, then refused
		// once the gate was done because nothing could read it again.
		const { checkout, root } = checkoutWithOrigin();
		const ran = join(root, "ran");
		const { headCommit: _dropped, ...headless } = proposal;
		const { provider, merges } = mergingProvider(() => headless);
		registerReviewProvider(provider);
		gateIs(`touch ${JSON.stringify(ran)}`);

		let answer: unknown;
		let gateRan = false;
		try {
			answer = await offer({
				action: "merge",
				change: "438",
				repo: checkout,
				expectedHead: AT,
			});
			gateRan = existsSync(ran);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		expect(
			JSON.stringify(answer),
			"the refusal says no gate can be held to a head",
		).toContain("so no gate can be held to one");
		expect(gateRan, "the gate never ran").toBe(false);
		expect(merges, "nothing merges").toEqual([]);
	});

	it("names the head the gate passed when it can't be read again", async () => {
		for (const afterwards of ["gone", "throws"] as const) {
			const { checkout, root } = checkoutWithOrigin();
			const ran = join(root, "ran");
			const { provider, merges } = mergingProvider(() => {
				if (!existsSync(ran)) return proposal;
				if (afterwards === "gone") {
					const { headCommit: _gone, ...headless } = proposal;
					return headless;
				}
				throw new Error("the host didn't answer");
			});
			registerReviewProvider(provider);
			gateIs(`touch ${JSON.stringify(ran)} && test ${AT} =`);

			let answer: unknown;
			try {
				answer = await offer({
					action: "merge",
					change: "438",
					repo: checkout,
					expectedHead: AT,
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
				clearReviewProviders();
				clearTargetBindings();
			}

			const said = JSON.stringify(answer);
			expect(
				said,
				`the refusal names the head that passed (${afterwards})`,
			).toContain(`The merge gate passed ${AT.slice(0, 12)}`);
			if (afterwards === "throws") {
				expect(said, "the read's own error is said").toContain(
					"the host didn't answer",
				);
			}
			expect(merges, `nothing merges (${afterwards})`).toEqual([]);
		}
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
