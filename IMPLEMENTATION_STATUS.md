# Implementation status — read before using/submitting

This is an integrated **Groq-configured prototype** with three services and seed data. It is not a fully verified or assessment-ready final submission yet. Python files passed `py_compile` in the build environment. A local TypeScript build could not be verified because npm dependency installation timed out in this environment; run `npm install && npm run build` locally.

## Included
- Task 1 Knowledge Brain: sitemap crawl, article cleaning/chunking, persisted SQLite article/chunk/escalation/ingestion metadata, retrieval, grounded Groq answer generation, citations, and human escalation paths.
- Task 2 Inbox Agent: Groq classification and draft generation, calls Task 1 API, review/approve/edit/reject endpoints, and 20-consecutive-unedited-approval eligibility tracking for low-risk `how_to` only. It does not send emails.
- Task 3 Meeting-to-Scope: Groq structured transcript analysis, calls Task 1 to check each requirement, proposal/estimate output, follow-up scope-change comparison, and human approval endpoints.
- 50 synthetic customer emails, three meeting transcripts, and 20 starter evaluation cases per task.
- Docker Compose and submission documentation templates.

## Remaining work before submission
- Screenshot/vision understanding is not implemented; images are only recorded as URL/alt metadata.
- Daily scheduled ingestion and robust per-URL resume/retry dashboard are incomplete. Check actual ingestion-run outcomes.
- Task 2 drafts/feedback/streaks and Task 3 project state are in memory and reset on service restart; persistent storage is required for production/robust assessment use.
- Evaluation case expected fields are placeholders. Label expected outcomes, run at least 20 cases per task, and record actual pass/fail, quality, latency, and token/cost results.
- The assessment instructions may require comparing at least two Claude model/configuration choices. This Groq-only configuration does **not** satisfy a mandatory Claude comparison unless the assessor explicitly accepts the substitution. Do not fabricate Claude results.
- Verify the crawler against current site terms/rate limits, validate citations and abstention, review security, and test all endpoints and failure cases.
- Test `docker compose up --build` and the TypeScript build on your own machine before claiming one-command startup works.
- Record actual coding-assistant conversations in `AI_LOG.md`; do not invent history.

## Local checks performed in this packaging session
- Python syntax compilation: passed for Task 1 and Task 3.
- TypeScript/npm build: not verified (dependency install timed out).
- Live Groq calls, full crawl, Docker startup, and end-to-end integration: not run.
