/**
 * The guard keeps writes off pi's screen while it is up, and only then.
 *
 * Each case wraps a console and a stream of its own, so nothing here
 * touches the console the test runner prints through. The one case that
 * drives pi's real event bus wraps the process console, since that is
 * the console pi's bus writes to, and puts it back afterwards.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	guardOutput,
	type StrayWrite,
} from "../../../../lib/internal/stray/guard.ts";

/** A console and a stream that only remember what reached them. */
function terminal() {
	const printed: string[] = [];
	const written: string[] = [];
	const fake = {
		log: (...args: unknown[]) => printed.push(args.join(" ")),
		info: (...args: unknown[]) => printed.push(args.join(" ")),
		warn: (...args: unknown[]) => printed.push(args.join(" ")),
		error: (...args: unknown[]) => printed.push(args.join(" ")),
		debug: (...args: unknown[]) => printed.push(args.join(" ")),
		trace: (...args: unknown[]) => printed.push(args.join(" ")),
	} as unknown as Console;
	const stderr = {
		write: ((chunk: unknown, ...rest: unknown[]) => {
			written.push(String(chunk));
			const done = rest.find((arg) => typeof arg === "function");
			if (typeof done === "function") done();
			return true;
		}) as NodeJS.WriteStream["write"],
	};
	return { target: { console: fake, stderr }, printed, written };
}

describe("the stray output guard", () => {
	it("keeps a console call off the screen while it is up", () => {
		const { target, printed } = terminal();
		const caught: StrayWrite[] = [];
		guardOutput(
			(write) => caught.push(write),
			() => true,
			target,
		);

		target.console.error("boom %d", 7, { at: "here" });

		expect(printed).toEqual([]);
		expect(caught).toHaveLength(1);
		expect(caught[0]?.kind).toBe("console.error");
		expect(caught[0]?.text).toBe("boom 7 { at: 'here' }");
		expect(caught[0]?.stack).toContain("guard.test.ts");
	});

	it("keeps a direct write to standard error off it, and calls its callback", async () => {
		const { target, written } = terminal();
		const caught: StrayWrite[] = [];
		guardOutput(
			(write) => caught.push(write),
			() => true,
			target,
		);

		const flushed = new Promise<void>((resolve) => {
			target.stderr.write(Buffer.from("raw bytes\n"), () => resolve());
		});

		await flushed;
		expect(written).toEqual([]);
		expect(caught.map((write) => [write.kind, write.text])).toEqual([
			["stderr", "raw bytes\n"],
		]);
	});

	it("lets everything through while the screen is down, as for a crash report", () => {
		const { target, printed, written } = terminal();
		const caught: StrayWrite[] = [];
		let up = false;
		guardOutput(
			(write) => caught.push(write),
			() => up,
			target,
		);

		target.console.error("pi exiting due to uncaughtException:");
		target.stderr.write("after the screen stopped\n");
		up = true;
		target.console.log("while it is up");

		expect(printed).toEqual(["pi exiting due to uncaughtException:"]);
		expect(written).toEqual(["after the screen stopped\n"]);
		expect(caught.map((write) => write.text)).toEqual(["while it is up"]);
	});

	it("wraps once, and a later call only changes who handles the writes", () => {
		const { target, printed } = terminal();
		const first: string[] = [];
		const second: string[] = [];
		guardOutput(
			(write) => first.push(write.text),
			() => true,
			target,
		);
		const wrapped = target.console.warn;
		guardOutput(
			(write) => second.push(write.text),
			() => true,
			target,
		);

		target.console.warn("after the reload");

		expect(target.console.warn).toBe(wrapped);
		expect(first).toEqual([]);
		expect(second).toEqual(["after the reload"]);
		expect(printed).toEqual([]);
	});

	it("drops a write its own handler makes, and survives a handler that throws", () => {
		const { target, printed } = terminal();
		let calls = 0;
		guardOutput(
			() => {
				calls += 1;
				target.console.error("the handler's own complaint");
				throw new Error("cannot keep it");
			},
			() => true,
			target,
		);

		expect(() => target.console.error("first")).not.toThrow();
		expect(calls).toBe(1);
		expect(printed).toEqual([]);
	});

	it("catches what pi's event bus says of a handler that throws", async () => {
		const caught: StrayWrite[] = [];
		const saved = { ...console };
		const savedWrite = process.stderr.write;
		try {
			guardOutput(
				(write) => caught.push(write),
				() => true,
			);
			const bus = createEventBus();
			bus.on("demo:v1", () => {
				throw new TypeError("handler fell over");
			});
			bus.emit("demo:v1", {});
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(caught).toHaveLength(1);
			expect(caught[0]?.kind).toBe("console.error");
			expect(caught[0]?.text).toMatch(
				/^Event handler error \(demo:v1\): TypeError: handler fell over\n\s+at /,
			);
		} finally {
			// The process console is the runner's too: put back what it had,
			// slot and all, so nothing after this runs through the guard.
			Object.assign(console, saved);
			Reflect.deleteProperty(
				console,
				Symbol.for("agentic-harness.stray-output.guard.v1"),
			);
			process.stderr.write = savedWrite;
		}
	});
});
