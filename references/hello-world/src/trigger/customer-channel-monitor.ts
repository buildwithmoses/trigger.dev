import { schemaTask, schedules, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { callLLMJson, postSlackMessage } from "./ai-agent-utils";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_RECIPIENT = "U020AFWH6DP"; // Slack user ID to DM for scheduled runs

function slackUserToken(): string {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error("SLACK_USER_TOKEN environment variable is not set");
  return token;
}

function slackBotToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN environment variable is not set");
  return token;
}

// ─── Slack API Helpers ───────────────────────────────────────────────────────

async function slackApi<T = any>(method: string, params?: Record<string, unknown>, useBot = false): Promise<T> {
  const token = useBot ? slackBotToken() : slackUserToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params ?? {}),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
      logger.warn("Slack rate limited, waiting", { method, retryAfter, attempt });
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    const data = (await res.json()) as T & { ok: boolean; error?: string };

    if (!data.ok && data.error === "ratelimited") {
      logger.warn("Slack rate limited (body), waiting", { method, attempt });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    if (!data.ok) {
      throw new Error(`Slack ${method} error: ${data.error}`);
    }
    return data;
  }
  throw new Error(`Slack ${method}: rate limited after 5 retries`);
}

interface SlackChannel {
  id: string;
  name: string;
  is_ext_shared: boolean;
}

const CONNECT_CHANNELS: SlackChannel[] = [
  { id: "C0A89JT6JV7", name: "airops-betterhelp", is_ext_shared: true },
  { id: "C0AA6CPCN0K", name: "airops-zenbusiness", is_ext_shared: true },
  { id: "C0ACJ4XD9PV", name: "distrokid-airops", is_ext_shared: true },
  { id: "C0AF8U072S3", name: "external-autods-airops", is_ext_shared: true },
];

async function listSlackConnectChannels(): Promise<SlackChannel[]> {
  return CONNECT_CHANNELS;
}

interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
}

async function fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
  // conversations.replies works better with URL params
  const params = new URLSearchParams({
    channel: channelId,
    ts: threadTs,
    limit: "50",
  });
  const res = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
    headers: { Authorization: `Bearer ${slackUserToken()}` },
  });
  const data = (await res.json()) as { ok: boolean; messages?: SlackMessage[]; error?: string };
  if (!data.ok) {
    logger.warn("conversations.replies failed", { channelId, threadTs, error: data.error });
    return [];
  }
  // First message is the parent, skip it
  return (data.messages || []).slice(1);
}

interface ThreadedMessage {
  message: SlackMessage;
  replies: SlackMessage[];
}

async function fetchChannelHistory(channelId: string, limit = 50): Promise<ThreadedMessage[]> {
  const data = await slackApi<{ messages: SlackMessage[] }>("conversations.history", {
    channel: channelId,
    limit,
  });
  const topMessages = data.messages || [];

  const threads: ThreadedMessage[] = [];
  for (const msg of topMessages) {
    let replies: SlackMessage[] = [];
    if (msg.reply_count && msg.reply_count > 0) {
      try {
        logger.info("Fetching thread replies", { channelId, ts: msg.ts, reply_count: msg.reply_count });
        replies = await fetchThreadReplies(channelId, msg.ts);
        logger.info("Got thread replies", { channelId, ts: msg.ts, replyCount: replies.length });
      } catch (err) {
        logger.warn("Failed to fetch thread replies", { channelId, ts: msg.ts, error: String(err) });
      }
    }
    threads.push({ message: msg, replies });
  }

  return threads;
}

interface SlackUser {
  id: string;
  real_name?: string;
  team_id: string;
  is_bot: boolean;
}

async function getUserInfo(
  userId: string,
  cache: Map<string, SlackUser>
): Promise<SlackUser | null> {
  if (cache.has(userId)) return cache.get(userId)!;

  // Try user token (has broader access for Slack Connect)
  try {
    const data = await slackApi<{ user: SlackUser }>("users.info", { user: userId }, false);
    cache.set(userId, data.user);
    return data.user;
  } catch {
    // Ignore — will try bot token
  }

  // Try bot token
  try {
    const data = await slackApi<{ user: SlackUser }>("users.info", { user: userId }, true);
    cache.set(userId, data.user);
    return data.user;
  } catch {
    // Both failed — cache as unknown external user so we don't retry
    const fallback: SlackUser = {
      id: userId,
      real_name: `External User (${userId.slice(-4)})`,
      team_id: "external",
      is_bot: false,
    };
    cache.set(userId, fallback);
    return fallback;
  }
}

