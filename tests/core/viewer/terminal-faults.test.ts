/** What one of pi's frames, keys or resizes throws goes to the screen, not the host. */
import { afterEach, describe, expect, it } from "vitest";
import { ambientSession } from "../../../lib/core/session/index.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

const terminals: ViewerTerminal[] = [];
afterEach(() => {
	for (const terminal of terminals.splice(0)) terminal.dispose();
});

/** A terminal on conversation "a" whose faults are kept, with the conversation each was in. */
function faulting(input: (data: string) => void, resize = () => {}) {
	const terminal = new ViewerTerminal("a", () => {});
	terminals.push(terminal);
	terminal.start(input, resize);
	const faults: { message: string; in: string | undefined }[] = [];
	terminal.whenFaulted((error) =>
		faults.push({
			message: error instanceof Error ? error.message : String(error),
			in: ambientSession(),
		}),
	);
	return { terminal, faults };
}

const viewer = (rows = 40, columns = 120) => ({
	rows,
	columns,
	write: () => {},
	disconnect: () => {},
});

describe("a throw in one of pi's callbacks", () => {
	it("from a frame reaches the fault listener, and the draw returns", () => {
		const { terminal, faults } = faulting(() => {});
		terminal.attach(viewer());

		terminal.renderScope(() => {
			throw new Error("This extension ctx is stale");
		});

		expect(faults).toEqual([
			{ message: "This extension ctx is stale", in: "a" },
		]);
	});

	it("from a key reaches the fault listener, and later keys still arrive", () => {
		const typed: string[] = [];
		const { terminal, faults } = faulting((data) => {
			if (data === "x") throw new Error("a key handler broke");
			typed.push(data);
		});
		const joined = terminal.attach(viewer());

		joined.input("x");
		joined.input("y");

		expect(faults.map((fault) => fault.message)).toEqual([
			"a key handler broke",
		]);
		expect(typed).toEqual(["y"]);
	});

	it("from a resize reaches the fault listener", () => {
		const { terminal, faults } = faulting(
			() => {},
			() => {
				throw new Error("measuring broke");
			},
		);
		terminal.attach(viewer(24, 80));

		expect(faults.map((fault) => fault.message)).toEqual(["measuring broke"]);
	});

	it("goes on up when no listener is set, as before", () => {
		const terminal = new ViewerTerminal("a", () => {});
		terminals.push(terminal);
		terminal.attach(viewer());

		expect(() =>
			terminal.renderScope(() => {
				throw new Error("unheard");
			}),
		).toThrow("unheard");
	});
});
