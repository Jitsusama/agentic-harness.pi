/**
 * A node's findings on a hosted change are read on optimus.
 *
 * A council run on another machine reviews a local range. The gate counts
 * it from the mirrored ledger, but its findings stay keyed under the
 * node's range in another folder, so without adoption `review_see
 * findings` on the pull request says nothing was raised and nobody can
 * decide them or record a fix.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerDir,
	decisionDir,
	findingDir,
	fixDir,
	mirroredAnswersDir,
	mirroredFindingsDir,
	mirroredRunsDir,
} from "../../../extensions/review-integration/engine.ts";
import {
	type ChangeRef,
	createFindingStore,
	createFixQueue,
	createRunStore,
	type Finding,
} from "../../../lib/core/review/index.ts";
import { activate, HEADLESS, toolNamed } from "../support/review-extension.ts";

const REPO = "github:Shopify/world";
const HEAD = "abc1237";
const URL = "https://github.com/Shopify/world/pull/7";
const NODE = "aquifer-node";
const ROUND = "council-on-the-node";

/** Pull request 7 as the fake GitHub answers it, its head at `HEAD`. */
const CHANGES = {
	"Shopify/world/pulls/7": {
		stdout: JSON.stringify({
			number: 7,
			title: "Teach the widget to fly",
			body: "",
			state: "open",
			draft: false,
			merged_at: null,
			user: { login: "someone" },
			base: { ref: "main" },
			head: { ref: "topic-7", sha: HEAD },
			html_url: URL,
			created_at: "2026-08-01T00:00:00Z",
			updated_at: "2026-08-02T00:00:00Z",
		}),
	},
};

/** The pull request, as the store keys its findings. */
const PULL: ChangeRef = {
	provider: "github",
	repo: { key: REPO },
	id: "7",
	label: "Shopify/world#7",
};

/** The node's local range the council ran on. */
function nodeRange(repo = REPO): ChangeRef {
	return {
		provider: "local-range",
		repo: { key: repo },
		id: `base0000..${HEAD}`,
		label: `base0000..${HEAD}`,
	};
}

/** What a round on the node is, beyond its witness. */
interface NodeRound {
	readonly repo?: string;
	readonly witness?: string;
	readonly unpinned?: boolean;
	readonly id?: string;
}

/**
 * A finished council on the node, mirrored: its ledger under runs-from,
 * its two findings under findings-from and its answers under answers-from.
 */
async function mirroredRound(round: NodeRound = {}): Promise<void> {
	const repo = round.repo ?? REPO;
	const id = round.id ?? ROUND;
	const range = nodeRange(repo);
	await createRunStore(join(mirroredRunsDir(), NODE)).record(range, {
		id,
		round: "council",
		startedAt: new Date().toISOString(),
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [1, 2] }],
		witness: round.witness ?? HEAD,
		...(round.unpinned ? { unpinned: "fell back to the checkout" } : {}),
	});
	await createFindingStore(join(mirroredFindingsDir(), NODE)).record(
		range,
		["The widget forgets its wings.", "The landing has no gear."].map(
			(subject) => raisedBy(id, subject),
		),
	);
	const answers = join(mirroredAnswersDir(), NODE, id);
	mkdirSync(answers, { recursive: true });
	writeFileSync(join(answers, "hawk.txt"), "What hawk said.\n");
}

/** A finding hawk raised in round `runId`. */
function raisedBy(runId: string, subject: string): Omit<Finding, "id"> {
	return {
		anchor: { subject: "change", witness: HEAD },
		label: "issue",
		subject,
		discussion: "Read the diff.",
		origin: { kind: "reviewer", runId, reviewerId: "hawk" },
	};
}

/** What a tool answered: its text, and the id its details name. */
interface Answer {
	readonly text: string;
	readonly id: string | undefined;
}

/** A tool of the extension, called headless. */
function tool(name: string) {
	const found = toolNamed(activate(CHANGES), name);
	return async (params: Record<string, unknown>): Promise<Answer> =>
		answerOf(
			await found.execute("call", params, undefined, undefined, HEADLESS),
		);
}

/** A tool's result read as an answer: its first text, its details' id. */
function answerOf(result: unknown): Answer {
	if (typeof result !== "object" || result === null) {
		return { text: "", id: undefined };
	}
	const content = "content" in result ? result.content : undefined;
	const first: unknown = Array.isArray(content) ? content[0] : undefined;
	const details = "details" in result ? result.details : undefined;
	return {
		text: stringAt(first, "text") ?? "",
		id: stringAt(details, "id"),
	};
}

/** The string `value` holds under `key`, when it is an object holding one. */
function stringAt(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const held: unknown = Reflect.get(value, key);
	return typeof held === "string" ? held : undefined;
}

/** What `review_see findings` says of the pull request. */
async function listed(): Promise<string> {
	return (await tool("review_see")({ action: "findings", change: URL })).text;
}

/** Every folder the case writes, the mirrors among them. */
function folders(): string[] {
	return [
		mirroredRunsDir(),
		mirroredFindingsDir(),
		mirroredAnswersDir(),
		findingDir(),
		answerDir(),
		fixDir(),
		decisionDir(),
	];
}

