
import express from "express";
import "dotenv/config";
import { z } from "zod";
import crypto from "node:crypto";

const app = express();

app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.PORT || 8002);
const knowledgeUrl =
  process.env.KNOWLEDGE_API_URL || "http://localhost:8001";

const model =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const groqKey = process.env.GROQ_API_KEY;
const groqUrl = "https://api.groq.com/openai/v1/chat/completions";

// --------------------------------------------------
// GROQ AI
// --------------------------------------------------

async function callGroq(prompt: string): Promise<string> {
  if (!groqKey) {
    throw new Error("GROQ_API_KEY is not configured");
  }

  const response = await fetch(groqUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + groqKey,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "Return valid JSON only. Do not invent facts. " +
            "Always provide a non-empty reply string. " +
            "If the available information is insufficient, " +
            "ask the customer for clarification or recommend human support.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      "Groq API returned " +
        response.status +
        ": " +
        errorText.slice(0, 500)
    );
  }

  const result: any = await response.json();

  const content = String(
    result.choices?.[0]?.message?.content || ""
  )
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (!content) {
    throw new Error("Groq returned an empty response");
  }

  return content;
}

// --------------------------------------------------
// INPUT VALIDATION AND TYPES
// --------------------------------------------------

const EmailInput = z.object({
  from: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
  previousContext: z.string().optional(),
});

type Draft = {
  id: string;
  email: z.infer<typeof EmailInput>;
  category: string;
  risk: string;
  summary: string;
  reply: string;
  citations: unknown[];
  approvalRequired: boolean;
  status: string;
  createdAt: string;
};

const drafts = new Map<string, Draft>();
const feedback: Array<Record<string, unknown>> = [];
const streaks = new Map<string, number>();

// This prototype never sends emails automatically.
const approvedKinds = new Set(["how_to"]);

// --------------------------------------------------
// KNOWLEDGE BRAIN INTEGRATION
// --------------------------------------------------

