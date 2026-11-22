/**
 * A council another machine ran counts as our own review first.
 *
 * Equilibrius runs rounds while optimus's memory holds councils back,
 * and its ledger is mirrored under runs-from/<node>. Before the gate
 * read the mirror, every such council was invisible here, so each
 * change waited for a last round on optimus (1JQPPC, 21 Nov).
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mirroredRunsDir,
	runDir,
} from "../../../../extensions/review-integration/engine.ts";
import {
	councilFirst,
	witnessCouncilsWith,
} from "../../../../extensions/review-integration/reviewed-first.ts";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	type ChangeRef,
	createRunStore,
} from "../../../../lib/core/review/index.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";

const REPO = "github:Jitsusama/mycelium";

const exec: Exec = async (command, args) =>
	new Promise((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code: error ? Number(error.code ?? 1) : 0,
				stdout: String(stdout),
				stderr: String(stderr),
			}),
		),
	);

/** A finished council in `ledger`, for `repo`, whose reviewers read `witness`. */
async function councilIn(
	ledger: string,
	repo: string,
	witness: string,
	open = false,
) {
	const range: ChangeRef = {
		provider: "local-range",
		repo: { key: repo },
		id: "origin/main..topic",
		label: "origin/main..topic",
	};
	await createRunStore(ledger).record(range, {
		id: `council-${witness}`,
		round: "council",
		startedAt: new Date().toISOString(),
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [] }],
		witness,
		...(open ? { open: true } : {}),
	});
}

