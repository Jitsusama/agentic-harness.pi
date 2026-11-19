/**
 * One Secret Service call, made in a process of its own for
 * secret-service.ts, so a crash inside the native keyring module ends
 * this process rather than the pi that asked.
 *
 * `@napi-rs/keyring` crashed the work background host with SIGSEGV
 * inside its own code on 18 November (the 17:26 core's stack is the
 * module's entry constructor, called from node), taking every hosted
 * conversation with it. Here, the same crash is one failed read.
 *
 * Run as `node secret-service-call.mjs`, told what to do as one JSON
 * line on stdin, `{ service, account, act, value? }`, where `act` is
 * read, write or remove, so a secret never rides on a command line. It
 * answers with one JSON line on stdout: `{ value }` for a read (null
 * when there is none), `{}` for the rest, or `{ error }`, then exits,
 * since the module's D-Bus connection would otherwise keep it alive.
 * Plain `.mjs`
 * because node runs it directly, from where consumers install this
 * package, and won't strip types there.
 */

/**
 * Reads all of stdin as text, decoded as one stream, so a character the
 * pipe's reads split comes out whole.
 */
async function input() {
	let text = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

/**
 * Makes the call `asked` names, answering as the header says.
 *
 * @param {{ service: string, account: string, act: string, value?: string }} asked
 */
async function answer(asked) {
	if (!["read", "write", "remove"].includes(asked.act)) {
		return { error: `no such keyring call: ${asked.act}` };
	}
	let AsyncEntry;
	try {
		({ AsyncEntry } = await import("@napi-rs/keyring"));
	} catch (error) {
		const said = error instanceof Error ? error.message : String(error);
		return {
			error: `its keyring module would not load: ${said.split("\n")[0]}`,
		};
	}
	// A module that loads without the entry or a call this uses says so,
	// rather than every call failing later as an unreachable keyring.
	const calls = AsyncEntry?.prototype ?? {};
	const lacking = ["getPassword", "setPassword", "deleteCredential"].filter(
		(name) => typeof Reflect.get(calls, name) !== "function",
	);
	if (typeof AsyncEntry !== "function" || lacking.length > 0) {
		return {
			error: `its keyring module has no AsyncEntry${lacking.length > 0 ? ` with ${lacking.join(", ")}` : ""}`,
		};
	}
	// Checked once the module has loaded but before any entry is made, so
	// its test proves the module loads without touching the keyring.
	if (asked.act === "write" && typeof asked.value !== "string") {
		return { error: "a write needs a value" };
	}
	const entry = new AsyncEntry(asked.service, asked.account, {
		linux: { store: "secret-service" },
	});
	if (asked.act === "read") {
		return { value: (await entry.getPassword()) ?? null };
	}
	if (asked.act === "write" && typeof asked.value === "string") {
		await entry.setPassword(asked.value);
		return {};
	}
	if (asked.act === "remove") {
		await entry.deleteCredential();
		return {};
	}
	// Only a write that lost its value reaches here; it never deletes.
	return { error: "a write needs a value" };
}

/** Answers what stdin asks, or why it couldn't, as one line. */
async function answered() {
	try {
		return await answer(JSON.parse(await input()));
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

process.stdout.write(`${JSON.stringify(await answered())}\n`, () =>
	process.exit(0),
);
