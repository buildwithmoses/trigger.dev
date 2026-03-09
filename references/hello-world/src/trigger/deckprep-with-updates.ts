import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  extractFromTranscript,
  getGoogleAccessToken,
  findKickoffDateFromCalendar,
  findKickoffDateFromEmail,
  fetchSlackUsers,
  findSlackPhoto,
  createDriveFolder,
  copyDriveFile,
  batchUpdateSlides,
  findTextRange,
  buildReplacements,
  formatDate,
  TEMPLATE_DECK_ID,
  CUSTOMER_DOCUMENTS_FOLDER_ID,
  SLIDE3_IMAGE_IDS,
  type SlideRequest,
} from "./kickoff-deck-prep";

// --- Step Definitions ---

const STEPS = [
  { num: 1, name: "Extracting client info from Notion", emoji: ":mag:" },
  { num: 2, name: "Authenticating with Google", emoji: ":key:" },
  { num: 3, name: "Validating kickoff date", emoji: ":calendar:" },
  { num: 4, name: "Building replacement map", emoji: ":hammer_and_wrench:" },
  { num: 5, name: "Looking up Slack photos", emoji: ":camera:" },
  { num: 6, name: "Creating Drive folder", emoji: ":file_folder:" },
  { num: 7, name: "Copying template deck", emoji: ":page_facing_up:" },
  { num: 8, name: "Applying text & image replacements", emoji: ":art:" },
  { num: 9, name: "Setting Notion hyperlink", emoji: ":link:" },
];

// --- Slack Helpers ---

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<string> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });

  const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) {
    logger.warn("Failed to post Slack message", { error: data.error });
    throw new Error(`Slack chat.postMessage failed: ${data.error}`);
  }
  return data.ts!;
}

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

function buildStatusText(
  completedUpTo: number,
  currentStep?: number,
  failedStep?: number
): string {
  const lines = STEPS.map((step) => {
    let icon: string;
    if (failedStep === step.num) {
      icon = ":x:";
    } else if (step.num <= completedUpTo) {
      icon = ":white_check_mark:";
    } else if (currentStep === step.num) {
      icon = ":hourglass_flowing_sand:";
    } else {
      icon = ":black_small_square:";
    }
    return `${icon}  ${step.emoji}  ${step.name}`;
  });

  return lines.join("\n");
}

// --- Main Task ---

