import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  callLLMJson,
  postSlackMessage,
  fetchAsanaProjectTasks,
  fetchHubSpotCompany,
  fetchHubSpotCompanyDeals,
  type AsanaTaskData,
  type HubSpotCompany,
  type HubSpotDeal,
} from "./ai-agent-utils";

// ─── Types & Constants ──────────────────────────────────────────────────────

const PHASE_WEIGHTS: Record<string, number> = {
  "pre-activation": 3,
  activation: 4,
  "maintenance syncs": 2,
  "live but syncs": 2,
  "async support": 1,
  "minimal support": 1,
  churned: 0,
  unknown: 2,
};

const DEAL_CAPACITY_COST: Record<string, number> = {
  small: 2,
  medium: 4,
  large: 6,
  enterprise: 8,
};

const MAX_CAPACITY = 20;

export interface SAWorkload {
  name: string;
  email: string;
  totalTasks: number;
  phaseCounts: Record<string, number>;
  weightedScore: number;
  bandwidth: number;
}

// ─── LLM Schema ─────────────────────────────────────────────────────────────

const RecommendationSchema = z.object({
  topPick: z.string(),
  reasoning: z.string(),
  riskFactors: z.array(z.string()),
  alternativeReasoning: z.string(),
  teamCapacitySummary: z.string(),
});

type Recommendation = z.infer<typeof RecommendationSchema>;

// ─── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a workload balancing advisor for a Solutions Architecture team.

Given each SA's current workload (active clients by phase, weighted score, remaining bandwidth) and details about an incoming deal, recommend who should take it.

Consider:
1. Available bandwidth (higher = more capacity)
2. Phase complexity — SAs deep in calibration/implementation have less mental bandwidth even if counts are similar
3. Deal size and priority — larger/critical deals need SAs with more headroom
4. Risk of overload — flag SAs near capacity

Return JSON with these exact fields:
- topPick: the SA name you recommend
- reasoning: 2-3 sentences explaining why this SA is the best fit
- riskFactors: array of strings — any concerns (e.g. "SA is at 85% capacity", "no backup if they're out")
- alternativeReasoning: backup pick name + 1-2 sentences on why they're the runner-up
- teamCapacitySummary: 1-2 sentences on overall team bandwidth

