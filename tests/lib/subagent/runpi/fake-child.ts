/**
 * A child process the runpi tests hand to an injected spawn, so they
 * can drive its output, its close and its errors without a real pi.
 *
 * Shared because the spawn and supervisor tests each built the same
 * fake by hand.
 */

import type { ChildProcess } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";

/** The part of a child process the runners listen to. */
export interface FakeChild {
	stdout: Readable;
	stderr: Readable;
	stdin?: Writable;
	on(event: "close", listener: (code: number | null) => void): FakeChild;
	once(event: "close", listener: (code: number | null) => void): FakeChild;
	once(event: "error", listener: (err: Error) => void): FakeChild;
	kill(signal?: NodeJS.Signals): boolean;
}

/** A fake child, and the levers that make it speak, close or fail. */
export interface FakeChildControls {
	readonly child: FakeChild;
	/** The fake as the type a spawn returns. */
	readonly process: () => ChildProcess;
	readonly emitClose: (code: number | null) => void;
	readonly emitError: (err: Error) => void;
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
	/** Every signal the child was killed with, in order. */
	readonly kills: Array<NodeJS.Signals | undefined>;
}

/** A child that says nothing until a test makes it. */
export function makeFakeChild(): FakeChildControls {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const kills: Array<NodeJS.Signals | undefined> = [];
	const handlers: {
		close: ((code: number | null) => void)[];
		error: ((err: Error) => void)[];
	} = { close: [], error: [] };
	const child: FakeChild = {
		stdout,
		stderr,
		on(event, listener) {
			if (event === "close") handlers.close.push(listener);
			return child;
		},
		once(event, listener) {
			if (event === "close")
				handlers.close.push(listener as (code: number | null) => void);
			if (event === "error")
				handlers.error.push(listener as (err: Error) => void);
			return child;
		},
		kill(signal) {
			kills.push(signal);
			return true;
		},
	};
	return {
		child,
		process: () => child as unknown as ChildProcess,
		emitClose: (code) => {
			for (const handler of handlers.close) handler(code);
		},
		emitError: (err) => {
			for (const handler of handlers.error) handler(err);
		},
		stdout,
		stderr,
		kills,
	};
}
