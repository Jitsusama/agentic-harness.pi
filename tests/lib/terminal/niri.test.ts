/**
 * Asking niri to open a window on its orchestrator's workspace, in its
 * order: its IPC, one JSON line each way, the workspace told only when
 * one window carries a title it names, the column, and the move after
 * open for a niri that can't be asked beforehand.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classOfItsOwn,
	columnFor,
	moveOnceOpen,
	type NiriCall,
	niriAt,
	placeWindow,
	windowsIn,
	workspaceTitled,
} from "../../../lib/terminal/niri.ts";

let dir: string;
let server: Server | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "niri-"));
});

afterEach(async () => {
	await new Promise<void>((done) =>
		server ? server.close(() => done()) : done(),
	);
	server = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** A niri socket answering each request line with `answer` of it. */
async function socketAnswering(
	answer: (request: unknown) => string | undefined,
): Promise<string> {
	const path = join(dir, "niri.sock");
	server = createServer((stream) => {
		stream.on("data", (chunk) => {
			const line = chunk.toString("utf8").split("\n")[0] ?? "";
			const reply = answer(JSON.parse(line));
			if (reply !== undefined) stream.write(`${reply}\n`);
		});
	});
	await new Promise<void>((done) => server?.listen(path, done));
	return path;
}

describe("niri's IPC", () => {
	it("sends one request on a line and answers its reply", async () => {
		const seen: unknown[] = [];
		const socket = await socketAnswering((request) => {
			seen.push(request);
			return JSON.stringify({ Ok: { Windows: [] } });
		});

		expect(await niriAt(socket)("Windows")).toEqual({ Ok: { Windows: [] } });
		expect(seen).toEqual(["Windows"]);
	});

	it("gives up on a niri that doesn't answer", async () => {
		const socket = await socketAnswering(() => undefined);

		await expect(niriAt(socket, 50)("Windows")).rejects.toThrow(
			"niri didn't answer in time",
		);
	});

	it("fails when there is no niri to reach", async () => {
		await expect(niriAt(join(dir, "none.sock"))("Windows")).rejects.toThrow();
	});
});

describe("the asker's workspace", () => {
	const windows = windowsIn({
		Ok: {
			Windows: [
				{ title: "π - Harness - agentic-harness.pi", workspace_id: 3 },
				{ title: "π - Twice - delta", workspace_id: 1 },
				{ title: "π - Twice - delta", workspace_id: 5 },
				{ title: "floating", workspace_id: null },
			],
		},
	});

	it("is the one holding the only window of its title", () => {
		expect(workspaceTitled(windows, "π - Harness - agentic-harness.pi")).toBe(
			3,
		);
	});

	it("is not told when two windows share the title, or none has it", () => {
		expect(workspaceTitled(windows, "π - Twice - delta")).toBeUndefined();
		expect(workspaceTitled(windows, "π - Gone - core.nix")).toBeUndefined();
	});

	it("reads nothing from a reply that isn't a window list", () => {
		expect(windowsIn({ Err: "no" })).toEqual([]);
	});

	it("reads a window's id, class and column where niri gives them", () => {
		expect(
			windowsIn({
				Ok: {
					Windows: [
						{
							title: "zsh",
							workspace_id: 2,
							id: 41,
							app_id: "pi-spawned",
							layout: { pos_in_scrolling_layout: [4, 1] },
						},
					],
				},
			}),
		).toEqual([
			{ title: "zsh", workspace: 2, id: 41, appId: "pi-spawned", column: 4 },
		]);
	});
});

describe("a window's column", () => {
	const lead = "π - Lead - core.nix";
	const windows = windowsIn({
		Ok: {
			Windows: [
				{ title: lead, workspace_id: 5, layout: at(1) },
				{ title: "π - Bravo - core.nix", workspace_id: 5, layout: at(2) },
				{ title: "π - Delta - core.nix", workspace_id: 5, layout: at(3) },
				{ title: "π - Alpha - elsewhere", workspace_id: 6, layout: at(1) },
			],
		},
	});
	function at(column: number) {
		return { pos_in_scrolling_layout: [column, 1] };
	}

	it("is first for its orchestrator's own window", () => {
		expect(columnFor(windows, 5, lead, lead)).toBe(1);
	});

	it("follows its orchestrator and the titles that sort before its own", () => {
		expect(columnFor(windows, 5, "π - Charlie - core.nix", lead)).toBe(3);
		expect(columnFor(windows, 5, "π - Echo - core.nix", lead)).toBe(4);
	});

	it("takes the place of a window of its own title rather than following it", () => {
		expect(columnFor(windows, 5, "π - Bravo - core.nix", lead)).toBe(2);
	});

	it("is first on a workspace holding nothing before it", () => {
		expect(columnFor(windows, 7, "π - Alpha - core.nix", lead)).toBe(1);
	});
});

