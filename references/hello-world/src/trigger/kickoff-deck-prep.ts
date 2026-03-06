import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import OpenAI from "openai";

// --- Constants ---

export const TEMPLATE_DECK_ID = "1t_anxARLilS7ORQezPecpt9sq-PeDsdzq8b4TDOrAko";
export const CUSTOMER_DOCUMENTS_FOLDER_ID = "1j2di9pkLBZN3Eg1z2M7tLMt5pe-Z3Y6V";

// Template slide object IDs
export const SLIDE_IDS = {
  slide3_airopsTeam: "g3b4bbd3806b_2_0",
  slide4_customerTeam: "g3b4bbd3806b_2_127",
};

// Template image element IDs on slide 3 (AirOps team photos)
// Positions by x-coordinate: left (AE), middle (CS Lead), right (SE)
export const SLIDE3_IMAGE_IDS = {
  ae: "g3b4bbd3806b_2_7",      // x=1,601,075 (left, Frank Mayfield)
  csLead: "g3b4bbd3806b_2_9",  // x=3,670,500 (middle, Melanie Dell'Olio)
  se: "g3b4bbd3806b_2_4",      // x=5,827,675 (right, William Reed)
};

// Template dates on slide 10 (Week of X)
const TEMPLATE_WEEK_DATES = ["December 15", "December 22", "December 29", "January 5"];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// --- Zod Schemas ---

const CustomerTeamMemberSchema = z.object({
  name: z.string(),
  title: z.string(),
  role: z.string(),
  notes: z.string(),
});

const UseCaseSchema = z.object({
  name: z.string(),
  problem: z.string(),
  expectedImpact: z.string(),
  requiredData: z.string(),
});

const ExtractionSchema = z.object({
  clientName: z.string(),
  aeName: z.string(),
  aeEmail: z.string(),
  customerTeam: z.array(CustomerTeamMemberSchema),
  kickoffDate: z.string(),
  goLiveDate: z.string(),
  firstWorkflowReviewDate: z.string(),
  companyDescription: z.string(),
  industry: z.string(),
  targetMarket: z.string(),
  cms: z.string(),
  useCases: z.array(UseCaseSchema),
  successMetrics: z.object({
    nearTerm: z.array(z.string()),
    longTerm: z.array(z.string()),
  }),
  projectOverview: z.string(),
  week1Asks: z.array(z.string()),
  targetedQuestions: z.array(z.string()),
  criticalContext: z.object({
    previousVendorIssues: z.string(),
    internalPolitics: z.string(),
    budgetSensitivity: z.string(),
  }),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// --- Helpers ---

/** Convert "MM/DD/YYYY" to "Month Day, Year" */
export function formatDate(dateStr: string): string {
  const [month, day, year] = dateStr.split("/");
  const monthIndex = parseInt(month, 10) - 1;
  const dayNum = parseInt(day, 10);
  return `${MONTH_NAMES[monthIndex]} ${dayNum}, ${year}`;
}

/** Parse "MM/DD/YYYY" into a Date */
function parseDate(dateStr: string): Date {
  const [month, day, year] = dateStr.split("/");
  return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
}

/** Format a Date as "Month Day" (e.g. "January 26") */
function formatMonthDay(date: Date): string {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

/** Format a Date as "MM/DD/YYYY" */
function toDateString(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

/** Get the Monday of or after the given date */
function getNextMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  if (day === 1) return d;
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysUntilMonday);
  return d;
}

// --- Google Auth ---

export async function getGoogleAccessToken(): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get Google access token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

// --- Google Calendar + Gmail Date Validation ---

/** Search Google Calendar for a kickoff meeting with the client */
export async function findKickoffDateFromCalendar(
  accessToken: string,
  clientName: string
): Promise<string | null> {
  const query = encodeURIComponent(`${clientName} kickoff`);
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString();

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${query}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=5`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    logger.warn("Calendar API failed, skipping date validation", {
      status: response.status,
    });
    return null;
  }

  const data = (await response.json()) as {
    items?: Array<{
      summary?: string;
      start?: { dateTime?: string; date?: string };
    }>;
  };

  if (!data.items || data.items.length === 0) {
    logger.info("No calendar events found for kickoff");
    return null;
  }

  // Find the most relevant event
  for (const event of data.items) {
    const summary = (event.summary || "").toLowerCase();
    if (summary.includes("kickoff") || summary.includes("kick-off") || summary.includes("kick off")) {
      const dateStr = event.start?.dateTime || event.start?.date;
      if (dateStr) {
        const d = new Date(dateStr);
        const result = toDateString(d);
        logger.info("Found kickoff date from calendar", {
          event: event.summary,
          date: result,
        });
        return result;
      }
    }
  }

  return null;
}

/** Search Gmail for a kickoff meeting invite with the client */
export async function findKickoffDateFromEmail(
  accessToken: string,
  clientName: string
): Promise<string | null> {
  const query = encodeURIComponent(`${clientName} kickoff subject:(kickoff OR kick-off)`);
  const response = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=5`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    logger.warn("Gmail API failed, skipping email date validation", {
      status: response.status,
    });
    return null;
  }

  const data = (await response.json()) as {
    messages?: Array<{ id: string }>;
  };

  if (!data.messages || data.messages.length === 0) {
    logger.info("No emails found for kickoff");
    return null;
  }

  // Check the first matching email for a date
  const msgId = data.messages[0].id;
  const msgResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!msgResponse.ok) return null;

  const msg = (await msgResponse.json()) as {
    payload?: {
      headers?: Array<{ name: string; value: string }>;
    };
  };

  const dateHeader = msg.payload?.headers?.find((h) => h.name === "Date");
  if (dateHeader) {
    const d = new Date(dateHeader.value);
    if (!isNaN(d.getTime())) {
      const result = toDateString(d);
      logger.info("Found kickoff date from email", { date: result });
      return result;
    }
  }

  return null;
}