async function getKnowledge(question: string) {
  try {
    const response = await fetch(knowledgeUrl + "/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question,
        top_k: 5,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(
        "Knowledge API returned " + response.status
      );
    }

    return (await response.json()) as {
      status: string;
      answer: string;
      citations: unknown[];
      reason?: string;
    };
  } catch (error) {
    console.error("Knowledge Brain error:", error);

    return {
      status: "unavailable",
      answer:
        "Knowledge service unavailable. Do not invent product information. " +
        "Ask for clarification or route the request to a human.",
      citations: [],
      reason:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

// --------------------------------------------------
// INBOX AGENT WEB PAGE
// --------------------------------------------------

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inbox Agent</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      font: 16px system-ui, sans-serif;
      max-width: 1000px;
      margin: 32px auto;
      padding: 0 16px;
      background: #f5f7fb;
      color: #172033;
    }

    h1 {
      color: #263c85;
    }

    .card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin: 16px 0;
      box-shadow: 0 2px 12px #15204010;
    }

    label {
      display: block;
      font-weight: 600;
      margin-top: 12px;
    }

    textarea,
    input {
      display: block;
      width: 100%;
      padding: 12px;
      margin: 6px 0 12px;
      border: 1px solid #ccd3e0;
      border-radius: 8px;
      font: inherit;
    }

    textarea {
      resize: vertical;
      min-height: 100px;
    }

    button {
      padding: 11px 16px;
      border: 0;
      border-radius: 8px;
      background: #263c85;
      color: white;
      cursor: pointer;
      margin: 5px 5px 5px 0;
      font: inherit;
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .muted {
      color: #667085;
    }

    .success {
      color: #087443;
      font-weight: 600;
    }

    .error {
      color: #b42318;
      font-weight: 600;
    }

    .source {
      display: block;
      margin: 8px 0;
      overflow-wrap: anywhere;
    }

    a {
      color: #263c85;
    }

    #loading {
      display: none;
    }
  </style>
</head>

<body>
  <h1>Inbox Agent</h1>

  <p class="muted">
    AI-assisted customer email drafting.
    Every message requires human review.
    Emails are not sent automatically.
  </p>

  <div class="card">
    <h2>New customer email</h2>

    <form id="email">
      <label for="from">From</label>
      <input
        id="from"
        name="from"
        type="email"
        required
        value="customer@example.com"
      >

      <label for="subject">Subject</label>
      <input
        id="subject"
        name="subject"
        required
        placeholder="How do I update my website logo?"
      >

      <label for="body">Email body</label>
      <textarea
        id="body"
        name="body"
        required
        placeholder="Paste the customer email here"
      ></textarea>

      <label for="previousContext">
        Previous context (optional)
      </label>
      <textarea
        id="previousContext"
        name="previousContext"
        placeholder="Add any relevant conversation history"
      ></textarea>

      <button id="generate" type="submit">
        Generate draft
      </button>

      <p id="loading" class="muted">
        Generating a reply. Please wait...
      </p>
    </form>
  </div>

  <div id="result" aria-live="polite"></div>

  <script>
    const form = document.getElementById("email");
    const result = document.getElementById("result");
    const generateButton = document.getElementById("generate");
    const loading = document.getElementById("loading");

    function addText(parent, tag, text, className) {
      const element = document.createElement(tag);
      element.textContent = text || "";

      if (className) {
        element.className = className;
      }

      parent.appendChild(element);
      return element;
    }

    function addButton(parent, label, callback) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", callback);
      parent.appendChild(button);
      return button;
    }

    async function requestAction(url, reply) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reply: reply })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || data.detail || "Action failed"
        );
      }

      return data;
    }

    function showDraft(draft) {
      result.replaceChildren();

      const card = document.createElement("div");
      card.className = "card";

      addText(card, "h2", "Draft review");

      addText(
        card,
        "p",
        "Category: " + draft.category +
          " | Risk: " + draft.risk
      );

      addText(
        card,
        "p",
        "Summary: " + draft.summary
      );

      addText(card, "label", "Suggested reply");

      const reply = document.createElement("textarea");
      reply.id = "reply";
      reply.rows = 10;
      reply.style.width = "100%";
      reply.value = draft.reply || "";
      reply.required = true;
      card.appendChild(reply);

      if (!reply.value.trim()) {
        addText(
          card,
          "p",
          "The AI returned an empty reply. Please retry.",
          "error"
        );
      }

      addText(card, "h3", "Knowledge sources");

      const citations = Array.isArray(draft.citations)
        ? draft.citations
        : [];

      if (citations.length === 0) {
        addText(
          card,
          "p",
          "No knowledge sources were returned.",
          "muted"
        );
      } else {
        citations.forEach(function (citation) {
          const link = document.createElement("a");
          link.className = "source";
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = citation.title || citation.url || "Source";

          try {
            const parsedUrl = new URL(citation.url);

            if (parsedUrl.protocol === "https:" ||
                parsedUrl.protocol === "http:") {
              link.href = parsedUrl.href;
              card.appendChild(link);
            } else {
              addText(card, "p", link.textContent, "muted");
            }
          } catch (error) {
            addText(card, "p", link.textContent, "muted");
          }
        });
      }

      const status = addText(card, "p", "", "muted");

      async function performAction(action) {
        if (action !== "reject" && !reply.value.trim()) {
          status.textContent =
            "Cannot approve an empty reply. Generate a new draft first.";
          status.className = "error";
          return;
        }

        if (action === "approve") {
          const confirmed = window.confirm(
            "Review the complete reply carefully. Approve this draft?"
          );

          if (!confirmed) {
            return;
          }
        }

        const buttons = card.querySelectorAll("button");
        buttons.forEach(function (button) {
          button.disabled = true;
        });

        try {
          const data = await requestAction(
            "/api/drafts/" +
              encodeURIComponent(draft.id) +
              "/" + action,
            reply.value
          );

          status.textContent =
            "Result: " + data.status +
            ". " + (data.note || "");

          status.className = "success";
        } catch (error) {
          status.textContent = "Error: " + error.message;
          status.className = "error";
        } finally {
          buttons.forEach(function (button) {
            button.disabled = false;
          });
        }
      }

      addButton(
        card,
        "Approve unchanged",
        function () {
          if (reply.value.trim() !== (draft.reply || "").trim()) {
            status.textContent =
              "The reply has been changed. Use Save edited reply instead.";
            status.className = "error";
            return;
          }

          performAction("approve");
        }
      );

      addButton(
        card,
        "Save edited reply",
        function () {
          performAction("edit");
        }
      );

      addButton(
        card,
        "Reject",
        function () {
          performAction("reject");
        }
      );

      result.appendChild(card);
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      result.replaceChildren();
      generateButton.disabled = true;
      loading.style.display = "block";

      try {
        const data = Object.fromEntries(
          new FormData(form).entries()
        );

        const response = await fetch("/api/drafts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(data)
        });

        const draft = await response.json();

        if (!response.ok) {
          throw new Error(
            draft.detail || draft.error ||
            "Could not generate the draft"
          );
        }

        showDraft(draft);
      } catch (error) {
        addText(
          result,
          "p",
          "Error: " + error.message,
          "error"
        );
      } finally {
        loading.style.display = "none";
        generateButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

// --------------------------------------------------
// HEALTH AND HOME ROUTES
// --------------------------------------------------

app.get("/", (_req, res) => {
  res.type("html").send(htmlPage());
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    groqConfigured: Boolean(groqKey),
    model,
  });
});

// --------------------------------------------------
// GENERATE EMAIL DRAFT
// --------------------------------------------------

