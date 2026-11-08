# Secret Scrub Interceptor

Puts every credential in a tool's answer out of sight before the model
reads it or pi writes it to the session's log. In its place go words
naming what it was, such as `[secret scrubbed: GitHub token]`.

## What It Does

An agent's tools print what they find, and some of it is a credential:
a token in a shell's history, a key in a file read, a service's JSON
answer. Once in a result, it sat in the model's context, went to the
provider with every later turn, and stayed in the session's log. On
7 November, 84 of one machine's 625 session logs held a token-shaped
string, and a backup copied those logs off the machine every hour.

So every answer's text, its details and its structured answer are read
for the shapes in `secrets.ts`, and each one found is replaced:

- **Shapes a service gives its credentials:** GitHub, npm, Anthropic,
  OpenAI, AWS, Google, Slack and Shopify tokens, age identities, JSON
  web tokens and private keys in PEM form.
- **Places a credential sits:** a shell variable whose name ends in
  TOKEN, SECRET, PASSWORD, API_KEY or ACCESS_KEY, an npmrc's
  `_authToken`, a JSON field such as `refresh_token`, and a `Bearer`
  header. The name stays and only the value goes. The value has to be
  16 characters or more, with a letter and a digit, and not start with
  `$`, so a variable passed on or a function's name is left alone.

A picture is handed on as it is, and an answer with nothing to hide is
handed on untouched.

Silent, like every interceptor: the mark tells the agent a secret was
there, so it knows not to ask for it again. An agent that needs a
credential passes it by reference (a file, a variable, a helper) rather
than reading it.
