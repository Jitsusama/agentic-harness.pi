/**
 * The viewer bridge that notices input: each key and resize a viewer
 * sends is noticed before the screen takes it, and nothing else is.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	ViewerBridge,
	ViewerConnection,
} from "../../../host/service/server.ts";
import { noticingInput } from "../../../host/service/viewer.ts";

describe("a bridge noticing input", () => {
	function bridged() {
		const order: string[] = [];
		const connection: ViewerConnection = {
			input: (data) => order.push(`input ${data}`),
			resize: (rows, columns) => order.push(`resize ${rows}x${columns}`),
			edited: (id, text) => order.push(`edited ${id} ${text}`),
			detach: () => order.push("detach"),
		};
		const inner: ViewerBridge = { attach: () => connection };
		const noticed = vi.fn(() => order.push("noticed"));
		const attached = noticingInput(inner, noticed).attach(
			{ v: 1, id: "r", op: "attach", sessionId: "s", rows: 24, columns: 80 },
			{
				write: () => {},
				disconnect: () => {},
				edit: () => {},
				suspend: () => {},
			},
		);
		return { attached, noticed, order };
	}

	it("notices a key before the screen takes it", () => {
		const { attached, order } = bridged();
		attached.input("a");
		expect(order).toEqual(["noticed", "input a"]);
	});

	it("notices a resize before the screen takes it", () => {
		const { attached, order } = bridged();
		attached.resize(30, 100);
		expect(order).toEqual(["noticed", "resize 30x100"]);
	});

	it("passes an edit and a detach on without noticing them", () => {
		const { attached, noticed, order } = bridged();
		attached.edited?.("e", "text");
		attached.detach();
		expect(noticed).not.toHaveBeenCalled();
		expect(order).toEqual(["edited e text", "detach"]);
	});
});
