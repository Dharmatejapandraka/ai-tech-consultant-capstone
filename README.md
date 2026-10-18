# AI Tech Consultant Capstone — Groq-ready integrated prototype

Three cooperating services for the assessment: (1) Knowledge Brain, (2) Inbox Agent, and (3) Meeting-to-Scope. The inbox and meeting services call the Knowledge Brain API; they do not maintain separate retrieval indexes. The default LLM provider is Groq's OpenAI-compatible chat-completions endpoint.

> **Important:** This is an implementation project, not a guarantee of assessment completion. Run the code and evaluation suite, review generated outputs, collect genuine model comparison metrics, and update the status documents honestly. If the assessment specifically requires comparing two Claude models/configurations, Groq-only execution does not satisfy that exact requirement unless the assessor approves an alternative. Do not claim Claude evaluation results that you did not run.

## Prerequisites
- Python 3.11+
- Node.js 20+
- Groq API key from https://console.groq.com/
- Internet access for initial help-centre crawl; optional Docker Compose

## Quick start (Windows PowerShell)
1. Extract the ZIP and open a terminal in the project root.
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY`.
3. If Docker is installed, run `docker compose up --build` from the root.
4. Open Knowledge Brain docs at `http://localhost:8001/docs`, Inbox Agent at `http://localhost:8002`, Meeting-to-Scope docs at `http://localhost:8003/docs`.

## Run without Docker
Terminal 1:
```powershell
cd task1-knowledge-brain
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```
Terminal 2:
```powershell
cd task2-inbox-agent
npm install
npm run dev
```
Terminal 3:
```powershell
cd task3-meeting-scope
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8003
```

## First use
1. In Knowledge Brain docs, run `POST /ingestion/run` with `limit=10` for a small test and check `GET /ingestion/status`. When successful, run without a limit for a full crawl. Respect the site's terms and rate limits.
2. Query `POST /query`. It returns grounded answers and citations, or a human escalation when evidence/model service is unavailable.
3. Open Inbox Agent, enter a synthetic email, inspect the draft, then approve/edit/reject. No email is sent.
4. In Meeting-to-Scope docs, post a meeting transcript to `/api/projects`, review requirements/estimates/feasibility/proposal, and explicitly approve. Follow-up changes compare against the approved baseline.

## Architecture and safeguards
- Task 1 owns crawl, chunks, retrieval, citations, and escalations in SQLite.
- Task 2 calls Task 1 `/query`; human approval is required for each draft. Twenty unedited approvals only mark eligibility for low-risk `how_to`, never trigger automatic email sending.
- Task 3 calls Task 1 for each requirement's documented feasibility and keeps scope approval explicit.
- Keys stay server-side. Never commit `.env` or expose secrets in a video.

## Data and evaluation
- `data/customer_emails.json`: 50 synthetic emails.
- `data/meetings/`: three synthetic meeting transcripts including a follow-up.
- `evals/`: 20 starter cases per task; they are not measured results until run.
- Update `IMPLEMENTATION_STATUS.md`, `DESIGN.md`, `EVALS.md`, `AI_LOG.md`, and `SUBMISSION_CHECKLIST.md` before submission.

## Private assessment materials
Keep the GitHub repository private from day one, invite only authorized collaborators, and follow the program's branch-protection/forking/ownership-transfer rules. Preserve actual coding-assistant history; never fabricate an AI log. Verify all services, failure paths, citation grounding, persistence, and one-command startup locally before claiming they work.
