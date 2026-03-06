import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import OpenAI from "openai";

// --- Constants ---

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

// --- Zod Schemas ---

const ClientTaskSchema = z.object({
  person: z.string(),
  task: z.string(),
});

const KickoffExtractionSchema = z.object({
  clientTeamName: z.string(),
  clientTasks: z.array(ClientTaskSchema),
  airOpsTasks: z.array(z.string()),
});

type KickoffExtraction = z.infer<typeof KickoffExtractionSchema>;

// --- AI Extraction ---

const EXTRACTION_PROMPT = `You are an AI that analyzes Gong call transcripts from kickoff meetings between AirOps and their clients.

Your job is to extract the next steps discussed during the call, split into two groups:
1. Tasks for the CLIENT team (with the specific person responsible)
2. Tasks for the AirOps team

Extract the following as JSON:

- clientTeamName: The client company name (e.g. "DistroKid", "ZenBusiness")
- clientTasks: An array of objects, each with:
  - person: The name of the person responsible (first name is fine)
  - task: A concise description of what they need to do
- airOpsTasks: An array of strings, each a concise description of what AirOps needs to do

Rules:
- Only include concrete, actionable next steps that were explicitly discussed or agreed upon
- Do NOT include vague items like "continue discussion" unless a specific action was stated
- Keep task descriptions concise (1 sentence each)
- If multiple people share a task, list them together (e.g. "Julia & Wes")

Return ONLY valid JSON, no markdown code fences.`;

async function extractKickoffTasks(transcript: string): Promise<KickoffExtraction> {
  const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY!,
  });

  const response = await openai.chat.completions.create({
    model: "google/gemini-2.5-flash",
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: transcript },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("Empty response from LLM extraction");
  }

  const parsed = JSON.parse(content);
  return KickoffExtractionSchema.parse(parsed);
}

// --- Slack Helpers ---

async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string
): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, ts, text }),
  });

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    logger.warn("Failed to update Slack message", { error: data.error });
  }
}

// --- Format Output ---

function formatKickoffMessage(data: KickoffExtraction, userName: string): string {
  const lines: string[] = [];

  lines.push(`Hey everyone <!channel>, thanks for taking the time today! Next steps:\n`);

  // Client team tasks
  lines.push(`*${data.clientTeamName} Team:*`);
  for (const item of data.clientTasks) {
    lines.push(`- ${item.person}: ${item.task}`);
  }

  lines.push("");

  // AirOps tasks
  lines.push(`*AirOps:*`);
  for (const task of data.airOpsTasks) {
    lines.push(`- ${task}`);
  }

  return lines.join("\n");
}

// --- Main Task ---

export const postKickoffTasks = schemaTask({
  id: "post-kickoff-tasks",
  schema: z.object({
    transcript: z.string().describe("Gong call transcript text"),
    slackChannel: z.string().describe("Slack channel ID"),
    slackMessageTs: z.string().describe("Status message timestamp to update"),
    slackUserId: z.string().describe("User who triggered the command"),
    userName: z.string().describe("Real name of user who triggered the command"),
  }),
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    const { transcript, slackChannel, slackMessageTs, userName } = payload;

    // Step 1: Extract tasks from transcript
    logger.info("Extracting kickoff tasks from transcript...");
    const extraction = await extractKickoffTasks(transcript);
    logger.info("Extraction complete", {
      clientTeam: extraction.clientTeamName,
      clientTasks: extraction.clientTasks.length,
      airOpsTasks: extraction.airOpsTasks.length,
    });

    // Step 2: Format and update the Slack message
    const message = formatKickoffMessage(extraction, userName);
    await updateSlackMessage(slackChannel, slackMessageTs, message);
    logger.info("Posted kickoff next steps to Slack");

    return {
      clientTeamName: extraction.clientTeamName,
      clientTasks: extraction.clientTasks.length,
      airOpsTasks: extraction.airOpsTasks.length,
    };
  },
});
