import { createWorkflow, createStep } from "../inngest";
import { z } from "zod";
import { RuntimeContext } from "@mastra/core/di";

const runtimeContext = new RuntimeContext();

const generateExpenseReportStep = createStep({
  id: "generate-expense-report",
  description: "Generate periodic expense reports and insights for users",
  inputSchema: z.object({
    // Default user configuration for testing - in real scenario this would be all users
    defaultUserId: z.number().default(1).describe("Default user ID to generate reports for"),
    reportType: z.enum(["weekly", "monthly"]).default("weekly").describe("Type of expense report to generate"),
    includeInsights: z.boolean().default(true).describe("Whether to include AI-powered insights"),
    includeComparison: z.boolean().default(true).describe("Whether to include comparison with previous period"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reportsGenerated: z.number(),
    summary: z.string(),
    insights: z.array(z.string()),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    const { defaultUserId, reportType, includeInsights, includeComparison } = inputData;
    
    logger?.info('📊 [ExpenseReport] Starting periodic expense report generation', { 
      defaultUserId,
      reportType,
      includeInsights,
      includeComparison
    });

    try {
      // In a real application, you would fetch all active users
      // For this demo, we'll generate report for the default user
      const userIds = [defaultUserId];
      let reportsGenerated = 0;
      let allInsights: string[] = [];

      for (const userId of userIds) {
        logger?.info('💰 [ExpenseReport] Generating report for user', { userId });

        // Generate expense insights using our tool directly
        const { expenseInsightsTool } = await import('../tools/expense-insights');
        
        const insightsResult = await expenseInsightsTool.execute({
          context: {
            userId,
            analysisType: reportType === 'weekly' ? 'weekly' : 'monthly',
            includeComparison,
            includeAdvice: includeInsights,
          },
          runtimeContext,
          mastra,
          tracingContext: {},
        });

        if (insightsResult.success) {
          reportsGenerated++;
          
          // Collect insights for summary
          allInsights.push(...insightsResult.recommendations);
          
          // Log the report summary
          logger?.info('📈 [ExpenseReport] Generated report for user', {
            userId,
            totalExpenses: insightsResult.insights.totalExpenses,
            totalIncome: insightsResult.insights.totalIncome,
            netSavings: insightsResult.insights.netSavings,
            financialHealth: insightsResult.financialHealth.status,
          });

          // In a real application, you might:
          // 1. Send email reports to users
          // 2. Push notifications about spending insights
          // 3. Store report data for later viewing
          // 4. Trigger alerts for unusual spending patterns
          
        } else {
          logger?.error('❌ [ExpenseReport] Failed to generate report for user', { userId });
        }
      }

      const summary = `Generated ${reportsGenerated} ${reportType} expense reports. ` +
                     `Key insights include spending optimization, category analysis, and financial health assessment.`;

      logger?.info('✅ [ExpenseReport] Completed periodic expense report generation', {
        reportsGenerated,
        totalInsights: allInsights.length
      });

      return {
        success: true,
        reportsGenerated,
        summary,
        insights: allInsights.slice(0, 10), // Limit to top 10 insights
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger?.error('❌ [ExpenseReport] Error generating expense reports', { error: errorMessage });
      
      return {
        success: false,
        reportsGenerated: 0,
        summary: `Failed to generate expense reports: ${errorMessage}`,
        insights: [],
      };
    }
  },
});

export const expenseReportWorkflow = createWorkflow({
  id: "expense-report-workflow",
  description: "Automated workflow to generate periodic expense reports and insights with Indian financial context",
  inputSchema: z.object({}), // Empty for time-based workflows
  outputSchema: z.object({
    success: z.boolean(),
    reportsGenerated: z.number(),
    summary: z.string(),
  }),
})
  .then(generateExpenseReportStep)
  .commit();