describe("counting a council another machine ran", () => {
	let repo: string;
	let head: string;
	const equilibrius = () => join(mirroredRunsDir(), "equilibrius");
	const topic = () => ({
		repo: REPO,
		checkout: repo,
		base: "main",
		head: "topic",
	});

	beforeEach(async () => {
		rmSync(runDir(), { recursive: true, force: true });
		rmSync(mirroredRunsDir(), { recursive: true, force: true });
		witnessCouncilsWith(undefined);
		repo = await freshRepo("reviewed-first-mirrored");
		await git(repo, "switch", "-qc", "topic");
		writeFileSync(join(repo, "one"), "one\n");
		await git(repo, "add", "one");
		await git(repo, "commit", "-qm", "one");
		head = await git(repo, "rev-parse", "HEAD");
	});

	afterEach(() => {
		disposeRepo(repo);
		rmSync(mirroredRunsDir(), { recursive: true, force: true });
		witnessCouncilsWith(async () => true);
	});

	it("lets a change through on a council mirrored from another machine", async () => {
		await councilIn(equilibrius(), REPO, head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a mirrored council that read the head counts",
		).toBeUndefined();
		expect(
			existsSync(runDir()),
			"nothing is written into this machine's ledger",
		).toBe(false);
	});

	it("holds it back when the mirrored council was of another repo", async () => {
		await councilIn(equilibrius(), "github:Jitsusama/other", head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a council of another repo at the same commit does not count",
		).toContain("No council of ours has read main..topic");
	});

	it("holds it back with no mirror, as before", async () => {
		const said = await councilFirst(exec, topic(), "proposed");
		expect(said, "with no council anywhere the change waits").toContain(
			"No council of ours has read main..topic",
		);
		expect(said, "with no mirror, none is named").not.toContain("mirrored");
	});

	it("leaves the mirrored ledger's bytes as they were", async () => {
		await councilIn(equilibrius(), REPO, head);
		const [file = ""] = readdirSync(equilibrius());
		const before = readFileSync(join(equilibrius(), file), "utf8");

		await councilFirst(exec, topic(), "proposed");

		expect(
			readFileSync(join(equilibrius(), file), "utf8"),
			"the mirror is only read",
		).toBe(before);
	});

	it("counts a node folder that is a link to the mirrored ledger", async () => {
		const elsewhere = join(repo, "..", `mirror-${Date.now()}`);
		await councilIn(elsewhere, REPO, head);
		mkdirSync(mirroredRunsDir(), { recursive: true });
		symlinkSync(elsewhere, equilibrius());

		try {
			expect(
				await councilFirst(exec, topic(), "proposed"),
				"a linked node folder is read like one in place",
			).toBeUndefined();
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("reads a good mirror beside a torn one and a stray file", async () => {
		const torn = join(mirroredRunsDir(), "aardvark");
		mkdirSync(torn, { recursive: true });
		writeFileSync(join(torn, "half.json"), "{ not json");
		writeFileSync(join(mirroredRunsDir(), "stray.json"), "{}");
		await councilIn(equilibrius(), REPO, head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a torn ledger and a stray file don't hide the good mirror",
		).toBeUndefined();
	});

	it("holds it back on a mirrored round still open", async () => {
		await councilIn(equilibrius(), REPO, head, true);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a round still open on another machine has read nothing yet",
		).toContain("No council of ours has read main..topic");
	});

	it("names the mirrors it asked when none read the change", async () => {
		await councilIn(equilibrius(), "github:Jitsusama/other", head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"the refusal says which machines' councils were asked",
		).toContain("those mirrored from equilibrius.");
	});

	it("names every node folder in order, leaving out a stray file", async () => {
		await councilIn(
			join(mirroredRunsDir(), "aardvark"),
			"github:Jitsusama/other",
			head,
		);
		await councilIn(equilibrius(), "github:Jitsusama/other", head);
		writeFileSync(join(mirroredRunsDir(), "stray.json"), "{}");

		const said = await councilFirst(exec, topic(), "proposed");
		expect(said, "both node folders are named, in name order").toContain(
			"those mirrored from aardvark, equilibrius.",
		);
		expect(said, "a file beside the node folders is no mirror").not.toContain(
			"stray",
		);
	});

	it.skipIf(process.getuid?.() === 0)(
		"says a node folder it can't read, rather than naming it as asked",
		async () => {
			await councilIn(equilibrius(), REPO, head);
			chmodSync(equilibrius(), 0);
			try {
				const said = await councilFirst(exec, topic(), "proposed");
				expect(said, "the unreadable mirror is said").toMatch(
					/The mirror from equilibrius couldn't be read \(.*EACCES.*\), so it wasn't asked\./,
				);
				expect(said, "an unread mirror is never named as asked").not.toContain(
					"mirrored from equilibrius",
				);
			} finally {
				chmodSync(equilibrius(), 0o755);
			}
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"says a node folder that lists but whose ledgers won't open",
		async () => {
			// Read but not search permission lists the names and opens none,
			// which the store would pass over as an empty ledger.
			await councilIn(equilibrius(), REPO, head);
			chmodSync(equilibrius(), 0o444);
			try {
				const said = await councilFirst(exec, topic(), "proposed");
				expect(said, "the mirror whose ledger won't open is said").toMatch(
					/The mirror from equilibrius couldn't be read \(its ledger .*\.json wouldn't open: .*EACCES.*\), so it wasn't asked\./,
				);
				expect(
					said,
					"a mirror whose ledgers can't be read is never named as asked",
				).not.toContain("mirrored from equilibrius");
			} finally {
				chmodSync(equilibrius(), 0o755);
			}
		},
	);

	it("says a node link that leads nowhere", async () => {
		mkdirSync(mirroredRunsDir(), { recursive: true });
		symlinkSync(join(repo, "..", `gone-${Date.now()}`), equilibrius());

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a dangling node link is said, not dropped without a word",
		).toContain(
			"The mirror from equilibrius couldn't be read (it is a link to nothing)",
		);
	});

	it("says a mirror copied one folder too high", async () => {
		await councilIn(join(equilibrius(), "runs"), REPO, head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a node holding a runs folder and no ledger is pointed out",
		).toContain("as if mirrored one folder too high");
	});

	it("says so when the mirrors can't be listed", async () => {
		mkdirSync(join(mirroredRunsDir(), ".."), { recursive: true });
		writeFileSync(mirroredRunsDir(), "not a folder");

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a runs-from that is a file is said, not taken as no mirror",
		).toMatch(/runs-from couldn't be listed \(.*ENOTDIR/);
	});

	it("counts a council here whatever the mirrors are", async () => {
		await councilIn(runDir(), REPO, head);
		writeFileSync(mirroredRunsDir(), "not a folder");

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"this machine's own council lets the change through",
		).toBeUndefined();
	});
});