async function getOwnTeamId(): Promise<string> {
  const data = await slackApi<{ team_id: string }>("auth.test", undefined, true);
  return data.team_id;
}

// ─── LLM Classification ─────────────────────────────────────────────────────

const ChannelStatusSchema = z.object({
  status: z.enum([
    "needs_attention",
    "waiting_on_us",
    "waiting_on_customer",
    "healthy",
    "inactive",
  ]),
  urgency: z.enum(["high", "medium", "low"]),
  summary: z.string(),
  lastCustomerMessage: z.string(),
  hoursSinceTeamReply: z.number(),
  recommendation: z.string(),
});

type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

const CLASSIFICATION_PROMPT = `You are an account health analyst for a B2B SaaS company.

You will receive a conversation from a Slack Connect channel between our team and a customer.
Each message is labeled [TEAM], [CUSTOMER], or [BOT].
Thread replies are indented with ↳ under their parent message.

CRITICAL RULES — read these carefully before classifying:

1. CHECK WHO SENT THE LAST MESSAGE. If [TEAM] sent the last message (including in threads), the channel is almost certainly NOT "waiting_on_us" or "needs_attention".

2. NOT EVERY CUSTOMER MESSAGE NEEDS A RESPONSE. These do NOT require a team reply:
   - Status updates ("Version 15 is now published", "I'm debugging X")
   - FYI messages ("Here's the updated link")
   - Acknowledgments ("great, thank you", "sounds good")
   - The customer working on their side and sharing progress
   Only flag if the customer asked a DIRECT QUESTION or made a CLEAR REQUEST that has no team response.

3. CHECK THREAD REPLIES BEFORE FLAGGING. A top-level message may look unanswered, but if there are thread replies (↳) showing our team responded, that counts as answered.

4. ACTIVE BACK-AND-FORTH = HEALTHY. If both sides are exchanging messages within the same day with reasonable response times, that is "healthy" — even if the most recent message is from the customer.

5. DEFAULT TO "healthy" WHEN IN DOUBT. Only flag "needs_attention" or "waiting_on_us" when there is a CLEAR, UNAMBIGUOUS unanswered question or request from the customer with no team response for 24+ hours.

Status definitions:
- "needs_attention" — customer asked a direct question or raised an issue and there is NO team response anywhere (not in threads, not in follow-up messages). Must be 24+ hours without response.
- "waiting_on_us" — customer explicitly asked us to do something or follow up, and we have not yet done it. Must be a clear action item, not just a customer FYI message.
- "waiting_on_customer" — we asked the customer something or are waiting for them to take an action
- "healthy" — active conversation, both sides responsive, or conversation is naturally concluded. USE THIS when the last exchange was a normal back-and-forth that reached a natural stopping point.
- "inactive" — no meaningful messages in the last 7+ days

Urgency:
- "high" — customer explicitly says they are blocked, frustrated, or escalating. NOT just because they sent a message.
- "medium" — clear unanswered question from customer, 24-48 hours old
- "low" — everything looks normal, or channel is inactive

Return JSON with these exact fields:
- status: one of the status values above
- urgency: "high" | "medium" | "low"
- summary: 1-2 sentence summary of the channel state
- lastCustomerMessage: the most recent customer message (truncated to 100 chars)
- hoursSinceTeamReply: approximate hours since our last team reply (0 if team replied last)
- recommendation: a specific action recommendation for our team (if healthy, say "No action needed")

Return ONLY valid JSON, no markdown code fences.`;

// ─── Message Labeling ────────────────────────────────────────────────────────

function labelMessage(
  msg: SlackMessage,
  user: SlackUser | null,
  ownTeamId: string
): string {
  if (msg.bot_id || msg.subtype === "bot_message") return "BOT";
  if (!user) return "UNKNOWN";
  if (user.is_bot) return "BOT";
  return user.team_id === ownTeamId ? "TEAM" : "CUSTOMER";
}

function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// ─── Summary Builder (Slack Block Kit) ───────────────────────────────────────

interface ChannelResult {
  channelId: string;
  channelName: string;
  analysis: ChannelStatus;
}

