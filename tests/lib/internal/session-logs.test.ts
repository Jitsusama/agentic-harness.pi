import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FetchLog,
	readAway,
	sessionLogs,
} from "../../../lib/internal/session-logs.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");

let root: string;
let sessionsDir: string;
let indexPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "session-logs-"));
	sessionsDir = join(root, "sessions");
	indexPath = join(root, "state", "session-backup", "index.jsonl");
	mkdirSync(dirname(indexPath), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A log on the machine for session `id`, last written `ago` before now. */
function logHere(id: string, ago: number): string {
	const dir = join(sessionsDir, "--home-a--");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(path, `{"type":"session","id":"${id}"}\n`);
	const at = new Date(NOW - ago);
	utimesSync(path, at, at);
	return path;
}

/** Index rows, as session-backup keeps them. */
function index(...rows: { name: string; id: string | null; ended: string }[]) {
	writeFileSync(indexPath, rows.map((row) => JSON.stringify(row)).join("\n"));
}

describe("which logs a span holds", () => {
	it("lists the machine's logs written in the span, and the index's others", () => {
		const here = logHere("s-here", 2 * DAY_MS);
		logHere("s-stale", 40 * DAY_MS);
		index(
			{ name: "h/a/s-here.1.age", id: "s-here", ended: "2026-10-26T12:00:00Z" },
			{ name: "h/a/s-away.1.age", id: "s-away", ended: "2026-10-20T00:00:00Z" },
			{ name: "h/a/s-old.1.age", id: "s-old", ended: "2026-07-01T00:00:00Z" },
		);

		const logs = sessionLogs(NOW - 30 * DAY_MS, { sessionsDir, indexPath });

		expect(logs.here).toEqual([here]);
		// A session still on the machine is read from there, and one that
		// ended before the span holds nothing for it.
		expect(logs.away.map((log) => log.name)).toEqual(["h/a/s-away.1.age"]);
	});

	it("reads a session sent more than once from its last copy", () => {
		index(
			{ name: "h/a/s-1.1.age", id: "s-1", ended: "2026-10-20T00:00:00Z" },
			{ name: "h/a/s-1.2.age", id: "s-1", ended: "2026-10-22T00:00:00Z" },
			{ name: "h/a/odd.1.age", id: null, ended: "2026-10-21T00:00:00Z" },
		);

		const logs = sessionLogs(NOW - 30 * DAY_MS, { sessionsDir, indexPath });

		expect(logs.away.map((log) => log.name).sort()).toEqual([
			"h/a/odd.1.age",
			"h/a/s-1.2.age",
		]);
	});

	it("lists only the machine's logs where there is no index", () => {
		const here = logHere("s-here", DAY_MS);
		rmSync(indexPath, { force: true });

		expect(sessionLogs(0, { sessionsDir, indexPath })).toEqual({
			here: [here],
			away: [],
		});
	});

	it("passes over an index line cut short", () => {
		writeFileSync(
			indexPath,
			`${JSON.stringify({ name: "h/a/s-1.1.age", id: "s-1", ended: "2026-10-20T00:00:00Z" })}\n{"name":"h/a/s-2`,
		);

		expect(sessionLogs(0, { sessionsDir, indexPath }).away).toHaveLength(1);
	});
});

describe("reading the logs on Drive only", () => {
	const away = [
		{ name: "h/a/s-1.1.age", id: "s-1", ended: "2026-10-20T00:00:00Z" },
		{ name: "h/a/s-2.1.age", id: "s-2", ended: "2026-10-21T00:00:00Z" },
	];

	it("reads each copy back and keeps none of them past the read", () => {
		const fetched: string[] = [];
		const fetch: FetchLog = (name, to) => {
			fetched.push(to);
			writeFileSync(to, `copy of ${name}\n`);
		};

		const result = readAway(away, (path) => readFileSync(path, "utf8"), fetch);

		expect(result).toEqual({
			read: ["copy of h/a/s-1.1.age\n", "copy of h/a/s-2.1.age\n"],
			unread: 0,
		});
		const folder = dirname(fetched[0] ?? "");
		expect(existsSync(folder)).toBe(false);
	});

	it("counts a copy it couldn't read back and goes on to the next", () => {
		const fetch: FetchLog = (name, to) => {
			if (name.includes("s-1")) throw new Error("Drive stayed busy");
			writeFileSync(to, "two\n");
		};

		const result = readAway(away, (path) => readFileSync(path, "utf8"), fetch);

		expect(result).toEqual({
			read: ["two\n"],
			unread: 1,
			why: "Drive stayed busy",
		});
	});

	it("reads nothing back and says why when session-backup isn't here", () => {
		let tries = 0;
		const fetch: FetchLog = () => {
			tries += 1;
			throw Object.assign(new Error("spawn session-backup ENOENT"), {
				code: "ENOENT",
			});
		};

		const result = readAway(away, () => "never", fetch);

		expect(tries).toBe(1);
		expect(result.read).toEqual([]);
		expect(result.unread).toBe(2);
		expect(result.why).toMatch(/session-backup isn't on this machine/);
	});

	it("leaves the reader's own failure to the reader's caller", () => {
		const fetch: FetchLog = (_name, to) => copyFileSync(indexPath, to);
		writeFileSync(indexPath, "x\n");

		expect(() =>
			readAway(
				away,
				() => {
					throw new Error("a bug in the sensor");
				},
				fetch,
			),
		).toThrow("a bug in the sensor");
		expect(
			readdirSync(tmpdir()).some((name) => name.startsWith("away-logs-")),
		).toBe(false);
	});
});
