/** pi's startup questions on a hosted conversation's terminal, drawn by pi-tui and answered through pi's selector. */
import { describe, expect, it, vi } from "vitest";
import { hostedAskerOf } from "../../../host/screen/startup-ask.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

/** A stand-in for pi's ExtensionSelectorComponent: it draws its title and options, and keeps what to call. */
class Selector {
	static made: Selector | undefined;
	readonly title: string;
	readonly options: string[];
	readonly onSelect: (option: string) => void;
	readonly onCancel: () => void;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
	) {
		this.title = title;
		this.options = options;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		Selector.made = this;
	}

	render(): string[] {
		return [this.title, ...this.options];
	}

	invalidate(): void {
		// Nothing is cached to throw away.
	}
}

function viewing() {
	const terminal = new ViewerTerminal("a", () => undefined);
	const written: string[] = [];
	terminal.attach({
		rows: 24,
		columns: 80,
		write: (data) => written.push(data),
		disconnect: vi.fn(),
		edit: vi.fn(),
		suspend: vi.fn(),
	});
	return { terminal, shown: () => written.join("") };
}

function made(): Selector {
	if (!Selector.made) throw new Error("no selector was made");
	return Selector.made;
}

describe("a startup question on a hosted terminal", () => {
	it("is drawn for the conversation's viewers and answers the label picked", async () => {
		const { terminal, shown } = viewing();
		const asking = hostedAskerOf(Selector)(terminal, "Trust project folder?", [
			"Trust",
			"Don't trust",
		]);
		await vi.waitFor(() => expect(shown()).toContain("Trust project folder?"));
		expect(made().options).toEqual(["Trust", "Don't trust"]);

		made().onSelect("Trust");

		await expect(asking.answer).resolves.toBe("Trust");
	});

	it("answers nothing when dismissed or cancelled, and only once", async () => {
		const dismissed = hostedAskerOf(Selector)(viewing().terminal, "Trust?", [
			"Trust",
		]);
		made().onCancel();
		made().onSelect("Trust");
		await expect(dismissed.answer).resolves.toBeUndefined();

		const cancelled = hostedAskerOf(Selector)(viewing().terminal, "Trust?", [
			"Trust",
		]);
		cancelled.cancel();
		await expect(cancelled.answer).resolves.toBeUndefined();
	});

	it("refuses a pi without its selector", () => {
		expect(() => hostedAskerOf(undefined)).toThrow(
			"The host's pi exports no ExtensionSelectorComponent",
		);
	});
});
