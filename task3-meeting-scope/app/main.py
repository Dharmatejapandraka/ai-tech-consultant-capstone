
import json
import os
import re
import time
import uuid
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


# --------------------------------------------------
# Configuration
# --------------------------------------------------

MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
KNOWLEDGE_URL = os.getenv(
    "KNOWLEDGE_API_URL",
    "http://localhost:8001",
)

app = FastAPI(
    title="Meeting to Scope API",
    version="0.2.0",
)

# NOTE: Projects are stored in memory.
# Restarting the service clears all projects.
projects: dict[str, dict[str, Any]] = {}


# --------------------------------------------------
# Request models
# --------------------------------------------------

class MeetingRequest(BaseModel):
    transcript: str = Field(min_length=20, max_length=100000)
    project_id: str | None = None
    approved_baseline: dict[str, Any] | None = None


class ApprovalRequest(BaseModel):
    reviewer: str = Field(min_length=1, max_length=200)
    approved: bool
    comments: str = Field(default="", max_length=5000)


# --------------------------------------------------
# Groq integration
# --------------------------------------------------

def call_groq(system: str, prompt: str) -> str:
    """Call Groq and return the model's response."""

    if not GROQ_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is not configured.",
        )

    try:
        with httpx.Client(timeout=90) as http:
            response = http.post(
                GROQ_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MODEL,
                    "temperature": 0.1,
                    "max_tokens": 4000,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                },
            )

            if response.is_error:
                # Do not expose API keys or authorization headers.
                try:
                    error_data = response.json()
                    error_message = error_data.get("error", {}).get(
                        "message", response.text
                    )
                except (ValueError, AttributeError):
                    error_message = response.text

                print(
                    f"Groq API error: HTTP {response.status_code}; "
                    f"model={MODEL}; error={error_message[:500]}"
                )

                if response.status_code in (401, 403):
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "Groq authentication failed. Check the API key "
                            "and its permissions."
                        ),
                    )

                if response.status_code == 429:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "Groq rate limit or quota reached. "
                            "Check your Groq account and retry later."
                        ),
                    )

                if response.status_code in (400, 404):
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            f"Groq rejected the request (HTTP "
                            f"{response.status_code}). Check the configured "
                            f"model '{MODEL}' and request parameters."
                        ),
                    )

                raise HTTPException(
                    status_code=502,
                    detail=f"Groq request failed with HTTP {response.status_code}.",
                )

            data = response.json()
            content = data["choices"][0]["message"]["content"]

            if not isinstance(content, str) or not content.strip():
                raise HTTPException(
                    status_code=502,
                    detail="Groq returned an empty response.",
                )

            return content.strip()

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="Groq request timed out. Please retry.",
        )
    except httpx.RequestError as exc:
        print(f"Groq connection error: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="Unable to connect to Groq. Check network connectivity.",
        )
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        print(f"Unexpected Groq response: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="Groq returned an unexpected response format.",
        )


# --------------------------------------------------
# JSON response parsing
# --------------------------------------------------

def parse_json_response(raw: str) -> dict[str, Any]:
    """Parse a JSON object, including common Markdown code fences."""

    cleaned = raw.strip()

    # Remove optional Markdown code fences.
    cleaned = re.sub(
        r"^\s*```(?:json)?\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        # Recover a JSON object if the model added surrounding text.
        start = cleaned.find("{")
        end = cleaned.rfind("}")

        if start == -1 or end <= start:
            raise HTTPException(
                status_code=502,
                detail="Groq did not return a valid JSON object.",
            )

        try:
            result = json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=502,
                detail="Groq returned invalid JSON. Please retry.",
            )

    if not isinstance(result, dict):
        raise HTTPException(
            status_code=502,
            detail="Groq response must be a JSON object.",
        )

    return result


# --------------------------------------------------
# Knowledge Brain integration
# --------------------------------------------------


