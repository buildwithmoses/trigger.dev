import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  searchHubSpotCompanies,
  fetchHubSpotCompany,
  fetchHubSpotCompanyDeals,
  fetchClosedDealsByCompanyName,
  fetchRecentlyClosedDeals,
} from "./ai-agent-utils";

export const hubspotTest = schemaTask({
  id: "hubspot-test",
  schema: z.object({
    companyName: z.string().describe("Company name to search for"),
    recentDaysBack: z.number().optional().describe("Also fetch deals closed-won in the last N days (default: 7)"),
  }),
  run: async ({ companyName, recentDaysBack = 7 }) => {
    // Step 1: Search companies by name
    logger.info("Searching HubSpot companies", { companyName });
    const companies = await searchHubSpotCompanies(companyName, 5);
    logger.info("Found companies", {
      count: companies.length,
      companies: companies.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
    });

    if (companies.length === 0) {
      return { error: "no_companies_found", query: companyName };
    }

    // Step 2: Get full details for the top match
    const topMatch = companies[0];
    const company = await fetchHubSpotCompany(topMatch.id);
    logger.info("Company details", { company });

    // Step 3: Get all deals for that company
    const allDeals = await fetchHubSpotCompanyDeals(topMatch.id);
    logger.info("All deals", {
      count: allDeals.length,
      deals: allDeals.map((d) => ({
        name: d.name,
        stage: d.stage,
        amount: d.amount,
        closeDate: d.closeDate,
        dateEnteredClosedWon: d.dateEnteredClosedWon,
        dateEnteredClosedLost: d.dateEnteredClosedLost,
      })),
    });

    // Step 4: Get closed deals via the convenience function
    const closedResult = await fetchClosedDealsByCompanyName(companyName);
    logger.info("Closed deals for company", {
      count: closedResult?.closedDeals.length ?? 0,
      deals: closedResult?.closedDeals.map((d) => ({
        name: d.name,
        stage: d.stage,
        amount: d.amount,
        closedWonAt: d.dateEnteredClosedWon,
      })),
    });

    // Step 5: Get recently closed-won deals across ALL companies
    const recentDeals = await fetchRecentlyClosedDeals(recentDaysBack);
    logger.info("Recently closed-won deals (all companies)", {
      daysBack: recentDaysBack,
      count: recentDeals.length,
      deals: recentDeals.map((d) => ({
        name: d.name,
        amount: d.amount,
        closedWonAt: d.dateEnteredClosedWon,
      })),
    });

    return {
      company,
      totalDeals: allDeals.length,
      allDeals,
      closedDeals: closedResult?.closedDeals ?? [],
      recentlyClosedWon: recentDeals,
    };
  },
});