export const deckprepWithUpdates = schemaTask({
  id: "deckprep-with-updates",
  schema: z.object({
    aeName: z.string().describe("Account Executive name"),
    seName: z.string().describe("SA name"),
    csLead: z.string().describe("SA Team Lead name"),
    kickoffDate: z.string().optional().describe("Override kickoff date (MM/DD/YYYY)"),
    notionContent: z.string().describe("Notion intake page content (client name extracted from this)"),
    slackChannel: z.string().describe("Slack channel ID for status updates"),
    slackThreadTs: z.string().describe("Thread timestamp to post updates in"),
    slackUserId: z.string().describe("Slack user ID who initiated the request"),
  }),
  retry: {
    maxAttempts: 1,
  },
  run: async (payload) => {
    const { slackChannel, slackThreadTs, aeName } = payload;

    // Post initial status message (all steps pending)
    const statusTs = await postSlackMessage(
      slackChannel,
      buildStatusText(0, 1),
      slackThreadTs
    );

    let completedUpTo = 0;
    let accessToken: string;
    let deckId: string;
    let folderId: string;

    try {
      // Step 1: Extract structured data from Notion content
      logger.info("Step 1: Extracting structured data from Notion content...");
      const extractedData = await extractFromTranscript(payload.notionContent);
      // Override AE name with the one selected in the form
      extractedData.aeName = aeName;
      // Clean client name: take only the main name (before parentheses, commas, "and", etc.)
      extractedData.clientName = extractedData.clientName
        .replace(/\s*\(.*\)/, "")      // Remove parenthetical like "(and related brands: ...)"
        .replace(/\s*,.*/, "")          // Remove anything after a comma
        .replace(/\s+and\s+.*/i, "")   // Remove "and ..." suffixes
        .trim();
      const clientName = extractedData.clientName;
      logger.info("Extraction complete", {
        clientName,
        useCases: extractedData.useCases.map((u) => u.name),
        customerTeam: extractedData.customerTeam.length,
      });
      completedUpTo = 1;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(1, 2));

      // Step 2: Authenticate with Google
      logger.info("Step 2: Getting Google OAuth access token...");
      accessToken = await getGoogleAccessToken();
      completedUpTo = 2;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(2, 3));
      logger.info("OAuth token acquired");

      // Step 3: Validate kickoff date
      logger.info("Step 3: Validating kickoff date...");
      if (payload.kickoffDate) {
        extractedData.kickoffDate = payload.kickoffDate;
        logger.info("Using explicit kickoff date override", { date: payload.kickoffDate });
      } else {
        const calendarDate = await findKickoffDateFromCalendar(accessToken, clientName);
        if (calendarDate) {
          extractedData.kickoffDate = calendarDate;
          logger.info("Using kickoff date from Google Calendar", { calendarDate });
        } else {
          const emailDate = await findKickoffDateFromEmail(accessToken, clientName);
          if (emailDate) {
            extractedData.kickoffDate = emailDate;
            logger.info("Using kickoff date from Gmail", { emailDate });
          } else {
            logger.info("No kickoff date found from Calendar/Email");
          }
        }
      }
      completedUpTo = 3;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(3, 4));

      // Step 4: Build replacement map
      logger.info("Step 4: Building replacement map...");
      const notionLink = payload.notionContent || undefined;
      const replacements = buildReplacements(
        extractedData,
        payload.seName,
        payload.csLead,
        notionLink
      );
      completedUpTo = 4;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(4, 5));
      logger.info(`Built ${replacements.length} text replacements`);

      // Step 5: Look up Slack photos
      logger.info("Step 5: Looking up Slack profile photos...");
      const slackUsers = await fetchSlackUsers();
      const aePhoto = findSlackPhoto(slackUsers, aeName);
      const csPhoto = findSlackPhoto(slackUsers, payload.csLead);
      const sePhoto = findSlackPhoto(slackUsers, payload.seName);
      completedUpTo = 5;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(5, 6));
      logger.info("Slack photo lookup complete", {
        aePhoto: !!aePhoto,
        sePhoto: !!sePhoto,
        csPhoto: !!csPhoto,
      });

      // Step 6: Create Drive folder
      logger.info("Step 6: Creating client folder in Google Drive...");
      folderId = await createDriveFolder(
        accessToken,
        clientName,
        CUSTOMER_DOCUMENTS_FOLDER_ID
      );
      completedUpTo = 6;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(6, 7));
      logger.info("Folder created", { folderId });

      // Step 7: Copy template deck
      logger.info("Step 7: Copying template deck...");
      deckId = await copyDriveFile(
        accessToken,
        TEMPLATE_DECK_ID,
        `${clientName} | AirOps Kickoff`,
        folderId
      );
      completedUpTo = 7;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(7, 8));
      logger.info("Deck copied", { deckId });

      // Step 8: Apply text & image replacements
      logger.info("Step 8: Applying text and image replacements...");
      const requests: SlideRequest[] = [];

      for (const { find, replaceWith, pageObjectIds } of replacements) {
        requests.push({
          replaceAllText: {
            containsText: { text: find, matchCase: true },
            replaceText: replaceWith,
            ...(pageObjectIds ? { pageObjectIds } : {}),
          },
        });
      }

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
      completedUpTo = 8;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(8, 9));
      logger.info("All replacements applied");

      // Step 9: Set Notion hyperlink on slide 11
      logger.info("Step 9: Setting Notion hyperlink on slide 11...");
      if (notionLink) {
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
                style: { link: { url: notionLink } },
                fields: "link",
              },
            },
          ]);
          logger.info("Notion hyperlink set on slide 11");
        } else {
          logger.warn("Could not find 'Intake checklist linked here' text on slide 11");
        }
      }
      completedUpTo = 9;
      await updateSlackMessage(slackChannel, statusTs, buildStatusText(9));

      // Post final summary message
      const deckUrl = `https://docs.google.com/presentation/d/${deckId}/edit`;
      const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
      const kickoffDisplay = extractedData.kickoffDate
        ? formatDate(extractedData.kickoffDate) ?? "Not determined"
        : "Not determined";

      await postSlackMessage(
        slackChannel,
        `:white_check_mark: *Kickoff deck ready!*\n\n` +
          `*Client:* ${clientName}\n` +
          `*Kickoff Date:* ${kickoffDisplay}\n` +
          `*Deck:* <${deckUrl}|Open Deck>\n` +
          `*Folder:* <${folderUrl}|Open Folder>\n\n` +
          `cc <@${payload.slackUserId}>`,
        slackThreadTs
      );

      logger.info("Deckprep with updates complete", { deckUrl, folderUrl });

      return {
        deckUrl,
        deckId,
        folderId,
        folderUrl,
        clientName,
      };
    } catch (error) {
      // Update status message with failure indicator
      const failedStep = completedUpTo + 1;
      await updateSlackMessage(
        slackChannel,
        statusTs,
        buildStatusText(completedUpTo, undefined, failedStep)
      );

      // Post error details as a thread reply
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await postSlackMessage(
        slackChannel,
        `:x: *Deck prep failed at step ${failedStep}* (${STEPS[failedStep - 1]?.name || "unknown"}):\n\`\`\`${errorMessage}\`\`\`\n\ncc <@${payload.slackUserId}>`,
        slackThreadTs
      );

      throw error;
    }
  },
});
