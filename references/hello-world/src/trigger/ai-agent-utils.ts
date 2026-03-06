import { logger } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { z } from "zod";

// ─── LLM ────────────────────────────────────────────────────────────────────

/**
 * Calls an LLM via OpenRouter in JSON mode, parses + validates the response
 * with a Zod schema, and returns the typed result.
 */
export async function callLLMJson<T extends z.ZodTypeAny>(
  systemPrompt: string,
  userContent: string,
  schema: T,
  options?: { model?: string }
): Promise<z.infer<T>> {
  const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY!,
  });

  const model = options?.model ?? "google/gemini-2.5-flash";

  logger.info("Calling LLM", { model });

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("Empty response from LLM");
  }

  const parsed = JSON.parse(content);
  return schema.parse(parsed);
}

// ─── Slack ──────────────────────────────────────────────────────────────────

function slackToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN environment variable is not set");
  return token;
}

/** Post a new Slack message. Returns the message timestamp. */
export async function postSlackMessage(
  channel: string,
  text: string,
  blocks?: unknown[]
): Promise<string> {
  const body: Record<string, unknown> = { channel, text };
  if (blocks) body.blocks = blocks;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) {
    throw new Error(`Slack postMessage error: ${data.error}`);
  }

  return data.ts!;
}

/** Update an existing Slack message in-place. */
export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[]
): Promise<void> {
  const body: Record<string, unknown> = { channel, ts, text };
  if (blocks) body.blocks = blocks;

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    logger.warn("Failed to update Slack message", { error: data.error });
  }
}

// ─── HubSpot ────────────────────────────────────────────────────────────────

function hubspotToken(): string {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN environment variable is not set");
  return token;
}

async function hubspotGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://api.hubapi.com${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${hubspotToken()}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API ${res.status}: ${text}`);
  }

  return res.json();
}

export interface HubSpotCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  annualRevenue: string | null;
  numberOfEmployees: string | null;
}

/** Fetch a single company by ID. */
export async function fetchHubSpotCompany(companyId: string): Promise<HubSpotCompany> {
  const data = (await hubspotGet(`/crm/v3/objects/companies/${companyId}`, {
    properties: "name,domain,industry,annualrevenue,numberofemployees",
  })) as { id: string; properties: Record<string, string | null> };

  const company: HubSpotCompany = {
    id: data.id,
    name: data.properties.name ?? "Unknown",
    domain: data.properties.domain ?? null,
    industry: data.properties.industry ?? null,
    annualRevenue: data.properties.annualrevenue ?? null,
    numberOfEmployees: data.properties.numberofemployees ?? null,
  };

  logger.info("Fetched HubSpot company", { id: company.id, name: company.name });
  return company;
}

export interface HubSpotDeal {
  id: string;
  name: string;
  stage: string | null;
  amount: string | null;
  closeDate: string | null;
  pipeline: string | null;
  ownerEmail: string | null;
  /** Timestamp when deal entered "Closed Won" stage */
  dateEnteredClosedWon: string | null;
  /** Timestamp when deal entered "Closed Lost" stage */
  dateEnteredClosedLost: string | null;
}

