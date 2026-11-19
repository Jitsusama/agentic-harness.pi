// A keyring call that won't run, leaving node's own several-line report on stderr, as a missing module does.
for await (const _ of process.stdin);
process.stderr.write(
	[
		"node:internal/modules/esm/resolve:873",
		"  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
		"        ^",
		"",
		"Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@napi-rs/keyring'",
		"    at packageResolve (node:internal/modules/esm/resolve:873:9)",
		"    at moduleResolve (node:internal/modules/esm/resolve:946:18) {",
		"  code: 'ERR_MODULE_NOT_FOUND'",
		"}",
		"",
		"Node.js v22.23.5",
		"",
	].join("\n"),
);
process.exitCode = 1;