interface SkippedChannel {
  channelName: string;
  reason: string;
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    needs_attention: ":red_circle:",
    waiting_on_us: ":large_orange_circle:",
    waiting_on_customer: ":large_yellow_circle:",
    healthy: ":large_green_circle:",
    inactive: ":white_circle:",
  };
  return map[status] || ":grey_question:";
}

function urgencyEmoji(urgency: string): string {
  const map: Record<string, string> = {
    high: ":rotating_light:",
    medium: ":warning:",
    low: ":white_circle:",
  };
  return map[urgency] || "";
}

function buildReportBlocks(
  results: ChannelResult[],
  skipped: SkippedChannel[]
): { text: string; blocks: unknown[] } {
  const counts: Record<string, number> = {
    needs_attention: 0,
    waiting_on_us: 0,
    waiting_on_customer: 0,
    healthy: 0,
    inactive: 0,
  };

  for (const r of results) {
    counts[r.analysis.status] = (counts[r.analysis.status] || 0) + 1;
  }

  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Customer Channel Health Report" },
  });

  // Overview
  const overviewLines = [
    `${statusEmoji("needs_attention")} Needs Attention: *${counts.needs_attention}*`,
    `${statusEmoji("waiting_on_us")} Waiting on Us: *${counts.waiting_on_us}*`,
    `${statusEmoji("waiting_on_customer")} Waiting on Customer: *${counts.waiting_on_customer}*`,
    `${statusEmoji("healthy")} Healthy: *${counts.healthy}*`,
    `${statusEmoji("inactive")} Inactive: *${counts.inactive}*`,
  ];

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: overviewLines.join("  |  ") },
  });

  blocks.push({ type: "divider" });

  // Detail sections for channels that need action
  const actionable = results.filter(
    (r) => r.analysis.status === "needs_attention" || r.analysis.status === "waiting_on_us"
  );

  if (actionable.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Channels Requiring Action:*" },
    });

    for (const ch of actionable) {
      const a = ch.analysis;
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `${statusEmoji(a.status)} ${urgencyEmoji(a.urgency)} *<#${ch.channelId}>*`,
            `> ${a.summary}`,
            `*Last customer message:* ${truncate(a.lastCustomerMessage, 100)}`,
            `*Hours since team reply:* ${a.hoursSinceTeamReply}`,
            `*Recommendation:* ${a.recommendation}`,
          ].join("\n"),
        },
      });

      blocks.push({ type: "divider" });
    }
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ":tada: All channels look good — no immediate action needed." },
    });
  }

  // Skipped channels note
  if (skipped.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:warning: Skipped ${skipped.length} channel(s): ${skipped.map((s) => s.channelName).join(", ")}`,
        },
      ],
    });
  }

  // Footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Channel Monitor | ${results.length} channels analyzed | ${new Date().toISOString()}`,
      },
    ],
  });

  const text = `Customer Channel Health Report — ${counts.needs_attention} need attention, ${counts.waiting_on_us} waiting on us, ${results.length} total`;

  return { text, blocks };
}

// ─── Main Task ───────────────────────────────────────────────────────────────