app.post("/api/drafts", async (req, res) => {
  const parsed = EmailInput.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.flatten(),
    });
  }

  if (!groqKey) {
    return res.status(503).json({
      error: "GROQ_API_KEY is not configured",
    });
  }

  try {
    const email = parsed.data;

    const knowledge = await getKnowledge(
      email.subject +
        "\n" +
        email.body +
        "\n" +
        (email.previousContext || "")
    );

    const prompt = `
Classify the customer email into exactly one category:
how_to, troubleshooting, project_request, refund_cancellation,
complaint, quote_request, follow_up, other.

Return valid JSON only with these keys:
category, risk, summary, reply, approvalRequired.

The reply MUST be a non-empty, professional customer email.
Use the provided knowledge and its answer to answer the question.
Do not invent product instructions or facts.
Do not promise refunds, pricing, delivery dates, or custom work
without authorization.
If knowledge is unavailable or insufficient, ask for clarification
or recommend human support.
Always require human review.

Customer email:
${JSON.stringify(email)}

Knowledge service result:
${JSON.stringify(knowledge)}

Example JSON structure:
{
  "category": "how_to",
  "risk": "low",
  "summary": "Customer needs help with a website setting.",
  "reply": "Hello, thank you for contacting support...",
  "approvalRequired": true
}
`;

    const raw = await callGroq(prompt);

    let obj: any;

    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(
        "Groq did not return valid JSON: " + raw.slice(0, 300)
      );
    }

    const reply = String(obj.reply || "").trim();

    if (!reply) {
      throw new Error(
        "Groq returned an empty reply. Please try again."
      );
    }

    const allowedCategories = [
      "how_to",
      "troubleshooting",
      "project_request",
      "refund_cancellation",
      "complaint",
      "quote_request",
      "follow_up",
      "other",
    ];

    const category = allowedCategories.includes(obj.category)
      ? obj.category
      : "other";

    const allowedRisks = ["low", "medium", "high"];

    const risk = allowedRisks.includes(obj.risk)
      ? obj.risk
      : "high";

    const id = crypto.randomUUID();

    const draft: Draft = {
      id,
      email,
      category,
      risk,
      summary: String(obj.summary || "Customer email received."),
      reply,
      citations: Array.isArray(knowledge.citations)
        ? knowledge.citations
        : [],
      approvalRequired: true,
      status: "pending_review",
      createdAt: new Date().toISOString(),
    };

    drafts.set(id, draft);

    return res.json(draft);
  } catch (error) {
    console.error("Draft generation failed:", error);

    return res.status(502).json({
      error: "Groq draft generation failed",
      detail:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

// --------------------------------------------------
// LIST GENERATED DRAFTS
// --------------------------------------------------

app.get("/api/drafts", (_req, res) => {
  res.json(
    [...drafts.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
  );
});

// --------------------------------------------------
// APPROVE, EDIT, OR REJECT A DRAFT
// --------------------------------------------------

app.post("/api/drafts/:id/:action", (req, res) => {
  const draft = drafts.get(req.params.id);

  if (!draft) {
    return res.status(404).json({
      error: "Draft not found. It may have been lost after a restart.",
    });
  }

  const action = req.params.action;

  if (!["approve", "edit", "reject"].includes(action)) {
    return res.status(400).json({
      error: "Unsupported action",
    });
  }

  if (draft.status !== "pending_review") {
    return res.status(409).json({
      error: "This draft has already been reviewed.",
      status: draft.status,
    });
  }

  const sentText = String(req.body?.reply ?? draft.reply);

  if (action !== "reject" && !sentText.trim()) {
    return res.status(400).json({
      error: "An empty reply cannot be approved or saved.",
    });
  }

  const unchanged = sentText.trim() === draft.reply.trim();

  if (action === "reject") {
    draft.status = "rejected";
    streaks.set(draft.category, 0);
  } else {
    draft.reply = sentText;

    draft.status =
      action === "approve" && unchanged
        ? "approved_unchanged"
        : "approved_edited";

    streaks.set(
      draft.category,
      action === "approve" && unchanged
        ? (streaks.get(draft.category) || 0) + 1
        : 0
    );
  }

  feedback.push({
    id: draft.id,
    category: draft.category,
    action,
    unchanged,
    finalReply: sentText,
    createdAt: new Date().toISOString(),
    model,
    promptVersion: "v2",
  });

  const count = streaks.get(draft.category) || 0;

  return res.json({
    status: draft.status,
    category: draft.category,
    consecutiveUneditedApprovals: count,
    autonomyEligible:
      count >= 20 && approvedKinds.has(draft.category),
    note:
      "This prototype records eligibility only. It never sends emails " +
      "automatically. Human review is required.",
  });
});

// --------------------------------------------------
// FEEDBACK ENDPOINT
// --------------------------------------------------

app.get("/api/feedback", (_req, res) => {
  res.json(feedback);
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(port, "0.0.0.0", () => {
  console.log("Inbox Agent listening on port " + port);
  console.log("Configured model: " + model);
});
