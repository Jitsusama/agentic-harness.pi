import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { auditQuestRecord } from "@jitsusama/agentic-harness.core/quest/record-audit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyRecordMigration,
	planRecordMigration,
	renderManifest,
} from "../../scripts/migrate-quests-record";

const A = "QEST-20260924-AAAAAA";
const B = "QEST-20260924-BBBBBB";
const PLAN = "PLAN-20260924-CCCCCC";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]);

let root: string;
let questsRoot: string;
let workspaceRoot: string;

function put(rel: string, content: string | Uint8Array = "x\n"): void {
	const path = join(questsRoot, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function read(rel: string): string {
	return readFileSync(join(questsRoot, rel), "utf8");
}

function readme(id: string, body: string): string {
	return `---\nid: ${id}\nkind: quest\nstatus: active\n---\n\n# ${id}\n\n${body}\n\n## 🌄 Journey\n\n- **2026-09-24**: Created.\n`;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "record-migrate-"));
	questsRoot = join(root, "quests");
	workspaceRoot = join(root, "workspace");
	put(
		`${A}/README.md`,
		readme(
			A,
			[
				"![Chart](evidence/chart.png)",
				"",
				"Raw rows in `evidence/big.jsonl`.",
				"",
				"```sh",
				"cat evidence/other.txt",
				"```",
			].join("\n"),
		),
	);
	put(
		`${A}/plans/${PLAN}.md`,
		"# Plan\n\nSee [notes](../research/notes.md) and `lab/`.\n",
	);
	put(`${A}/evidence/chart.png`, PNG);
	put(`${A}/evidence/big.jsonl`, "{}\n");
	put(`${A}/evidence/other.txt`);
	put(
		`${A}/research/notes.md`,
		`Back to [the plan](../plans/${PLAN}.md), up \`../\`.\n`,
	);
	put(`${A}/research/portfolio/a.md`);
	put(`${A}/research/portfolio/img.png`, PNG);
	put(`${A}/research/portfolio/data.csv`, "a,b\n");
	put(`${A}/research/clone/.git/HEAD`, "ref: refs/heads/main\n");
	put(`${A}/research/clone/README.md`);
	put(`${A}/HANDOFF.md`);
	put(`${A}/.gitignore`, "*\n");
	put(`${A}/lab/run.log`);
	put(
		`${B}/README.md`,
		readme(B, `Borrowed ![chart](../${A}/evidence/chart.png).`),
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function movesOf(plan: ReturnType<typeof planRecordMigration>) {
	return plan.moves
		.map((m) => {
			const to = m.to.startsWith(workspaceRoot)
				? `ws:${relative(join(workspaceRoot, m.quest), m.to)}`
				: relative(join(questsRoot, m.quest), m.to);
			return `${m.quest === A ? "A" : "B"} ${m.rel} -> ${to} (${m.reason}${m.group ? ` ${m.group}` : ""})`;
		})
		.sort();
}

describe("planRecordMigration", () => {
	it("sorts each stray into cited attachments, the review bucket and the workspace", () => {
		const plan = planRecordMigration({ questsRoot, workspaceRoot });
		expect(movesOf(plan)).toEqual([
			"A .gitignore -> ws:.gitignore (working)",
			`A HANDOFF.md -> attachments/HANDOFF.md (review ${A})`,
			"A evidence -> ws:evidence (working)",
			"A evidence/chart.png -> attachments/evidence/chart.png (cited)",
			"A lab -> ws:lab (working)",
			"A research/clone -> ws:research/clone (working)",
			"A research/notes.md -> attachments/research/notes.md (cited)",
			"A research/portfolio -> ws:research/portfolio (working)",
			`A research/portfolio/a.md -> attachments/research/portfolio/a.md (review ${A}/research/portfolio)`,
			`A research/portfolio/img.png -> attachments/research/portfolio/img.png (review ${A}/research/portfolio)`,
		]);
		expect(plan.collisions).toEqual([]);
	});

	it("leaves a group Joel sends to the workspace inside its folder", () => {
		const plan = planRecordMigration({
			questsRoot,
			workspaceRoot,
			toWorkspace: [`${A}/research/portfolio`],
		});
		const moves = movesOf(plan);
		expect(moves.filter((m) => m.includes("research/portfolio"))).toEqual([
			"A research/portfolio -> ws:research/portfolio (working)",
		]);
		expect(moves).toContain(
			`A HANDOFF.md -> attachments/HANDOFF.md (review ${A})`,
		);
	});

	it("sends a loose file in a group sent to the workspace there directly", () => {
		const plan = planRecordMigration({
			questsRoot,
			workspaceRoot,
			toWorkspace: [A],
		});
		expect(movesOf(plan)).toContain("A HANDOFF.md -> ws:HANDOFF.md (working)");
	});

	it("leaves a skipped quest, and links into it, for a later run", () => {
		const plan = planRecordMigration({ questsRoot, workspaceRoot, skip: [A] });
		expect(plan.moves).toEqual([]);
		expect(plan.rewrites).toEqual([]);
	});

	it("still points a skipped quest's links at what moved elsewhere", () => {
		const plan = planRecordMigration({ questsRoot, workspaceRoot, skip: [B] });
		expect(plan.moves.every((m) => m.quest === A)).toBe(true);
		const readmeOfB = plan.rewrites.find((r) => r.quest === B);
		expect(readmeOfB?.changes).toEqual([
			{
				before: `../${A}/evidence/chart.png`,
				after: `../${A}/attachments/evidence/chart.png`,
			},
		]);
	});

	it("reports a destination that already exists and does not plan over it", () => {
		mkdirSync(join(workspaceRoot, A, "lab"), { recursive: true });
		const plan = planRecordMigration({ questsRoot, workspaceRoot });
		expect(movesOf(plan).some((m) => m.startsWith("A lab "))).toBe(false);
		expect(plan.collisions).toEqual([
			`${A}/lab: ${join(workspaceRoot, A, "lab")} already exists`,
		]);
	});
});

describe("applyRecordMigration", () => {
	function migrate() {
		const journal = join(root, "journal.json");
		const plan = planRecordMigration({ questsRoot, workspaceRoot });
		applyRecordMigration(plan, {
			journal,
			now: () => new Date("2026-09-25T12:00:00"),
		});
		return { plan, journal };
	}

	it("moves every stray and leaves each record whole", () => {
		migrate();
		for (const quest of [A, B]) {
			const audit = auditQuestRecord(join(questsRoot, quest));
			expect(audit.strays).toEqual([]);
			expect(audit.broken).toEqual([]);
		}
		expect(existsSync(join(workspaceRoot, A, "evidence", "big.jsonl"))).toBe(
			true,
		);
		expect(
			existsSync(join(workspaceRoot, A, "research", "clone", ".git")),
		).toBe(true);
		expect(
			existsSync(join(questsRoot, A, "attachments", "evidence", "chart.png")),
		).toBe(true);
	});

	it("rewrites references to where their targets went, leaving code blocks alone", () => {
		migrate();
		const ws = join(workspaceRoot, A);
		const readmeText = read(`${A}/README.md`);
		expect(readmeText).toContain("![Chart](attachments/evidence/chart.png)");
		expect(readmeText).toContain(`\`${ws}/evidence/big.jsonl\``);
		expect(readmeText).toContain("cat evidence/other.txt");
		expect(read(`${A}/plans/${PLAN}.md`)).toBe(
			`# Plan\n\nSee [notes](../attachments/research/notes.md) and \`${ws}/lab/\`.\n`,
		);
		expect(read(`${A}/attachments/research/notes.md`)).toBe(
			`Back to [the plan](../../plans/${PLAN}.md), up \`../\`.\n`,
		);
		expect(read(`${B}/README.md`)).toContain(
			`![chart](../${A}/attachments/evidence/chart.png)`,
		);
	});

	it("cites the review groups it kept from a Journey entry", () => {
		migrate();
		const journey = read(`${A}/README.md`).split("## 🌄 Journey")[1];
		expect(journey).toMatch(/^\n\n- \*\*2026-09-25\*\*: Moved working/);
		expect(journey).toContain("`attachments/HANDOFF.md`");
		expect(journey).toContain("`attachments/research/portfolio/`");
		expect(auditQuestRecord(join(questsRoot, A)).uncited).toEqual([]);
	});

	it("writes a journal of every move and rewrite, and finds nothing left to do", () => {
		const { plan, journal } = migrate();
		const written = JSON.parse(readFileSync(journal, "utf8"));
		expect(written.moves).toHaveLength(plan.moves.length);
		expect(written.rewrites.map((r: { file: string }) => r.file)).toContain(
			join(questsRoot, B, "README.md"),
		);
		const again = planRecordMigration({ questsRoot, workspaceRoot });
		expect(again.moves).toEqual([]);
		expect(again.rewrites).toEqual([]);
	});
});

describe("renderManifest", () => {
	it("totals each destination and lists the review groups for a decision", () => {
		const manifest = renderManifest(
			planRecordMigration({ questsRoot, workspaceRoot }),
		);
		expect(manifest).toContain(`\`${A}/research/portfolio\``);
		expect(manifest).toMatch(/review bucket \| 3 \|/);
		expect(manifest).toMatch(/cited \| 2 \|/);
	});
});
