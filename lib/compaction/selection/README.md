# Excerpt Selection

Choosing which paragraphs of a session a compaction quotes word for word
beneath its summary. A session's messages are split into paragraphs, a
classifier model tags each with the kinds worth keeping, the tags are
recorded on the session, and at compaction the candidates still holding
are chosen within a budget and rendered, grouped by kind. Each file opens
by saying which of those steps it is.
