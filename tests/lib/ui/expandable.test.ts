import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { expandable } from "../../../lib/ui/expandable.ts";

const lines = (_width: number, expanded: boolean) =>
	expanded ? ["head", "body"] : ["head"];

const mouse = (over: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x: 0,
	y: 0,
	screenX: 0,
	screenY: 0,
	width: 80,
	height: 1,
	shift: false,
	alt: false,
	ctrl: false,
	...over,
});

const press = (component: Component, event = mouse()) =>
	component.handleMouse?.(event);

describe("an entry a click opens", () => {
	it("opens and closes on a left click", () => {
		const entry = expandable({}, false, lines);
		expect(entry.render(80)).toEqual(["head"]);
		expect(press(entry)).toMatchObject({ handled: true });
		expect(entry.render(80)).toEqual(["head", "body"]);
		press(entry);
		expect(entry.render(80)).toEqual(["head"]);
	});

	it("leaves presses and other buttons alone, so text can still be selected", () => {
		const entry = expandable({}, false, lines);
		expect(press(entry, mouse({ type: "press" }))).toBeUndefined();
		expect(press(entry, mouse({ button: "right" }))).toBeUndefined();
		expect(entry.render(80)).toEqual(["head"]);
	});

	it("stays open when pi builds the entry again", () => {
		const message = {};
		press(expandable(message, false, lines));
		expect(expandable(message, false, lines).render(80)).toEqual([
			"head",
			"body",
		]);
		expect(expandable({}, false, lines).render(80)).toEqual(["head"]);
	});

	it("draws its lines once for a width and state, and again when either changes", () => {
		const asked: string[] = [];
		const counted = (width: number, expanded: boolean) => {
			asked.push(`${width} ${expanded}`);
			return lines(width, expanded);
		};
		const entry = expandable({}, false, counted);
		entry.render(80);
		entry.render(80);
		expect(asked).toEqual(["80 false"]);
		entry.render(60);
		press(entry);
		expect(entry.render(60)).toEqual(["head", "body"]);
		entry.invalidate();
		entry.render(60);
		expect(asked).toEqual(["80 false", "60 false", "60 true", "60 true"]);
	});

	it("follows the expand key once it is pressed after a click", () => {
		const message = {};
		press(expandable(message, false, lines));
		expect(expandable(message, true, lines).render(80)).toEqual([
			"head",
			"body",
		]);
		expect(expandable(message, false, lines).render(80)).toEqual(["head"]);
	});
});