describe("a class of its own", () => {
	it("is one the compositor's rule for spawned windows matches, never the same twice", () => {
		const first = classOfItsOwn(4242);
		const second = classOfItsOwn(4242);

		expect(first).toMatch(/^pi-spawned(\.[0-9]+)?$/);
		expect(second).not.toBe(first);
	});

	it("is never the same from two copies of the module in one process, as a reload makes", async () => {
		vi.resetModules();
		const one = await import("../../../lib/terminal/niri.ts");
		vi.resetModules();
		const other = await import("../../../lib/terminal/niri.ts");

		expect(
			one.classOfItsOwn,
			"each import loads a copy of its own",
		).not.toBe(other.classOfItsOwn);
		expect(one.classOfItsOwn(4242)).not.toBe(other.classOfItsOwn(4242));
	});
});

/** A niri holding `windows`, answering every action as `act` says. */
function desk(
	windows: unknown[],
	act: (request: unknown) => unknown = () => ({ Ok: "Handled" }),
): { asked: unknown[]; call: NiriCall } {
	const asked: unknown[] = [];
	return {
		asked,
		call: async (request) => {
			asked.push(request);
			return request === "Windows"
				? { Ok: { Windows: windows } }
				: act(request);
		},
	};
}

describe("placing a window", () => {
	const lead = "π - Lead - core.nix";
	const own = "π - Mine - core.nix";

	it("is not asked of a niri that knows no window of a title it names", async () => {
		const niri = desk([]);
		const placed = await placeWindow(niri.call, { beside: [lead, own] });

		expect(placed).toBeUndefined();
		expect(niri.asked).toEqual(["Windows"]);
	});

	it("goes to the first title found alone, its orchestrator's before its own", async () => {
		const niri = desk([
			{ title: own, workspace_id: 2 },
			{ title: lead, workspace_id: 5 },
		]);
		const placed = await placeWindow(
			niri.call,
			{ beside: [lead, own], first: lead, title: own },
			"pi-spawned.1",
		);

		expect(placed).toEqual({
			windowClass: "pi-spawned.1",
			workspace: 5,
			column: 1,
			asked: true,
		});
		expect(niri.asked[1]).toEqual({
			Action: {
				OpenNextWindowOn: {
					app_id: "pi-spawned.1",
					reference: { Id: 5 },
					column: 1,
				},
			},
		});
	});

	it("asks again without a column when niri refuses one", async () => {
		const niri = desk([{ title: lead, workspace_id: 5 }], (request) =>
			JSON.stringify(request).includes("column")
				? { Err: "error parsing request" }
				: { Ok: "Handled" },
		);
		const placed = await placeWindow(niri.call, {
			beside: [lead],
			first: lead,
			title: own,
		});

		expect(placed).toMatchObject({ workspace: 5, asked: true });
		expect(placed?.column).toBeUndefined();
	});

	it("is answered as not asked by a niri that refuses the ask", async () => {
		const niri = desk([{ title: lead, workspace_id: 5 }], () => ({
			Err: "error parsing request",
		}));
		const placed = await placeWindow(niri.call, { beside: [lead] });

		expect(placed).toMatchObject({ workspace: 5, asked: false });
	});
});

describe("moving a window once it opens", () => {
	const placed = {
		windowClass: "pi-spawned.7",
		workspace: 5,
		asked: false,
	} as const;
	const quick = { waitMs: 100, everyMs: 5 };

	it("moves the window of its class there, without focus", async () => {
		const niri = desk([
			{ title: "zsh", workspace_id: 1, id: 41, app_id: "pi-spawned.7" },
		]);

		expect(
			await moveOnceOpen(niri.call, placed, quick),
			"a window open on workspace 1 is moved",
		).toBe(true);
		expect(niri.asked[1]).toEqual({
			Action: {
				MoveWindowToWorkspace: {
					window_id: 41,
					reference: { Id: 5 },
					focus: false,
				},
			},
		});
	});

	it("leaves a window already there alone", async () => {
		const niri = desk([
			{ title: "zsh", workspace_id: 5, id: 41, app_id: "pi-spawned.7" },
		]);

		expect(
			await moveOnceOpen(niri.call, placed, quick),
			"a window already on workspace 5 counts as placed",
		).toBe(true);
		expect(niri.asked).toEqual(["Windows"]);
	});

	it("gives up on a window that doesn't open in time", async () => {
		const niri = desk([{ title: "zsh", workspace_id: 1, id: 41, app_id: "x" }]);

		expect(
			await moveOnceOpen(niri.call, placed, quick),
			"no window of the class opened, so none is placed",
		).toBe(false);
		expect(JSON.stringify(niri.asked)).not.toContain("MoveWindowToWorkspace");
	});
});
