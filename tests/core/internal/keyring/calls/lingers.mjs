// A keyring call that answers and then stays running, as one whose D-Bus connection keeps it alive would.
for await (const _ of process.stdin);
process.stdout.write(`${JSON.stringify({ value: "value" })}\n`);
setInterval(() => undefined, 60_000);
