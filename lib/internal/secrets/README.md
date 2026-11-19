# Secrets

Credentials kept from what the model and the disk see, for the
scrubber, the stored results and the secret-run tool.

## Files

- **`marks.ts`**: the scrub's marks a write or an edit would add to
  a file that doesn't hold them, where they would replace the
  credentials they stand for, and why such a call is refused.
- **`secret-ask.ts`**: an agent's ask for one work secret as core's
  passwords daemon, or the secret-asks daemon before it, reads it, and
  the answer it writes beside it; only
  pi asks, from outside the fence, and an ask the daemon would refuse is
  refused before it's written.
- **`saved-output.ts`**: the file pi or pi-durable saved a long
  command's whole output to, scrubbed as its answer is, by the
  secret-scrub extension and by a host's tool round alike.
- **`secrets.ts`**: the shapes a credential takes in a tool's output,
  and how one is replaced by a mark naming its kind, for the answers,
  the saved output and the stored results that hold them; and one
  scrub of a tool's whole answer, read by the call's input.
- **`words.ts`**: the words of a printing of the environment, each
  judged on its own (which is a variable's name, which could be a
  credential), and the mark that stands where one was.