describe("adopting a node's findings on a hosted change", () => {
	beforeEach(() => {
		for (const folder of folders()) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		for (const folder of folders()) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("lists a mirrored round that read the head, naming its node", async () => {
		await mirroredRound();

		const said = await listed();

		expect(said, "the listing says what it adopted").toContain(
			`Adopted 2 findings from ${NODE}'s mirrored rounds.`,
		);
		expect(said, "each finding is listed under the pull request").toMatch(
			/\[F1\] issue: The widget forgets its wings\./,
		);
		expect(said, "the round names its node").toContain(
			`Newest round: ${ROUND} from ${NODE}`,
		);
		expect(said, "each finding names its node").toContain(
			`reviewer hawk on ${NODE}`,
		);
		const held = await createFindingStore(findingDir()).list(PULL);
		expect(
			held.map((finding) => [finding.id, finding.node, finding.origin]),
			"each keeps its round and gains its node",
		).toEqual([
			[1, NODE, { kind: "reviewer", runId: ROUND, reviewerId: "hawk" }],
			[2, NODE, { kind: "reviewer", runId: ROUND, reviewerId: "hawk" }],
		]);
		expect(
			readFileSync(join(answerDir(), ROUND, "hawk.txt"), "utf8"),
			"the round's answers are copied so its provenance resolves",
		).toBe("What hawk said.\n");
	});

	it("numbers adopted findings after those raised here", async () => {
		await createFindingStore(findingDir()).record(PULL, [
			{
				anchor: { subject: "change", witness: HEAD },
				label: "note",
				subject: "Raised by hand here.",
				discussion: "",
				origin: { kind: "hand" },
			},
		]);
		await mirroredRound();

		await listed();

		const held = await createFindingStore(findingDir()).list(PULL);
		expect(
			held.map((finding) => [finding.id, finding.node]),
			"the local finding keeps F1",
		).toEqual([
			[1, undefined],
			[2, NODE],
			[3, NODE],
		]);
	});

	it("adds nothing when read twice", async () => {
		await mirroredRound();

		await listed();
		const again = await listed();

		expect(
			await createFindingStore(findingDir()).list(PULL),
			"a round already adopted is never adopted again",
		).toHaveLength(2);
		expect(again, "the second read adopts nothing").not.toContain("Adopted");
	});

	it("adopts nothing from a round that read another commit", async () => {
		await mirroredRound({ witness: "def4567" });

		expect(await listed(), "a foreign round raised nothing here").toContain(
			"nothing raised on",
		);
		expect(existsSync(answerDir()), "no answers are copied").toBe(false);
	});

	it("adopts nothing from a round of another repo at the head", async () => {
		await mirroredRound({ repo: "github:Shopify/other" });

		expect(
			await listed(),
			"another repo's round raised nothing here",
		).toContain("nothing raised on");
	});

	it("adopts nothing from a round that fell back to the checkout", async () => {
		await mirroredRound({ unpinned: true });

		expect(await listed(), "an unpinned round read nothing it names").toContain(
			"nothing raised on",
		);
	});

	it("adopts a round once its findings arrive after its ledger", async () => {
		await mirroredRound();
		const mirrored = join(mirroredFindingsDir(), NODE);
		const [file = ""] = readdirSync(mirrored);
		const findings = readFileSync(join(mirrored, file), "utf8");
		rmSync(mirrored, { recursive: true, force: true });

		expect(await listed(), "with no findings mirrored, none are").toContain(
			"nothing raised on",
		);
		mkdirSync(mirrored, { recursive: true });
		writeFileSync(join(mirrored, file), findings);

		expect(await listed(), "once they arrive they are adopted").toContain(
			"Adopted 2 findings",
		);
	});

	it("leaves every mirrored file's bytes as they were", async () => {
		await mirroredRound();
		const before = mirroredBytes();

		await listed();

		expect(mirroredBytes(), "the mirrors are only read").toEqual(before);
	});

	it("names a node whose findings can't be listed, and lists the rest", async () => {
		await mirroredRound();
		const mirrored = join(mirroredFindingsDir(), NODE);
		rmSync(mirrored, { recursive: true, force: true });
		mkdirSync(mirrored, { recursive: true, mode: 0o000 });

		try {
			const said = await listed();
			expect(said, "the node is named").toContain(
				`The findings mirrored from ${NODE} couldn't be read`,
			);
			expect(said, "the listing still answers").toContain("nothing raised on");
		} finally {
			chmodSync(mirrored, 0o700);
		}
	});

	it("decides an adopted finding as it decides a local one", async () => {
		await mirroredRound();
		const draft = tool("review_draft");
		const opened = await draft({ action: "open", change: URL });

		const decided = await draft({
			action: "decide",
			draft: opened.id,
			finding: 2,
			settle: "fix",
		});

		expect(decided.text, "deciding finds F2 unread").toContain(
			"F2 queued to fix",
		);
		const queued = await createFixQueue(fixDir()).list(PULL);
		expect(
			queued.map((one) => one.findingId),
			"the fix is queued on the pull request",
		).toEqual([2]);
	});
});

/** Every file under the mirrors, with its bytes. */
function mirroredBytes(): Record<string, string> {
	const bytes: Record<string, string> = {};
	for (const root of [
		mirroredRunsDir(),
		mirroredFindingsDir(),
		mirroredAnswersDir(),
	]) {
		for (const name of readdirSync(root, { recursive: true })) {
			const path = join(root, String(name));
			if (path.endsWith(".json") || path.endsWith(".txt")) {
				bytes[path] = readFileSync(path, "utf8");
			}
		}
	}
	return bytes;
}
