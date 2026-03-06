import { schemaTask, schedules, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { fetchAsanaProjectTasks } from "./ai-agent-utils";

// ─── Config ──────────────────────────────────────────────────────────────────

function slackUserToken(): string {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error("SLACK_USER_TOKEN environment variable is not set");
  return token;
}

// ─── Slack API ───────────────────────────────────────────────────────────────

interface SlackChannel {
  id: string;
  name: string;
  is_ext_shared: boolean;
}

async function fetchAllSlackChannels(): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${slackUserToken()}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "10", 10);
      logger.warn("Slack rate limited, waiting", { retryAfter });
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    const data = (await res.json()) as {
      ok: boolean;
      channels: Array<{ id: string; name: string; is_ext_shared: boolean }>;
      response_metadata?: { next_cursor?: string };
      error?: string;
    };

    if (!data.ok) {
      throw new Error(`Slack conversations.list error: ${data.error}`);
    }

    channels.push(
      ...data.channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        is_ext_shared: ch.is_ext_shared,
      }))
    );

    cursor = data.response_metadata?.next_cursor || undefined;

    // Small delay between pages to be kind to rate limits
    if (cursor) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } while (cursor);

  logger.info("Fetched all Slack channels", { count: channels.length });
  return channels;
}

// ─── Name Matching ───────────────────────────────────────────────────────────

/**
 * Extracts the core customer name from an Asana task name.
 * Handles: "Chargebee Inc.", "chargebee.com", "Oyster HR, Inc", "RehabPath, Inc. dba Recovery.com"
 */
function extractCustomerName(raw: string): string {
  let name = raw.trim();

  // If it's a "X dba Y" pattern, take the DBA name (the operating name)
  const dbaMatch = name.match(/\bd[/.]?b[/.]?a\s+(.+)$/i);
  if (dbaMatch) {
    name = dbaMatch[1].trim();
  }

  // Strip domain TLDs (.com, .co, .io, .ai, etc.)
  name = name.replace(/\.(com|co|io|ai|org|net|fr|be|ag|global)$/i, "");

  // Strip corporate suffixes
  name = name.replace(/[,.]?\s*(Inc\.?|LLC\.?|Ltd\.?|Co\.?|Corp\.?|AG|B\.?V\.?|Pte\.?\s*Ltd\.?|SAS\.?|GmbH|Limited)\s*[,.]?\s*$/gi, "");

  // Strip trailing punctuation/whitespace
  name = name.replace(/[,.\s]+$/, "").trim();

  return name;
}

/**
 * Normalizes a name to lowercase alphanumeric for comparison.
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Splits a Slack channel name into its hyphen-separated segments.
 * e.g., "airops-betterhelp" -> ["airops", "betterhelp"]
 *        "c-internal-hootsuite" -> ["c", "internal", "hootsuite"]
 */
function channelSegments(channelName: string): string[] {
  return channelName.toLowerCase().split("-").filter(Boolean);
}

/**
 * Checks if a Slack channel name matches a customer name.
 * Uses segment-boundary matching to avoid false positives:
 *   - "Sage" matches "airops-sage" but NOT "airops-agentfire" or "test-oauth-messages"
 *   - "Hootsuite" matches "airops-hootsuite" and "c-internal-hootsuite"
 *   - Multi-word names like "Brunt Workwear" match "airops-brunt-workwear"
 */
function channelMatchesCustomer(channelName: string, customerName: string): boolean {
  const cleaned = extractCustomerName(customerName);
  const normalizedCustomer = normalize(cleaned);

  if (!normalizedCustomer || normalizedCustomer.length < 2) return false;

  const segments = channelSegments(channelName);

  // Skip common prefix/suffix segments that aren't customer names
  const SKIP_SEGMENTS = new Set([
    "airops", "c", "d", "g", "p", "ext", "internal", "external",
    "temp", "test", "partner", "cohort", "shared", "slack",
    "engineering", "partnership", "training", "offsite",
    "approvals", "report", "notifications",
  ]);

  // Join non-skip segments and check if the customer name matches
  const meaningfulSegments = segments.filter((s) => !SKIP_SEGMENTS.has(s));

  // Strategy 1: Check if any single segment matches the full customer name
  // e.g., "airops-hootsuite" segment "hootsuite" matches customer "Hootsuite"
  for (const seg of meaningfulSegments) {
    if (seg === normalizedCustomer) return true;
  }

  // Strategy 2: Join consecutive meaningful segments and check for match
  // e.g., "airops-brunt-workwear" -> "bruntworkwear" matches "Brunt Workwear"
  const joined = meaningfulSegments.join("");
  if (joined === normalizedCustomer) return true;

  // Strategy 3: For longer customer names (6+ chars), allow substring matching
  // on joined meaningful segments to handle slight variations
  // e.g., "airops-monarchmoney" matches "Monarch Money"
  if (normalizedCustomer.length >= 6) {
    if (joined.includes(normalizedCustomer) || normalizedCustomer.includes(joined)) {
      // Extra guard: the matched portion must be a significant part of the channel
      // to avoid "HBR" matching inside some long channel name
      if (joined.length > 0 && normalizedCustomer.length / joined.length > 0.3) {
        return true;
      }
    }
  }

  return false;
}

