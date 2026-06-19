/**
 * Tokenizer for the command model. Turns a bash command string
 * into a lossless, range-indexed CommandLine.
 */

import type { CommandLine } from "./types.js";

/** Tokenize a bash command line into a CommandLine. */
export function tokenize(source: string): CommandLine {
	return { source, commands: [], connectors: [], supported: true };
}
