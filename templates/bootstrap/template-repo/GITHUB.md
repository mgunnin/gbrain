# GITHUB.md

This workspace is durably backed up to **(not yet created — bootstrap repo sets this)**. The repository must
remain private.

- **Tracked:** identity files, memory, `brain/`, `skills/`, `state/interview.json`,
  `state/mcp.json`, schedules.
- **Ignored:** credentials, local databases, caches, hook state, transcripts, and
  anything matching the deny list in `.gitignore`.
- **How it syncs:** `gbrain sources push` — a secret-scan-gated commit + push that
  refuses public remotes. It runs at session end automatically; a 15-minute
  background job does the same if enabled. Run it by hand after meaningful changes.
- **If a push is blocked:** the scan names the file and pattern out loud. Fix or
  allowlist deliberately — never force past it silently.
- **Honest forget semantics:** git history is append-only. Deleting a line from a
  file does not delete it from history; truly removing something requires a history
  rewrite (documented in docs/guides/bootstrap.md). Write accordingly.
- **Recovery:** clone this repo on any machine and run `gbrain bootstrap attach` —
  the body travels; the brain database is rebuilt from `brain/` + re-ingestion.
- Never let valuable work exist only on one machine.
