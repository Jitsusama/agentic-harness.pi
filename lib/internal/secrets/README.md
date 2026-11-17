# Secrets

Credentials kept from what the model and the disk see, for the
scrubber, the stored results and the secret-run tool.

## Files

- **`secret-ask.ts`**: an agent's ask for one work secret as core's
  secret-asks daemon reads it, and the answer it writes beside it; only
  pi asks, from outside the fence, and an ask the daemon would refuse is
  refused before it's written.
- **`secrets.ts`**: the shapes a credential takes in a tool's output,
  and how one is replaced by a mark naming its kind, for the answers,
  the saved output and the stored results that hold them.