Return ONLY valid JSON, no markdown code fences.`;

// ─── Pure Functions ─────────────────────────────────────────────────────────

export function computeWorkloads(
  tasks: AsanaTaskData[],
  phaseFieldName: string,
  maxCapacity: number
): SAWorkload[] {
  // Filter to incomplete + assigned tasks
  const activeTasks = tasks.filter((t) => !t.completed && t.assignee);

  // Group by assignee
  const byAssignee = new Map<string, { email: string; tasks: AsanaTaskData[] }>();

  for (const task of activeTasks) {
    const name = task.assignee!.name;
    const email = task.assignee!.email;
    if (!byAssignee.has(name)) {
      byAssignee.set(name, { email, tasks: [] });
    }
    byAssignee.get(name)!.tasks.push(task);
  }

  const workloads: SAWorkload[] = [];

  for (const [name, { email, tasks: saTasks }] of byAssignee) {
    const phaseCounts: Record<string, number> = {};

    for (const task of saTasks) {
      const phaseField = task.custom_fields?.find(
        (f) => f.name.toLowerCase() === phaseFieldName.toLowerCase()
      );
      const phase = phaseField?.enum_value?.name?.toLowerCase() ?? phaseField?.display_value?.toLowerCase() ?? "unknown";
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    }

    let weightedScore = 0;
    for (const [phase, count] of Object.entries(phaseCounts)) {
      const weight = PHASE_WEIGHTS[phase] ?? PHASE_WEIGHTS.unknown;
      weightedScore += count * weight;
    }

    workloads.push({
      name,
      email,
      totalTasks: saTasks.length,
      phaseCounts,
      weightedScore,
      bandwidth: maxCapacity - weightedScore,
    });
  }

  // Sort by bandwidth descending (most available first)
  workloads.sort((a, b) => b.bandwidth - a.bandwidth);

  return workloads;
}

function bandwidthEmoji(bandwidth: number, maxCapacity: number): string {
  const pct = bandwidth / maxCapacity;
  if (pct >= 0.5) return ":large_green_circle:";
  if (pct >= 0.2) return ":large_yellow_circle:";
  return ":red_circle:";
}

export function buildWorkloadBlocks(
  deal: { dealName: string; dealSize: string; dealPriority: string },
  workloads: SAWorkload[],
  recommendation: Recommendation,
  dealCapacityCost: number
): { text: string; blocks: unknown[] } {
  const text = `SA Workload Recommendation — *${recommendation.topPick}* for ${deal.dealName} (${deal.dealSize}/${deal.dealPriority})`;

  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "SA Workload Recommendation" },
  });

  // Deal context
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*Deal:* ${deal.dealName}  |  *Size:* ${deal.dealSize}  |  *Priority:* ${deal.dealPriority}  |  *Capacity cost:* ${dealCapacityCost}`,
      },
    ],
  });

  blocks.push({ type: "divider" });

  // Top pick
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:trophy: *Top Pick: ${recommendation.topPick}*\n${recommendation.reasoning}`,
    },
  });

  blocks.push({ type: "divider" });

  // Workload table
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Team Workloads:*" },
  });

  for (const sa of workloads) {
    const emoji = bandwidthEmoji(sa.bandwidth, MAX_CAPACITY);
    const phases = Object.entries(sa.phaseCounts)
      .map(([phase, count]) => `${phase}: ${count}`)
      .join(", ");
    const isTopPick = sa.name === recommendation.topPick;

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} ${isTopPick ? ":point_right: " : ""}*${sa.name}* — ${sa.totalTasks} active tasks | Score: ${sa.weightedScore}/${MAX_CAPACITY} | Bandwidth: ${sa.bandwidth}\n_Phases: ${phases || "none"}_`,
      },
    });
  }

  blocks.push({ type: "divider" });

  // Risk factors
  if (recommendation.riskFactors.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*:warning: Risk Factors:*\n${recommendation.riskFactors.map((r) => `• ${r}`).join("\n")}`,
      },
    });
  }

  // Alternative
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*:arrows_counterclockwise: Alternative:*\n${recommendation.alternativeReasoning}`,
    },
  });

  // Team capacity summary
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*:bar_chart: Team Capacity:*\n${recommendation.teamCapacitySummary}`,
    },
  });

  // Footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `SA Workload Balancer | ${workloads.length} SAs analyzed | ${new Date().toISOString()}`,
      },
    ],
  });

  return { text, blocks };
}

// ─── HubSpot Helpers ────────────────────────────────────────────────────────

function inferDealSize(
  company: HubSpotCompany,
  deals: HubSpotDeal[]
): "small" | "medium" | "large" | "enterprise" {
  // Use largest deal amount if available
  const maxAmount = Math.max(
    0,
    ...deals.map((d) => (d.amount ? parseFloat(d.amount) : 0))
  );

  if (maxAmount >= 100_000) return "enterprise";
  if (maxAmount >= 50_000) return "large";
  if (maxAmount >= 15_000) return "medium";
  if (maxAmount > 0) return "small";

  // Fallback: use employee count
  const employees = company.numberOfEmployees
    ? parseInt(company.numberOfEmployees, 10)
    : 0;

  if (employees >= 1000) return "enterprise";
  if (employees >= 200) return "large";
  if (employees >= 50) return "medium";
  return "small";
}

function buildHubSpotContext(company: HubSpotCompany, deals: HubSpotDeal[]): string {
  const lines: string[] = [
    `Company: ${company.name}`,
    company.domain && `Domain: ${company.domain}`,
    company.industry && `Industry: ${company.industry}`,
    company.annualRevenue && `Annual Revenue: $${company.annualRevenue}`,
    company.numberOfEmployees && `Employees: ${company.numberOfEmployees}`,
  ].filter(Boolean) as string[];

  if (deals.length > 0) {
    lines.push("", "Associated Deals:");
    for (const deal of deals) {
      const parts = [deal.name];
      if (deal.amount) parts.push(`$${deal.amount}`);
      if (deal.stage) parts.push(`stage: ${deal.stage}`);
      if (deal.closeDate) parts.push(`close: ${deal.closeDate}`);
      lines.push(`  - ${parts.join(" | ")}`);
    }
  }

  return lines.join("\n");
}

// ─── Task ───────────────────────────────────────────────────────────────────

export const saWorkloadBalancer = schemaTask({
  id: "sa-workload-balancer",
  schema: z.object({
    hubspotCompanyId: z.string().optional().describe("HubSpot company ID to pull deal/account data from (optional — if omitted, dealName and dealSize are required)"),
    dealName: z.string().optional().describe("Deal/company name (required if no hubspotCompanyId)"),
    dealSize: z.enum(["small", "medium", "large", "enterprise"]).optional().describe("Override deal size tier (auto-detected from HubSpot amount if omitted)"),
    dealPriority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Deal priority (defaults to medium)"),
    asanaProjectGid: z.string().describe("Asana project GID containing SA client tasks"),
    slackChannel: z.string().describe("Slack channel or user ID to post recommendation"),
    phaseFieldName: z.string().optional().describe("Name of the phase custom field in Asana (default: Customer Status)"),
    saFilter: z.array(z.string()).optional().describe("Limit to these SA names or emails"),
  }),
  retry: { maxAttempts: 2 },
  run: async (payload) => {
    const {
      hubspotCompanyId,
      asanaProjectGid,
      slackChannel,
      phaseFieldName = "Customer Status",
      saFilter,
    } = payload;

    logger.info("Starting SA workload balancer", { hubspotCompanyId, asanaProjectGid });

    // ── Step 0: Fetch HubSpot company & deals (optional) ─────────────────
    let dealName: string;
    let dealSize: "small" | "medium" | "large" | "enterprise";
    let dealPriority: string;
    let dealNotes: string;

    if (hubspotCompanyId) {
      const company = await fetchHubSpotCompany(hubspotCompanyId);
      const deals = await fetchHubSpotCompanyDeals(hubspotCompanyId);

      dealName = company.name;
      dealSize = payload.dealSize ?? inferDealSize(company, deals);
      dealPriority = payload.dealPriority ?? "medium";
      dealNotes = buildHubSpotContext(company, deals);

      logger.info("HubSpot data loaded", {
        company: company.name,
        dealCount: deals.length,
        inferredSize: dealSize,
      });
    } else {
      dealName = payload.dealName || "Unknown Deal";
      dealSize = payload.dealSize || "medium";
      dealPriority = payload.dealPriority ?? "medium";
      dealNotes = "";

      logger.info("Running without HubSpot", { dealName, dealSize, dealPriority });
    }

    // ── Step 1: Fetch Asana tasks ──────────────────────────────────────────
    const allTasks = await fetchAsanaProjectTasks(asanaProjectGid);

    if (allTasks.length === 0) {
      logger.warn("No tasks found in Asana project", { asanaProjectGid });
      await postSlackMessage(
        slackChannel,
        `:warning: SA Workload Balancer — No tasks found in Asana project \`${asanaProjectGid}\`. Cannot generate recommendation for *${dealName}*.`
      );
      return { error: "no_tasks" as const };
    }

    // ── Step 2: Compute workloads ──────────────────────────────────────────
    let workloads = computeWorkloads(allTasks, phaseFieldName, MAX_CAPACITY);

    // Apply SA filter if provided
    if (saFilter && saFilter.length > 0) {
      const filterSet = new Set(saFilter.map((s) => s.toLowerCase()));
      workloads = workloads.filter(
        (sa) => filterSet.has(sa.name.toLowerCase()) || filterSet.has(sa.email.toLowerCase())
      );
    }

    if (workloads.length === 0) {
      logger.warn("No SAs with assigned tasks found", { asanaProjectGid, saFilter });
      await postSlackMessage(
        slackChannel,
        `:warning: SA Workload Balancer — No SAs with assigned tasks found in project \`${asanaProjectGid}\`. Cannot generate recommendation for *${dealName}*.`
      );
      return { error: "no_sas" as const };
    }

    logger.info("Computed workloads", {
      saCount: workloads.length,
      workloads: workloads.map((w) => ({ name: w.name, score: w.weightedScore, bandwidth: w.bandwidth })),
    });

    // ── Step 3: LLM recommendation ─────────────────────────────────────────
    const dealCapacityCost = DEAL_CAPACITY_COST[dealSize];

    const workloadSummary = workloads
      .map(
        (sa) =>
          `${sa.name} (${sa.email}): ${sa.totalTasks} active tasks, weighted score ${sa.weightedScore}/${MAX_CAPACITY}, bandwidth ${sa.bandwidth}. Phases: ${
            Object.entries(sa.phaseCounts)
              .map(([p, c]) => `${p}(${c})`)
              .join(", ") || "none"
          }`
      )
      .join("\n");

    const userPrompt = [
      `Incoming deal: ${dealName}`,
      `Size: ${dealSize} (capacity cost: ${dealCapacityCost})`,
      `Priority: ${dealPriority}`,
      dealNotes && `Notes: ${dealNotes}`,
      "",
      "Current SA workloads:",
      workloadSummary,
    ]
      .filter(Boolean)
      .join("\n");

    const recommendation = await callLLMJson(SYSTEM_PROMPT, userPrompt, RecommendationSchema);

    logger.info("LLM recommendation", {
      topPick: recommendation.topPick,
      riskFactors: recommendation.riskFactors,
    });

    // ── Step 4: Post to Slack ──────────────────────────────────────────────
    const { text, blocks } = buildWorkloadBlocks(
      { dealName, dealSize, dealPriority },
      workloads,
      recommendation,
      dealCapacityCost
    );

    await postSlackMessage(slackChannel, text, blocks);

    logger.info("Posted SA workload recommendation to Slack", {
      channel: slackChannel,
      topPick: recommendation.topPick,
    });

    return {
      topPick: recommendation.topPick,
      recommendation,
      workloads: workloads.map((w) => ({
        name: w.name,
        totalTasks: w.totalTasks,
        weightedScore: w.weightedScore,
        bandwidth: w.bandwidth,
      })),
    };
  },
});