// --- Slack Photo Lookup ---

export interface SlackUser {
  id: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile: {
    image_512?: string;
    image_192?: string;
    image_original?: string;
    display_name?: string;
    real_name?: string;
  };
}

/** Fetch all Slack users once, then look up photos by name */
export async function fetchSlackUsers(): Promise<SlackUser[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    logger.warn("SLACK_BOT_TOKEN not set, skipping photo lookup");
    return [];
  }

  const response = await fetch("https://slack.com/api/users.list?limit=500", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    logger.warn("Slack API failed", { status: response.status });
    return [];
  }

  const data = (await response.json()) as {
    ok: boolean;
    members?: SlackUser[];
  };

  if (!data.ok || !data.members) {
    logger.warn("Slack users.list failed");
    return [];
  }

  // Filter out bots and deleted users
  return data.members.filter((m) => !m.is_bot && !m.deleted);
}

/** Find a Slack user's photo by exact name match */
export function findSlackPhoto(users: SlackUser[], name: string): string | null {
  const nameLower = name.toLowerCase().trim();
  if (!nameLower) return null;

  // Pass 1: Exact match on real_name or display_name
  for (const m of users) {
    const realName = (m.real_name || "").toLowerCase().trim();
    const displayName = (m.profile?.display_name || "").toLowerCase().trim();
    const profileRealName = (m.profile?.real_name || "").toLowerCase().trim();

    if (realName === nameLower || displayName === nameLower || profileRealName === nameLower) {
      const url = m.profile.image_512 || m.profile.image_192 || m.profile.image_original;
      if (url) {
        logger.info(`Slack photo found for "${name}" (exact match)`, { userId: m.id, realName: m.real_name });
        return url;
      }
    }
  }

  // Pass 2: First + last name both present in the Slack name
  const nameParts = nameLower.split(/\s+/).filter((p) => p.length > 1);
  if (nameParts.length >= 2) {
    for (const m of users) {
      const realName = (m.real_name || "").toLowerCase();
      if (nameParts.every((part) => realName.includes(part))) {
        const url = m.profile.image_512 || m.profile.image_192 || m.profile.image_original;
        if (url) {
          logger.info(`Slack photo found for "${name}" (partial match)`, { userId: m.id, realName: m.real_name });
          return url;
        }
      }
    }
  }

  logger.warn(`Slack user not found: ${name}`);
  return null;
}