export const customerChannelMonitor = schemaTask({
  id: "customer-channel-monitor",
  schema: z.object({
    requestedBy: z.string().describe("Slack user ID to DM the report to"),
  }),
  retry: { maxAttempts: 2 },
  run: async (payload) => {
    const { requestedBy } = payload;

    logger.info("Starting customer channel monitor", { requestedBy });

    // Get our team ID for internal vs external detection
    const ownTeamId = await getOwnTeamId();
    logger.info("Resolved own team ID", { ownTeamId });

    // List Slack Connect channels
    const channels = await listSlackConnectChannels();
    logger.info("Found Slack Connect channels", { count: channels.length });

    if (channels.length === 0) {
      await postSlackMessage(
        requestedBy,
        "No Slack Connect channels found. Make sure the bot is invited to your shared channels."
      );
      return { channelsAnalyzed: 0, results: [] };
    }

    const userCache = new Map<string, SlackUser>();
    const results: ChannelResult[] = [];
    const skipped: SkippedChannel[] = [];

    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];

      // Small delay every 30 channels to respect rate limits
      if (i > 0 && i % 30 === 0) {
        logger.info("Pausing for rate limits", { processed: i, total: channels.length });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      try {
        logger.info("Analyzing channel", { channel: ch.name, index: i + 1, total: channels.length });

        const threads = await fetchChannelHistory(ch.id, 50);

        if (threads.length === 0) {
          results.push({
            channelId: ch.id,
            channelName: ch.name,
            analysis: {
              status: "inactive",
              urgency: "low",
              summary: "No recent messages in this channel.",
              lastCustomerMessage: "",
              hoursSinceTeamReply: 0,
              recommendation: "Check if this channel is still active.",
            },
          });
          continue;
        }

        // Format messages with thread hierarchy (oldest first)
        const labeledMessages: string[] = [];

        async function formatMsg(msg: SlackMessage, indent = ""): Promise<string> {
          if (!msg.user && !msg.bot_id) return "";
          const user = msg.user ? await getUserInfo(msg.user, userCache) : null;
          const label = labelMessage(msg, user, ownTeamId);
          const name = user?.real_name || msg.user || "bot";
          const text = truncate(msg.text || "", 500);
          const time = new Date(parseFloat(msg.ts) * 1000).toISOString();
          return `${indent}[${label}] ${name} (${time}): ${text}`;
        }

        // Process oldest first
        for (const thread of [...threads].reverse()) {
          const parentLine = await formatMsg(thread.message);
          if (parentLine) labeledMessages.push(parentLine);

          if (thread.replies.length > 0) {
            for (const reply of thread.replies) {
              const replyLine = await formatMsg(reply, "  ↳ ");
              if (replyLine) labeledMessages.push(replyLine);
            }
          }
        }

        const conversationText = labeledMessages.join("\n");

        logger.info("Conversation text for LLM", {
          channel: ch.name,
          totalThreads: threads.length,
          threadsWithReplies: threads.filter((t) => t.replies.length > 0).length,
          totalMessages: labeledMessages.length,
          preview: conversationText.slice(0, 2000),
        });

        // Determine who sent the last message (including thread replies)
        const lastLine = labeledMessages[labeledMessages.length - 1] || "";
        const lastSender = lastLine.includes("[TEAM]")
          ? "TEAM"
          : lastLine.includes("[CUSTOMER]")
            ? "CUSTOMER"
            : "UNKNOWN";

        // Classify with LLM
        const analysis = await callLLMJson(
          CLASSIFICATION_PROMPT,
          `Channel: #${ch.name}\nLast message sender: ${lastSender}\nTotal messages: ${labeledMessages.length}\n\nMessages (oldest first, thread replies indented with ↳):\n${conversationText}`,
          ChannelStatusSchema,
          { model: "google/gemini-2.5-flash" }
        );

        results.push({
          channelId: ch.id,
          channelName: ch.name,
          analysis,
        });

        logger.info("Channel analyzed", {
          channel: ch.name,
          status: analysis.status,
          urgency: analysis.urgency,
        });
      } catch (err) {
        logger.error("Failed to analyze channel", { channel: ch.name, error: String(err) });
        skipped.push({ channelName: ch.name, reason: String(err) });
      }
    }

    // Build and send the report
    const { text, blocks } = buildReportBlocks(results, skipped);
    await postSlackMessage(requestedBy, text, blocks);

    logger.info("Report sent", {
      recipient: requestedBy,
      totalChannels: channels.length,
      analyzed: results.length,
      skipped: skipped.length,
    });

    return {
      channelsAnalyzed: results.length,
      skipped: skipped.length,
      skippedDetails: skipped.slice(0, 5).map((s) => ({ channel: s.channelName, reason: s.reason })),
      results: results.map((r) => ({
        channel: r.channelName,
        status: r.analysis.status,
        urgency: r.analysis.urgency,
      })),
    };
  },
});

// ─── Scheduled Task ──────────────────────────────────────────────────────────

export const scheduledChannelMonitor = schedules.task({
  id: "scheduled-channel-monitor",
  cron: { pattern: "0 16 * * 5", timezone: "America/New_York" },
  run: async () => {
    logger.info("Running scheduled channel monitor");

    const result = await customerChannelMonitor.triggerAndWait({
      requestedBy: DEFAULT_RECIPIENT,
    });

    if (result.ok) {
      logger.info("Scheduled monitor completed", { output: result.output });
    } else {
      logger.error("Scheduled monitor failed", { error: result.error });
    }
  },
});