/** Fetch deals associated with a company. */
export async function fetchHubSpotCompanyDeals(companyId: string): Promise<HubSpotDeal[]> {
  // Get associated deal IDs
  const assocData = (await hubspotGet(
    `/crm/v3/objects/companies/${companyId}/associations/deals`
  )) as { results: { id: string }[] };

  if (!assocData.results || assocData.results.length === 0) {
    logger.info("No deals associated with company", { companyId });
    return [];
  }

  // Batch-read deal details (including date entered closedwon/closedlost)
  const dealIds = assocData.results.map((r) => r.id);
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hubspotToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: [
        "dealname",
        "dealstage",
        "amount",
        "closedate",
        "pipeline",
        "hubspot_owner_id",
        "hs_date_entered_closedwon",
        "hs_date_entered_closedlost",
      ],
      inputs: dealIds.map((id) => ({ id })),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot batch read ${res.status}: ${text}`);
  }

  const batchData = (await res.json()) as {
    results: { id: string; properties: Record<string, string | null> }[];
  };

  const deals: HubSpotDeal[] = batchData.results.map((d) => ({
    id: d.id,
    name: d.properties.dealname ?? "Untitled Deal",
    stage: d.properties.dealstage ?? null,
    amount: d.properties.amount ?? null,
    closeDate: d.properties.closedate ?? null,
    pipeline: d.properties.pipeline ?? null,
    ownerEmail: null,
    dateEnteredClosedWon: d.properties.hs_date_entered_closedwon ?? null,
    dateEnteredClosedLost: d.properties.hs_date_entered_closedlost ?? null,
  }));

  logger.info("Fetched HubSpot deals for company", { companyId, count: deals.length });
  return deals;
}

/**
 * Search for recently closed deals (within the last N days) across all companies.
 * Uses the HubSpot deals search API with a date filter on hs_date_entered_closedwon.
 */
export async function fetchRecentlyClosedDeals(
  daysBack = 7,
  limit = 50
): Promise<HubSpotDeal[]> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - daysBack);
  const sinceMs = sinceDate.getTime().toString();

  const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hubspotToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_date_entered_closedwon",
              operator: "GTE",
              value: sinceMs,
            },
          ],
        },
      ],
      properties: [
        "dealname",
        "dealstage",
        "amount",
        "closedate",
        "pipeline",
        "hubspot_owner_id",
        "hs_date_entered_closedwon",
        "hs_date_entered_closedlost",
      ],
      limit,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot deal search ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    results: { id: string; properties: Record<string, string | null> }[];
  };

  const deals: HubSpotDeal[] = data.results.map((d) => ({
    id: d.id,
    name: d.properties.dealname ?? "Untitled Deal",
    stage: d.properties.dealstage ?? null,
    amount: d.properties.amount ?? null,
    closeDate: d.properties.closedate ?? null,
    pipeline: d.properties.pipeline ?? null,
    ownerEmail: null,
    dateEnteredClosedWon: d.properties.hs_date_entered_closedwon ?? null,
    dateEnteredClosedLost: d.properties.hs_date_entered_closedlost ?? null,
  }));

  logger.info("Fetched recently closed deals", { daysBack, count: deals.length });
  return deals;
}

/** Search HubSpot companies by name. Returns up to `limit` results. */
export async function searchHubSpotCompanies(
  query: string,
  limit = 10
): Promise<HubSpotCompany[]> {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hubspotToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            { propertyName: "name", operator: "CONTAINS_TOKEN", value: query },
          ],
        },
      ],
      properties: ["name", "domain", "industry", "annualrevenue", "numberofemployees"],
      limit,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot search ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    results: { id: string; properties: Record<string, string | null> }[];
  };

  return data.results.map((r) => ({
    id: r.id,
    name: r.properties.name ?? "Unknown",
    domain: r.properties.domain ?? null,
    industry: r.properties.industry ?? null,
    annualRevenue: r.properties.annualrevenue ?? null,
    numberOfEmployees: r.properties.numberofemployees ?? null,
  }));
}

/**
 * Search for a company by name, then return its closed deals.
 * "Closed" = dealstage contains "closedwon" or "closedlost".
 */
export async function fetchClosedDealsByCompanyName(
  companyName: string
): Promise<{ company: HubSpotCompany; closedDeals: HubSpotDeal[] } | null> {
  const companies = await searchHubSpotCompanies(companyName, 1);
  if (companies.length === 0) {
    logger.warn("No HubSpot company found for name", { companyName });
    return null;
  }

  const company = companies[0];
  const allDeals = await fetchHubSpotCompanyDeals(company.id);

  const closedDeals = allDeals.filter(
    (d) =>
      d.stage?.toLowerCase().includes("closedwon") ||
      d.stage?.toLowerCase().includes("closedlost") ||
      d.stage?.toLowerCase().includes("closed")
  );

  logger.info("Closed deals for company", {
    company: company.name,
    total: allDeals.length,
    closed: closedDeals.length,
  });

  return { company, closedDeals };
}

// ─── Asana ──────────────────────────────────────────────────────────────────

function asanaToken(): string {
  const token = process.env.ASANA_PAT;
  if (!token) throw new Error("ASANA_PAT environment variable is not set");
  return token;
}

export interface AsanaTaskInput {
  projectGid: string;
  name: string;
  notes?: string;
  dueOn?: string; // YYYY-MM-DD
  assignee?: string; // email or GID
}

/** Create a task in Asana. Returns the new task GID. */
export async function createAsanaTask(input: AsanaTaskInput): Promise<string> {
  const body: Record<string, unknown> = {
    data: {
      name: input.name,
      projects: [input.projectGid],
      ...(input.notes && { notes: input.notes }),
      ...(input.dueOn && { due_on: input.dueOn }),
      ...(input.assignee && { assignee: input.assignee }),
    },
  };

  const res = await fetch("https://app.asana.com/api/1.0/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${asanaToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Asana API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { data: { gid: string } };
  logger.info("Created Asana task", { gid: data.data.gid, name: input.name });
  return data.data.gid;
}

// ─── Asana: Fetch Project Tasks ─────────────────────────────────────────────

export interface AsanaCustomField {
  name: string;
  display_value: string | null;
  enum_value: { name: string } | null;
}

export interface AsanaTaskData {
  gid: string;
  name: string;
  completed: boolean;
  due_on: string | null;
  assignee: { name: string; email: string } | null;
  custom_fields: AsanaCustomField[];
}

/**
 * Fetches all tasks from an Asana project with pagination.
 * Returns typed task data including assignee, completion status, and custom fields.
 */
export async function fetchAsanaProjectTasks(projectGid: string): Promise<AsanaTaskData[]> {
  const tasks: AsanaTaskData[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams({
      opt_fields:
        "name,assignee.name,assignee.email,completed,due_on,custom_fields.name,custom_fields.display_value,custom_fields.enum_value.name",
      limit: "100",
    });
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://app.asana.com/api/1.0/projects/${projectGid}/tasks?${params}`,
      {
        headers: { Authorization: `Bearer ${asanaToken()}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Asana API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      data: AsanaTaskData[];
      next_page: { offset: string } | null;
    };
    tasks.push(...data.data);
    offset = data.next_page?.offset ?? undefined;
  } while (offset);

  logger.info("Fetched Asana project tasks", { projectGid, count: tasks.length });
  return tasks;
}
