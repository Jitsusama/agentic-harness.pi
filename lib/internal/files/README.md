# Files

Reading files once and keeping their parse until they change, so a
reader asked often reads only what moved, and an extension's state
kept across sessions.

## Files

- **`file-reads.ts`**: what each file in a folder said when the
  process last read it, asked again only once the file changes, so a
  ledger asked at every conversation's start reads only what moved.
- **`folder-mirror.ts`**: a folder's files and their parses, kept for a
  host's synchronous readers and read again off the thread each second
  while asked, so a stalled disk holds none of its conversations.
- **`stamped-read.ts`**: a file's parse kept while its inode, mtime
  and size say it is the same file, read on the thread or off it, for
  the mesh's presence listings.
- **`state.ts`**: persisting an extension's state across sessions
  and restoring it.