// --- Google Drive & Slides ---

export async function createDriveFolder(
  accessToken: string,
  name: string,
  parentFolderId: string
): Promise<string> {
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create Drive folder: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

export async function copyDriveFile(
  accessToken: string,
  sourceFileId: string,
  name: string,
  parentFolderId: string
): Promise<string> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${sourceFileId}/copy?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        parents: [parentFolderId],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to copy Drive file: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

// --- Slides API ---

export interface SlideReplacement {
  find: string;
  replaceWith: string;
  pageObjectIds?: string[];
}

export interface SlideRequest {
  replaceAllText?: {
    containsText: { text: string; matchCase: boolean };
    replaceText: string;
    pageObjectIds?: string[];
  };
  replaceImage?: {
    imageObjectId: string;
    url: string;
    imageReplaceMethod: string;
  };
  updateTextStyle?: {
    objectId: string;
    textRange: { type: string; startIndex: number; endIndex: number };
    style: { link: { url: string } };
    fields: string;
  };
}

export async function batchUpdateSlides(
  accessToken: string,
  presentationId: string,
  requests: SlideRequest[]
): Promise<void> {
  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update slides: ${response.status} ${text}`);
  }
}

/** Find the objectId and text range of a string on a specific slide */
export async function findTextRange(
  accessToken: string,
  presentationId: string,
  slideObjectId: string,
  searchText: string
): Promise<{ objectId: string; startIndex: number; endIndex: number } | null> {
  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${presentationId}/pages/${slideObjectId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    logger.warn("Failed to read slide for text range lookup", { status: response.status });
    return null;
  }

  const page = (await response.json()) as {
    pageElements?: Array<{
      objectId: string;
      shape?: {
        text?: {
          textElements?: Array<{
            startIndex?: number;
            endIndex?: number;
            textRun?: { content: string };
          }>;
        };
      };
    }>;
  };

  for (const el of page.pageElements || []) {
    const textElements = el.shape?.text?.textElements;
    if (!textElements) continue;

    // Build the full text of this shape to find the search string
    let fullText = "";
    const runs: Array<{ start: number; end: number; content: string }> = [];
    for (const te of textElements) {
      if (te.textRun?.content) {
        const start = te.startIndex ?? 0;
        const end = te.endIndex ?? start + te.textRun.content.length;
        runs.push({ start, end, content: te.textRun.content });
        // Pad fullText to align indices
        while (fullText.length < start) fullText += " ";
        fullText += te.textRun.content;
      }
    }

    const idx = fullText.indexOf(searchText);
    if (idx !== -1) {
      return {
        objectId: el.objectId,
        startIndex: idx,
        endIndex: idx + searchText.length,
      };
    }
  }

  return null;
}

// --- AI Extraction ---

const EXTRACTION_PROMPT = `You are an AI data extraction specialist for AirOps client onboarding. Analyze the following client handoff transcript and extract structured data for a kickoff deck.

IMPORTANT: Use cases must ALWAYS be named either "Content Creation" or "Content Refresh". Never use names like "SEO Content Generation", "Product Description Automation", etc. The only valid use case names are:
- "Content Creation" — for new content production
- "Content Refresh" — for updating/refreshing existing content

Extract the following fields as JSON:

- clientName: The client company name
- aeName: The Account Executive's full name (from AirOps side)
- aeEmail: The Account Executive's email address
- customerTeam: An array of the CLIENT's team members (not AirOps staff), each with:
  - name: Full name
  - title: Job title
  - role: Their role in the project (e.g. "Executive Sponsor", "Day-to-Day Lead", "Technical Lead")
  - notes: Brief description of their involvement or responsibilities (1-2 sentences)
- kickoffDate: The kickoff/meeting date in MM/DD/YYYY format. Use the recording date if no specific kickoff date is mentioned.
- goLiveDate: The target go-live date in MM/DD/YYYY format
- firstWorkflowReviewDate: The first workflow review date in MM/DD/YYYY format (typically ~2 weeks after kickoff)
- companyDescription: A concise description of what the company does (1-2 sentences)
- industry: The client's industry (e.g. "B2B SaaS", "E-commerce", "Healthcare")
- targetMarket: The client's target market or audience
- cms: The CMS or content platform they use (e.g. "WordPress", "Contentful", "Webflow")
- useCases: An array of use cases. ONLY use these names: "Content Creation" or "Content Refresh". Each with:
  - name: MUST be either "Content Creation" or "Content Refresh"
  - problem: The problem this use case solves
  - expectedImpact: Expected business impact
  - requiredData: Data sources or inputs needed
- successMetrics: An object with:
  - nearTerm: Array of near-term success metrics (30-60 day goals)
  - longTerm: Array of long-term success metrics (90+ day goals)
- projectOverview: A 2-3 sentence project overview summarizing the engagement
- week1Asks: Array of specific asks/deliverables for week 1
- targetedQuestions: Array of questions to ask the client during kickoff
- criticalContext: An object with:
  - previousVendorIssues: Any issues with previous vendors or tools (or "None mentioned")
  - internalPolitics: Any internal politics or sensitivities to be aware of (or "None mentioned")
  - budgetSensitivity: Budget constraints or sensitivities (or "None mentioned")

If a field cannot be determined from the transcript, use reasonable defaults:
- For dates, use empty string ""
- For arrays, use empty arrays []
- For strings, use "Not specified"

Return ONLY valid JSON, no markdown code fences.`;

export async function extractFromTranscript(transcript: string): Promise<Extraction> {
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
  return ExtractionSchema.parse(parsed);
}

// --- Build Replacement Map ---

export function buildReplacements(
  data: Extraction,
  seName: string,
  csLead: string,
  notionLink?: string
): SlideReplacement[] {
  const replacements: SlideReplacement[] = [];

  // --- Global replacements (all slides) ---

  replacements.push({ find: "[Customer]", replaceWith: data.clientName });

  // Kickoff date on slide 1 (template has "December 11, 2026")
  if (data.kickoffDate) {
    const formattedKickoff = formatDate(data.kickoffDate);
    replacements.push({ find: "December 11, 2026", replaceWith: formattedKickoff });
  }

  // Use case placeholders
  if (data.useCases[0]) {
    replacements.push({ find: "[Use Case 1]", replaceWith: data.useCases[0].name });
    replacements.push({
      find: "Content refreshes for 5,000 glossary pages",
      replaceWith: data.useCases[0].name,
    });
  }
  if (data.useCases[1]) {
    replacements.push({ find: "[Use Case 2]", replaceWith: data.useCases[1].name });
  }

  // Industry/market/CMS on slide 6
  replacements.push({ find: "[Industry]", replaceWith: data.industry });
  replacements.push({ find: "[target market]", replaceWith: data.targetMarket });
  replacements.push({ find: "[CMS]", replaceWith: data.cms });
  replacements.push({ find: "[key business area]", replaceWith: data.industry });

  if (data.successMetrics.nearTerm[0]) {
    replacements.push({ find: "[specific goal]", replaceWith: data.successMetrics.nearTerm[0] });
  }

  // --- Slide 3 only: AirOps team NAMES (titles stay as-is) ---

  replacements.push({
    find: "Frank Mayfield",
    replaceWith: data.aeName,
    pageObjectIds: [SLIDE_IDS.slide3_airopsTeam],
  });
  replacements.push({
    find: "William Reed",
    replaceWith: seName,
    pageObjectIds: [SLIDE_IDS.slide3_airopsTeam],
  });
  replacements.push({
    find: "Melanie Dell\u2019Olio",
    replaceWith: csLead,
    pageObjectIds: [SLIDE_IDS.slide3_airopsTeam],
  });

  // --- Slide 4 only: Customer team names, titles, and descriptions ---

  const team = data.customerTeam;
  if (team[0]) {
    replacements.push({
      find: "Frank Mayfield",
      replaceWith: team[0].name,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
    replacements.push({
      find: "Account Executive",
      replaceWith: team[0].title,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
    replacements.push({
      find: "Partner for strategic alignment, ensuring milestone attainment, and commercials",
      replaceWith: team[0].notes,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
  }
  if (team[1]) {
    replacements.push({
      find: "Melanie Dell\u2019Olio",
      replaceWith: team[1].name,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
    replacements.push({
      find: "AI Solutions Architect, Team Lead",
      replaceWith: team[1].title,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
    replacements.push({
      find: "Advises on strategy and technical builds inside the AirOps platform",
      replaceWith: team[1].notes,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
  }
  if (team[2]) {
    replacements.push({
      find: "William Reed",
      replaceWith: team[2].name,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
    replacements.push({
      find: "AI Solutions Architect",
      replaceWith: team[2].title,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
    replacements.push({
      find: "Executes technical builds inside the AirOps platform",
      replaceWith: team[2].notes,
      pageObjectIds: [SLIDE_IDS.slide4_customerTeam],
    });
  }

  // --- Slide 11: Delete SA instruction text ---
  if (notionLink) {
    const slide11Id = "g391a42dc00b_0_193";
    replacements.push({
      find: "SA - link checklist + fill out emojis based on whats been completed",
      replaceWith: "",
      pageObjectIds: [slide11Id],
    });
  }

  // --- Slide 10: Timeline week dates ---
  if (data.kickoffDate) {
    const kickoff = parseDate(data.kickoffDate);
    const firstMonday = getNextMonday(kickoff);

    for (let week = 0; week < TEMPLATE_WEEK_DATES.length; week++) {
      const newMonday = new Date(firstMonday);
      newMonday.setDate(firstMonday.getDate() + week * 7);
      const newLabel = formatMonthDay(newMonday);

      if (TEMPLATE_WEEK_DATES[week] !== newLabel) {
        replacements.push({
          find: TEMPLATE_WEEK_DATES[week],
          replaceWith: newLabel,
        });
      }
    }
  }

  return replacements;
}

// --- Main Task ---

export const kickoffDeckPrep = schemaTask({
  id: "kickoff-deck-prep",
  schema: z.object({
    transcript: z.string().describe("Client handoff document text"),
    seName: z.string().describe("Solutions Engineer name"),
    csLead: z.string().describe("CS Lead name"),
    kickoffDate: z
      .string()
      .optional()
      .describe("Override kickoff date (MM/DD/YYYY). If omitted, found from calendar/email/transcript."),
    notionLink: z
      .string()
      .optional()
      .describe("Notion intake checklist URL for slide 11"),
  }),
  retry: {
    maxAttempts: 2,
  },
  run: async (payload) => {
    // Step 1: Extract structured data from transcript
    logger.info("Step 1: Extracting structured data from transcript...");
    const extractedData = await extractFromTranscript(payload.transcript);
    logger.info("Extraction complete", {
      clientName: extractedData.clientName,
      kickoffDate: extractedData.kickoffDate,
      useCases: extractedData.useCases.map((u) => u.name),
      teamMembers: extractedData.customerTeam.length,
    });

    // Step 2: Get Google OAuth access token
    logger.info("Step 2: Getting Google OAuth access token...");
    const accessToken = await getGoogleAccessToken();
    logger.info("OAuth token acquired");

    // Step 3: Validate kickoff date from Calendar and Email
    logger.info("Step 3: Validating kickoff date from Calendar & Email...");
    if (payload.kickoffDate) {
      extractedData.kickoffDate = payload.kickoffDate;
      logger.info("Using explicit kickoff date override", { date: payload.kickoffDate });
    } else {
      // Try Calendar first, then Email
      const calendarDate = await findKickoffDateFromCalendar(
        accessToken,
        extractedData.clientName
      );
      if (calendarDate) {
        logger.info("Using kickoff date from Google Calendar", {
          calendarDate,
          transcriptDate: extractedData.kickoffDate,
        });
        extractedData.kickoffDate = calendarDate;
      } else {
        const emailDate = await findKickoffDateFromEmail(accessToken, extractedData.clientName);
        if (emailDate) {
          logger.info("Using kickoff date from Gmail", {
            emailDate,
            transcriptDate: extractedData.kickoffDate,
          });
          extractedData.kickoffDate = emailDate;
        } else {
          logger.info("No kickoff date found in Calendar/Email, using transcript date", {
            date: extractedData.kickoffDate,
          });
        }
      }
    }

    // Step 4: Build replacement map
    logger.info("Step 4: Building replacement map...");
    const replacements = buildReplacements(extractedData, payload.seName, payload.csLead, payload.notionLink);
    logger.info(`Built ${replacements.length} text replacements`);

    // Step 5: Look up Slack profile photos for AirOps team
    logger.info("Step 5: Looking up Slack profile photos...");
    const slackUsers = await fetchSlackUsers();
    const aePhoto = findSlackPhoto(slackUsers, extractedData.aeName);
    const csPhoto = findSlackPhoto(slackUsers, payload.csLead);
    const sePhoto = findSlackPhoto(slackUsers, payload.seName);
    logger.info("Slack photo lookup complete", {
      aePhoto: !!aePhoto,
      sePhoto: !!sePhoto,
      csPhoto: !!csPhoto,
    });

    // Step 6: Create client folder in Google Drive
    logger.info("Step 6: Creating client folder in Google Drive...");
    const folderId = await createDriveFolder(
      accessToken,
      extractedData.clientName,
      CUSTOMER_DOCUMENTS_FOLDER_ID
    );
    logger.info("Folder created", { folderId });

    // Step 7: Copy template deck into client folder
    logger.info("Step 7: Copying template deck...");
    const deckId = await copyDriveFile(
      accessToken,
      TEMPLATE_DECK_ID,
      `${extractedData.clientName} | AirOps Kickoff`,
      folderId
    );
    logger.info("Deck copied", { deckId });

    // Step 8: Build batch update requests (text replacements + image replacements)
    logger.info("Step 8: Applying text and image replacements...");
    const requests: SlideRequest[] = [];

    // Text replacements
    for (const { find, replaceWith, pageObjectIds } of replacements) {
      requests.push({
        replaceAllText: {
          containsText: { text: find, matchCase: true },
          replaceText: replaceWith,
          ...(pageObjectIds ? { pageObjectIds } : {}),
        },
      });
    }

    // Image replacements for AirOps team (slide 3)
    if (aePhoto) {
      requests.push({
        replaceImage: {
          imageObjectId: SLIDE3_IMAGE_IDS.ae,
          url: aePhoto,
          imageReplaceMethod: "CENTER_CROP",
        },
      });
    }
    if (csPhoto) {
      requests.push({
        replaceImage: {
          imageObjectId: SLIDE3_IMAGE_IDS.csLead,
          url: csPhoto,
          imageReplaceMethod: "CENTER_CROP",
        },
      });
    }
    if (sePhoto) {
      requests.push({
        replaceImage: {
          imageObjectId: SLIDE3_IMAGE_IDS.se,
          url: sePhoto,
          imageReplaceMethod: "CENTER_CROP",
        },
      });
    }

    await batchUpdateSlides(accessToken, deckId, requests);
    logger.info("All replacements applied");

    // Step 9: Set hyperlink on "Intake checklist linked here" (slide 11)
    if (payload.notionLink) {
      logger.info("Step 9: Setting Notion hyperlink on slide 11...");
      const slide11Id = "g391a42dc00b_0_193";
      const textRange = await findTextRange(
        accessToken,
        deckId,
        slide11Id,
        "Intake checklist linked here"
      );
      if (textRange) {
        await batchUpdateSlides(accessToken, deckId, [
          {
            updateTextStyle: {
              objectId: textRange.objectId,
              textRange: {
                type: "FIXED_RANGE",
                startIndex: textRange.startIndex,
                endIndex: textRange.endIndex,
              },
              style: { link: { url: payload.notionLink } },
              fields: "link",
            },
          },
        ]);
        logger.info("Notion hyperlink set on slide 11");
      } else {
        logger.warn("Could not find 'Intake checklist linked here' text on slide 11");
      }
    }

    const result = {
      deckUrl: `https://docs.google.com/presentation/d/${deckId}/edit`,
      deckId,
      folderId,
      folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
      clientName: extractedData.clientName,
      extractedData,
    };

    logger.info("Kickoff deck prep complete", {
      deckUrl: result.deckUrl,
      folderUrl: result.folderUrl,
      clientName: result.clientName,
    });

    return result;
  },
});
