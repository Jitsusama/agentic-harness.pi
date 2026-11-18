// A keyring call that answers as the real one does when the Secret Service refuses: one line naming why.
for await (const _ of process.stdin);
process.stdout.write(
	`${JSON.stringify({ error: "the collection is locked" })}\n`,
);