// ─── Main Task ───────────────────────────────────────────────────────────────

export const channelDiscovery = schemaTask({
  id: "channel-discovery",
  schema: z.object({
    asanaProjectGid: z.string().describe("Asana project GID to pull customer/account tasks from"),
  }),
  retry: { maxAttempts: 2 },
  run: async ({ asanaProjectGid }) => {
    logger.info("Starting channel discovery", { asanaProjectGid });

    // Step 1: Fetch all tasks from the Asana project
    const asanaTasks = await fetchAsanaProjectTasks(asanaProjectGid);
    logger.info("Fetched Asana tasks", { count: asanaTasks.length });

    // Extract unique customer names from task names (skip completed tasks)
    const customerNames = asanaTasks
      .filter((t) => !t.completed)
      .map((t) => t.name.trim())
      .filter((name) => name.length > 0);

    const uniqueNames = [...new Set(customerNames)];
    logger.info("Extracted customer names from Asana", {
      total: uniqueNames.length,
      sample: uniqueNames.slice(0, 10),
    });

    // Step 2: Fetch all Slack channels
    const allChannels = await fetchAllSlackChannels();

    // Step 3: Match customer names to Slack channels (external/Slack Connect only)
    const extChannels = allChannels.filter((ch) => ch.is_ext_shared);
    logger.info("Filtered to external Slack Connect channels", {
      total: allChannels.length,
      extShared: extChannels.length,
    });

    const matchedChannels: Array<{
      channelId: string;
      channelName: string;
      is_ext_shared: boolean;
      matchedAsanaTask: string;
    }> = [];

    const unmatchedCustomers: string[] = [];

    for (const customerName of uniqueNames) {
      const matches = extChannels.filter((ch) =>
        channelMatchesCustomer(ch.name, customerName)
      );

      if (matches.length > 0) {
        for (const match of matches) {
          // Avoid duplicates (same channel matched by different task names)
          if (!matchedChannels.some((m) => m.channelId === match.id)) {
            matchedChannels.push({
              channelId: match.id,
              channelName: match.name,
              is_ext_shared: match.is_ext_shared,
              matchedAsanaTask: customerName,
            });
          }
        }
      } else {
        unmatchedCustomers.push(customerName);
      }
    }

    logger.info("Channel discovery results", {
      matchedChannels: matchedChannels.length,
      unmatchedCustomers: unmatchedCustomers.length,
      unmatchedSample: unmatchedCustomers.slice(0, 10),
    });

    // Log each matched channel for visibility
    for (const ch of matchedChannels) {
      logger.info("Matched channel", {
        channel: ch.channelName,
        channelId: ch.channelId,
        asanaTask: ch.matchedAsanaTask,
        isExtShared: ch.is_ext_shared,
      });
    }

    if (unmatchedCustomers.length > 0) {
      logger.warn("Customers with no Slack channel found", {
        customers: unmatchedCustomers,
      });
    }

    return {
      matchedChannels,
      unmatchedCustomers,
      totalAsanaTasks: uniqueNames.length,
      totalSlackChannels: allChannels.length,
    };
  },
});

// ─── Scheduled Task: 4am EST every day ───────────────────────────────────────

const SA_ASANA_PROJECT_GID = "1213223139200704";

export const scheduledChannelDiscovery = schedules.task({
  id: "scheduled-channel-discovery",
  cron: { pattern: "0 4 * * *", timezone: "America/New_York" },
  run: async () => {
    logger.info("Running scheduled channel discovery");

    const result = await channelDiscovery.triggerAndWait({
      asanaProjectGid: SA_ASANA_PROJECT_GID,
    });

    if (result.ok) {
      logger.info("Scheduled channel discovery completed", {
        matched: result.output.matchedChannels.length,
        unmatched: result.output.unmatchedCustomers.length,
      });
    } else {
      logger.error("Scheduled channel discovery failed", { error: result.error });
    }
  },
});
