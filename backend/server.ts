import express from "express";
import cors from "cors";
import { extractText, getDocumentProxy } from "unpdf";
import { createRequire } from "module";
import { pathToFileURL } from "url";
const require = createRequire(import.meta.url);
const mammoth = require("mammoth");
import dotenv from "dotenv";
import { getDb, hashPassword } from "./src/mongodb-server.js";

dotenv.config();

export async function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "15mb" }));

  // API Route: healthcheck
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Welcome route for /
  app.get("/", (_req, res) => {
    res.json({ status: "online", message: "AI Resume Analyzer Backend API is running successfully!" });
  });

  // Welcome route for /api
  app.get("/api", (_req, res) => {
    res.json({ status: "online", message: "AI Resume Analyzer Backend API is running successfully!" });
  });

  // --- MONGODB AUTHENTICATION ENDPOINTS ---

  app.post("/api/auth/register", async (req, res): Promise<void> => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password || !name) {
        res.status(400).json({ error: "Missing required parameters: email, password, and name are required." });
        return;
      }
      const db = await getDb();
      const cleanEmail = email.toLowerCase().trim();

      const existing = await db.collection("users").findOne({ email: cleanEmail });
      if (existing) {
        res.status(400).json({ error: "An account with this email address already exists." });
        return;
      }

      const uid = "u_" + Math.random().toString(36).substring(2, 11);
      const passwordHash = hashPassword(password);

      const newUser = {
        uid,
        email: cleanEmail,
        displayName: name,
        passwordHash,
        createdAt: new Date().toISOString()
      };

      await db.collection("users").insertOne(newUser);

      res.json({ uid, email: cleanEmail, displayName: name });
    } catch (err: any) {
      console.error("register error:", err);
      res.status(500).json({ error: err.message || "Unable to register user to Cloud Database." });
    }
  });

  app.post("/api/auth/login", async (req, res): Promise<void> => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: "Missing email or password." });
        return;
      }
      const db = await getDb();
      const cleanEmail = email.toLowerCase().trim();
      const passwordHash = hashPassword(password);

      const user = await db.collection("users").findOne({ email: cleanEmail, passwordHash });
      if (!user) {
        res.status(401).json({ error: "Invalid email or password." });
        return;
      }

      res.json({ uid: user.uid, email: user.email, displayName: user.displayName });
    } catch (err: any) {
      console.error("login error:", err);
      res.status(500).json({ error: err.message || "Failed to authenticate." });
    }
  });

  app.post("/api/auth/oauth", async (req, res): Promise<void> => {
    try {
      const db = await getDb();
      const email = "oauth.user@example.com";
      const displayName = "Federated Candidate";

      const existingUser = await db.collection("users").findOne({ email });
      if (existingUser) {
        res.json({ uid: existingUser.uid, email: existingUser.email, displayName: existingUser.displayName });
        return;
      }

      const uid = "u_g_" + Math.random().toString(36).substring(2, 11);
      const newUser = { uid, email, displayName, createdAt: new Date().toISOString() };
      await db.collection("users").insertOne(newUser);

      res.json({ uid: newUser.uid, email: newUser.email, displayName: newUser.displayName });
    } catch (err: any) {
      console.error("OAuth auth simulation error:", err);
      res.status(500).json({ error: err.message || "Could not log in via OAuth sandbox." });
    }
  });

  // --- MONGODB SCAN RECORDS SYNC ENDPOINTS ---

  app.post("/api/records", async (req, res): Promise<void> => {
    try {
      const { userId, resumeName, resumeText, jobDescription, result } = req.body;
      if (!userId || !resumeName || !resumeText || !jobDescription || !result) {
        res.status(400).json({ error: "Missing parameters to save comparison record." });
        return;
      }
      const db = await getDb();
      const recordId = "rec_" + Math.random().toString(36).substring(2, 15);
      const createdAt = new Date().toISOString();

      const record = { id: recordId, userId, resumeName, resumeText, jobDescription, createdAt, ...result };

      await db.collection("analyses").insertOne(record);
      res.json(record);
    } catch (err: any) {
      console.error("save record error:", err);
      res.status(500).json({ error: err.message || "Unable to write comparison data logs." });
    }
  });

  app.get("/api/records", async (req, res): Promise<void> => {
    try {
      const { userId } = req.query;
      if (!userId) {
        res.status(400).json({ error: "Missing userId query param." });
        return;
      }
      const db = await getDb();
      const list = await db
        .collection("analyses")
        .find({ userId: String(userId) })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(list);
    } catch (err: any) {
      console.error("get records list error:", err);
      res.status(500).json({ error: err.message || "Unable to load saved comparison data logs." });
    }
  });

  app.delete("/api/records/:id", async (req, res): Promise<void> => {
    try {
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: "Missing target record ID." });
        return;
      }
      const db = await getDb();
      await db.collection("analyses").deleteOne({ id: String(id) });
      res.json({ success: true });
    } catch (err: any) {
      console.error("delete record error:", err);
      res.status(500).json({ error: err.message || "Unable to delete analysis record." });
    }
  });

  // API Route: parse-resume
  app.post("/api/parse-resume", async (req, res): Promise<void> => {
    try {
      const { base64, name } = req.body;
      if (!base64) {
        res.status(400).json({ error: "Missing file base64 data" });
        return;
      }

      const buffer = Buffer.from(base64, "base64");
      const lowerName = (name || "").toLowerCase();

      if (lowerName.endsWith(".pdf")) {
        try {
          const pdf = await getDocumentProxy(new Uint8Array(buffer));
          const { text } = await extractText(pdf, { mergePages: true });
          const cleanText = (text || "").replace(/\u0000/g, " ").trim();
          res.json({ text: cleanText });
          return;
        } catch (pdfErr: any) {
          console.error("PDF Parsing Failure:", pdfErr);
          res.status(500).json({ error: `Failed to parse PDF file: ${pdfErr?.message || pdfErr}` });
          return;
        }
      } else if (lowerName.endsWith(".docx")) {
        try {
          const parsedData = await mammoth.extractRawText({ buffer });
          const cleanText = (parsedData.value || "").trim();
          res.json({ text: cleanText });
          return;
        } catch (docxErr: any) {
          console.error("DOCX Parsing Failure:", docxErr);
          res.status(500).json({ error: `Failed to parse DOCX file: ${docxErr?.message || docxErr}` });
          return;
        }
      } else {
        const cleanText = buffer.toString("utf-8").trim();
        res.json({ text: cleanText });
        return;
      }
    } catch (err: any) {
      console.error("Full file parsing exception:", err);
      res.status(500).json({ error: err.message || "An error occurred while reading the file" });
    }
  });

  // API Route: analyze-resume
  app.post("/api/analyze", async (req, res): Promise<void> => {
    try {
      const { resumeText, jobDescription, provider, apiKey, model } = req.body;

      if (!resumeText || !resumeText.trim()) {
        res.status(400).json({ error: "Resume text content is empty or missing." });
        return;
      }
      if (!jobDescription || !jobDescription.trim()) {
        res.status(400).json({ error: "Job description is empty or missing." });
        return;
      }

      const resolvedProvider = provider || "openai";
      const resolvedApiKey = apiKey || process.env.GEMINI_API_KEY;

      if (resolvedProvider === "openai" && !resolvedApiKey) {
        res.status(400).json({
          error: "No default OpenAI API Key is configured on the server. Please provide a custom API Key in the settings overlay.",
        });
        return;
      }

      const promptText = `
You are an expert AI recruiter, custom ATS (Applicant Tracking System), and career coach. Your task is to perform an deep assessment of the following candidate's resume text against a provided target job description.

--- CANDIDATE RESUME TEXT ---
${resumeText}

--- TARGET JOB DESCRIPTION ---
${jobDescription}

Perform a rigorous evaluation and return a perfectly formatted JSON object with the following fields:
- "matchScore": an integer from 0 to 100 representing the exact match compatibility percentage.
- "jobTitle": the targeted or detected job title.
- "matchedSkills": an array of strings representing relevant skills found in the resume that align with the job description.
- "missingSkills": an array of strings representing critical skills in the job description that are missing or poorly addressed in the resume.
- "improvements": an array of strings containing specific, highly actionable, realistic recommendations to improve this resume's matching (e.g. key sections to rephrase, certifications to list, metric styles to adopt).
- "interviewQuestions": an array of EXACTLY 5 highly targeted, job-specific interview preparation questions designed for the candidate to address gaps or demonstrate proficiency in critical skills.

Return ONLY the JSON object. Do not wrap in markdown blocks, do not add introductory elements, and do not add trailing markdown content.
`;

      if (resolvedProvider === "openai") {
        if (!resolvedApiKey) {
          res.status(400).json({ error: "An OpenAI API Key must be provided to use the OpenAI provider." });
          return;
        }

        const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolvedApiKey}` },
          body: JSON.stringify({
            model: model || "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a professional resume matcher. Return only a valid JSON object matching the requested schema with: matchScore, jobTitle, matchedSkills, missingSkills, improvements, and exactly 5 interviewQuestions." },
              { role: "user", content: promptText },
            ],
            response_format: { type: "json_object" },
          }),
        });

        if (!openAiResponse.ok) {
          const errData = await openAiResponse.json().catch(() => ({}));
          res.status(openAiResponse.status).json({ error: `OpenAI API Error: ${(errData as any)?.error?.message || openAiResponse.statusText}` });
          return;
        }

        const data: any = await openAiResponse.json();
        res.json(JSON.parse(data.choices?.[0]?.message?.content));
        return;
      } else if (resolvedProvider === "anthropic") {
        if (!resolvedApiKey) {
          res.status(400).json({ error: "An Anthropic API Key must be provided to use the Anthropic provider." });
          return;
        }

        const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": resolvedApiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: model || "claude-3-5-haiku-20241022",
            max_tokens: 4000,
            system: "You are a professional resume analyzer. Return only valid JSON adhering strictly to: { matchScore: number, jobTitle: string, matchedSkills: string[], missingSkills: string[], improvements: string[], interviewQuestions: string[] }.",
            messages: [{ role: "user", content: promptText }],
          }),
        });

        if (!anthropicResponse.ok) {
          const errMsg = await anthropicResponse.text().catch(() => "Unknown error");
          res.status(anthropicResponse.status).json({ error: `Anthropic API Error: ${errMsg}` });
          return;
        }

        const data: any = await anthropicResponse.json();
        const rawContent = data.content?.[0]?.text || "";
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        res.json(JSON.parse(jsonMatch ? jsonMatch[0] : rawContent));
        return;
      } else {
        res.status(400).json({ error: "Unsupported provider requested." });
      }
    } catch (err: any) {
      console.error("Analysis route exception:", err);
      res.status(500).json({ error: err.message || "An error occurred during resume analysis." });
    }
  });

  // API Route: evaluate-answer
  app.post("/api/evaluate-answer", async (req, res): Promise<void> => {
    try {
      const { question, answer, provider, apiKey, model } = req.body;

      if (!question || !question.trim()) {
        res.status(400).json({ error: "Missing interview question context parameter." });
        return;
      }
      if (!answer || !answer.trim()) {
        res.status(400).json({ error: "Candidate response content is empty." });
        return;
      }

      const resolvedProvider = provider || "openai";
      const resolvedApiKey = apiKey || process.env.GEMINI_API_KEY;

      if (resolvedProvider === "openai" && !resolvedApiKey) {
        res.status(400).json({
          error: "No default OpenAI API Key is configured on the server. Please provide a custom API Key in the settings overlay.",
        });
        return;
      }

      const evalPrompt = `
You are an expert technical interviewer and executive communication coach.
Evaluate the candidate's draft answer to the following interview question:

QUESTION:
"${question}"

CANDIDATE'S WORK-IN-PROGRESS RESPONSE:
"${answer}"

Perform a high-level STAR evaluation and return a perfectly formatted JSON object with the following fields:
- "score": an integer from 0 to 100 representing the effectiveness and impact of the answer.
- "starRating": a human-friendly level (e.g. "Excellent", "Competent", "Needs STAR Structure").
- "feedback": a rich text outline reviewing what they did well (e.g., tone, technology mentions).
- "gaps": an array of strings listing points where the user failed to answer fully or could add key metric styles.
- "revisedSuggestion": a short, high-impact improved answer draft incorporating standard STAR structures.

Return ONLY the JSON. Do not wrap in markdown blocks, do not add introductory elements, and do not add trailing markdown content.
`;

      if (resolvedProvider === "openai") {
        if (!resolvedApiKey) {
          res.status(400).json({ error: "An OpenAI API Key must be provided to use the OpenAI provider." });
          return;
        }

        const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolvedApiKey}` },
          body: JSON.stringify({
            model: model || "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a professional HR communication evaluator. Return only a valid JSON object matching the requested schema with: score, starRating, feedback, gaps, revisedSuggestion." },
              { role: "user", content: evalPrompt },
            ],
            response_format: { type: "json_object" },
          }),
        });

        if (!openAiResponse.ok) {
          const errData = await openAiResponse.json().catch(() => ({}));
          res.status(openAiResponse.status).json({ error: `OpenAI API Error: ${(errData as any)?.error?.message || openAiResponse.statusText}` });
          return;
        }

        const data: any = await openAiResponse.json();
        res.json(JSON.parse(data.choices?.[0]?.message?.content));
        return;
      } else if (resolvedProvider === "anthropic") {
        if (!resolvedApiKey) {
          res.status(400).json({ error: "An Anthropic API Key must be provided to use the Anthropic provider." });
          return;
        }

        const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": resolvedApiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: model || "claude-3-5-haiku-20241022",
            max_tokens: 4000,
            system: "You are a professional HR coach. Return only valid JSON adhering strictly to: { score: number, starRating: string, feedback: string, gaps: string[], revisedSuggestion: string }.",
            messages: [{ role: "user", content: evalPrompt }],
          }),
        });

        if (!anthropicResponse.ok) {
          const errMsg = await anthropicResponse.text().catch(() => "Unknown error");
          res.status(anthropicResponse.status).json({ error: `Anthropic API Error: ${errMsg}` });
          return;
        }

        const data: any = await anthropicResponse.json();
        const rawContent = data.content?.[0]?.text || "";
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        res.json(JSON.parse(jsonMatch ? jsonMatch[0] : rawContent));
        return;
      } else {
        res.status(400).json({ error: "Unsupported provider requested." });
      }
    } catch (err: any) {
      console.error("Evaluate route exception:", err);
      res.status(500).json({ error: err.message || "An error occurred during interview evaluation." });
    }
  });

  return app;
}

let serverApp: any = null;
export default async (req: any, res: any) => {
  if (!serverApp) {
    serverApp = await createApp();
  }
  serverApp(req, res);
};

// Only start server locally, not in serverless environment
const shouldStartServerLocally = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (shouldStartServerLocally) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  createApp().then((app) => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`AI Resume Analyzer API online on port ${PORT}`);
    });
  });
}