async def knowledge_check(
    requirements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Check requirements safely against the Knowledge Brain."""

    results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=20) as http:
        for index, req in enumerate(requirements, start=1):

            # Normalize malformed model output instead of crashing.
            if isinstance(req, str):
                description = req.strip()
                requirement_id = f"REQ-{index:03d}"
            elif isinstance(req, dict):
                description = str(req.get("description", "")).strip()
                requirement_id = req.get("id") or f"REQ-{index:03d}"
            else:
                description = str(req).strip()
                requirement_id = f"REQ-{index:03d}"

            if not description:
                results.append({
                    "requirement_id": requirement_id,
                    "description": description,
                    "knowledge_result": {
                        "status": "needs_human",
                        "answer": "Requirement description is missing.",
                        "citations": [],
                    },
                    "classification": "needs_human_review",
                })
                continue

            try:
                response = await http.post(
                    f"{KNOWLEDGE_URL.rstrip('/')}/query",
                    json={
                        "question": description,
                        "top_k": 3,
                    },
                )
                response.raise_for_status()
                result = response.json()

                if not isinstance(result, dict):
                    raise ValueError(
                        "Knowledge Brain returned an invalid response."
                    )

            except Exception as exc:
                print(
                    f"Knowledge check failed for {requirement_id}: "
                    f"{type(exc).__name__}: {exc}"
                )

                result = {
                    "status": "unavailable",
                    "answer": (
                        "Knowledge service unavailable or returned an "
                        "invalid response. Human review is required."
                    ),
                    "citations": [],
                    "error": type(exc).__name__,
                }

            status = result.get("status")

            results.append({
                "requirement_id": requirement_id,
                "description": description,
                "knowledge_result": result,
                "classification": (
                    "review_documented_capability"
                    if status == "answered"
                    else "needs_human_review"
                ),
            })

    return results



# --------------------------------------------------
# Helpers
# --------------------------------------------------

def make_baseline(project: dict[str, Any]) -> dict[str, Any]:
    """Create a snapshot of the currently approved project scope."""

    return {
        "requirements": project.get("requirements", []),
        "scope": project.get("scope", {}),
        "estimates": project.get("estimates", []),
    }


def get_project_or_404(project_id: str) -> dict[str, Any]:
    project = projects.get(project_id)

    if project is None:
        raise HTTPException(
            status_code=404,
            detail=f"Project '{project_id}' not found.",
        )

    return project


# --------------------------------------------------
# Health endpoint
# --------------------------------------------------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "groqConfigured": bool(GROQ_API_KEY),
        "model": MODEL,
    }


# --------------------------------------------------
# Create initial project scope
# --------------------------------------------------

@app.post("/api/projects")
async def create_scope(req: MeetingRequest):
    project_id = req.project_id or str(uuid.uuid4())

    if project_id in projects:
        raise HTTPException(
            status_code=409,
            detail=f"Project '{project_id}' already exists.",
        )

    system = """
You are the Transcript Analyst, Scope Agent, Estimation Agent,
and Proposal Agent for a software consultancy.

Return a valid JSON object only, with these keys:
project_title, objective, requirements, open_questions,
scope, estimates, proposal.

Requirements must be an array of objects containing:
id, description, source_quote, status, priority,
acceptance_criteria, dependencies.

Use status values: confirmed, unclear, disputed.
Use priority values: must_have, should_have, optional.

Keep assumptions separate from facts.
Never invent a client commitment.
Preserve source quotes for key requirements.

Estimates must use ranges with:
low_hours, likely_hours, high_hours, assumptions.

Scope must include:
deliverables, exclusions, assumptions, dependencies,
client_responsibilities, risks.

Proposal must include:
executive_summary, solution, milestones,
pricing_assumptions, next_steps.

Human approval is mandatory.
Do not claim a project is approved.
Return JSON only, without Markdown fences.
"""

    raw = call_groq(
        system,
        "Analyze this client meeting transcript. "
        "Preserve source quotes for key requirements.\n\n"
        + req.transcript,
    )

    result = parse_json_response(raw)

    requirements = result.get("requirements", [])

    if not isinstance(requirements, list):
        raise HTTPException(
            status_code=502,
            detail="Groq returned an invalid requirements list.",
        )

    result["feasibility_checks"] = await knowledge_check(requirements)
    result["project_id"] = project_id
    result["status"] = "pending_approval"
    result["version"] = 1
    result["created_at"] = time.time()
    result["approved"] = False
    result["transcripts"] = [req.transcript]
    result["approval"] = None
    result["approved_baseline"] = None
    result["pending_revision"] = None
    result["latest_changes"] = None

    projects[project_id] = result

    return result


# --------------------------------------------------
# Follow-up meeting and scope revision
# --------------------------------------------------

@app.post("/api/projects/{project_id}/follow-up")
async def follow_up(project_id: str, req: MeetingRequest):
    old = get_project_or_404(project_id)

    # Follow-ups must be compared against an approved baseline.
    baseline = old.get("approved_baseline")

    if not baseline:
        raise HTTPException(
            status_code=409,
            detail=(
                "This project has no approved baseline yet. "
                "Approve the initial scope before submitting a follow-up."
            ),
        )

    system = """
Compare the new follow-up transcript only against the supplied
APPROVED BASELINE.

Return a valid JSON object only, with these keys:
additions, modifications, removals, unresolved_conflicts,
revised_requirements, revised_scope, revised_estimates,
change_summary.

Every addition, modification, or removal must explain its
evidence from the new transcript.

Flag potentially out-of-scope items.
Preserve existing requirements unless the new transcript
clearly supports a change.
Do not treat an unapproved draft as approved.
Do not send anything to the client.
Return JSON only, without Markdown fences.
"""

    raw = call_groq(
        system,
        f"APPROVED BASELINE:\n{json.dumps(baseline)}\n\n"
        f"FOLLOW-UP TRANSCRIPT:\n{req.transcript}",
    )

    changes = parse_json_response(raw)

    revised_requirements = changes.get(
        "revised_requirements",
        baseline.get("requirements", []),
    )
    revised_scope = changes.get(
        "revised_scope",
        baseline.get("scope", {}),
    )
    revised_estimates = changes.get(
        "revised_estimates",
        baseline.get("estimates", []),
    )

    if not isinstance(revised_requirements, list):
        raise HTTPException(
            status_code=502,
            detail="Groq returned an invalid revised requirements list.",
        )

    changes["feasibility_checks"] = await knowledge_check(
        revised_requirements
    )

    # Keep the approved version unchanged until approval.
    old["transcripts"].append(req.transcript)
    old["latest_changes"] = changes

    old["pending_revision"] = {
        "requirements": revised_requirements,
        "scope": revised_scope,
        "estimates": revised_estimates,
    }

    old["status"] = "revision_pending_approval"
    old["approved"] = False
    old["version"] = int(old.get("version", 1)) + 1
    old["approval"] = None

    return {
        "project_id": project_id,
        "version": old["version"],
        "status": old["status"],
        "changes": changes,
    }


# --------------------------------------------------
# Approve or reject a project version
# --------------------------------------------------

@app.post("/api/projects/{project_id}/approve")
def approve(project_id: str, req: ApprovalRequest):
    project = get_project_or_404(project_id)

    project["approval"] = {
        "reviewer": req.reviewer,
        "approved": req.approved,
        "comments": req.comments,
        "timestamp": time.time(),
        "version": project["version"],
    }

    project["approved"] = req.approved

    if req.approved:
        pending_revision = project.get("pending_revision")

        # Promote the revision only after approval.
        if pending_revision is not None:
            project["requirements"] = pending_revision["requirements"]
            project["scope"] = pending_revision["scope"]
            project["estimates"] = pending_revision["estimates"]

        # The baseline now contains the approved version.
        project["approved_baseline"] = make_baseline(project)
        project["pending_revision"] = None
        project["status"] = "approved"

    else:
        # Do not promote rejected changes into the approved baseline.
        project["pending_revision"] = None
        project["status"] = "changes_requested"

    return {
        "project_id": project_id,
        "status": project["status"],
        "approved": project["approved"],
        "version": project["version"],
        "approval": project["approval"],
        "approved_baseline": project.get("approved_baseline"),
    }


# --------------------------------------------------
# Retrieve project and approval history
# --------------------------------------------------

@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    return get_project_or_404(project_id)
