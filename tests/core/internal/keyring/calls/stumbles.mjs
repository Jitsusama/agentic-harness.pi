// A keyring call that can't run at all, leaving node's own several-line report on stderr, as a call script that won't load would.
for await (const _ of process.stdin);
const missing = "@napi-rs/no-such-keyring";
await import(missing);
