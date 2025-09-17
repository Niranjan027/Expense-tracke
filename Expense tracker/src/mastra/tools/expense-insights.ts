import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";

const getDbPool = () => {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
};

export const expenseInsightsTool = createTool({
  id: "expense-insights-tool",
  description: `Generate comprehensive financial insights and summaries with AI-powered analysis for Indian spending patterns. Provides personalized financial advice and spending recommendations.`,
  inputSchema: z.object({
    userId: z.number().describe("User ID to generate insights for"),
    analysisType: z.enum(["monthly", "weekly", "yearly", "custom"]).default("monthly").describe("Type of analysis period"),
    startDate: z.string().optional().describe("Start date for custom analysis (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("End date for custom analysis (YYYY-MM-DD)"),
    includeComparison: z.boolean().default(true).describe("Include comparison with previous period"),
    includeAdvice: z.boolean().default(true).describe("Include AI-powered financial advice"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    insights: z.object({
      period: z.string(),
      totalIncome: z.number(),
      totalExpenses: z.number(),
      netSavings: z.number(),
      savingsRate: z.number(),
      topExpenseCategories: z.array(z.object({
        category: z.string(),
        amount: z.number(),
        percentage: z.number(),
        count: z.number(),
      })),
      spendingTrends: z.array(z.object({
        date: z.string(),
        amount: z.number(),
      })),
      paymentMethodBreakdown: z.array(z.object({
        method: z.string(),
        amount: z.number(),
        count: z.number(),
      })),
      comparison: z.object({
        previousPeriod: z.string(),
        incomeChange: z.number(),
        expenseChange: z.number(),
        savingsChange: z.number(),
      }).optional(),
    }),
    recommendations: z.array(z.string()),
    financialHealth: z.object({
      score: z.number(),
      status: z.string(),
      areas: z.array(z.string()),
    }),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const { userId, analysisType, startDate, endDate, includeComparison, includeAdvice } = context;
    
    logger?.info('📈 [ExpenseInsights] Starting financial analysis', { 
      userId, 
      analysisType,
      startDate,
      endDate,
      includeComparison,
      includeAdvice
    });

    try {
      const pool = getDbPool();
      
      // Determine analysis period
      let currentStartDate: string;
      let currentEndDate: string;
      let previousStartDate: string;
      let previousEndDate: string;

      const today = new Date();
      
      if (analysisType === 'monthly') {
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        currentStartDate = firstDayOfMonth.toISOString().split('T')[0];
        currentEndDate = lastDayOfMonth.toISOString().split('T')[0];
        
        // Previous month
        const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
        previousStartDate = prevMonth.toISOString().split('T')[0];
        previousEndDate = prevMonthEnd.toISOString().split('T')[0];
      } else if (analysisType === 'weekly') {
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        currentStartDate = weekStart.toISOString().split('T')[0];
        currentEndDate = weekEnd.toISOString().split('T')[0];
        
        // Previous week
        const prevWeekStart = new Date(weekStart);
        prevWeekStart.setDate(weekStart.getDate() - 7);
        const prevWeekEnd = new Date(weekEnd);
        prevWeekEnd.setDate(weekEnd.getDate() - 7);
        previousStartDate = prevWeekStart.toISOString().split('T')[0];
        previousEndDate = prevWeekEnd.toISOString().split('T')[0];
      } else if (analysisType === 'yearly') {
        currentStartDate = `${today.getFullYear()}-01-01`;
        currentEndDate = `${today.getFullYear()}-12-31`;
        previousStartDate = `${today.getFullYear() - 1}-01-01`;
        previousEndDate = `${today.getFullYear() - 1}-12-31`;
      } else {
        currentStartDate = startDate || today.toISOString().split('T')[0];
        currentEndDate = endDate || today.toISOString().split('T')[0];
        
        // Calculate previous period of same length
        const daysDiff = Math.floor((new Date(currentEndDate).getTime() - new Date(currentStartDate).getTime()) / (1000 * 60 * 60 * 24));
        const prevEnd = new Date(currentStartDate);
        prevEnd.setDate(prevEnd.getDate() - 1);
        const prevStart = new Date(prevEnd);
        prevStart.setDate(prevEnd.getDate() - daysDiff);
        previousStartDate = prevStart.toISOString().split('T')[0];
        previousEndDate = prevEnd.toISOString().split('T')[0];
      }

      // Get current period data
      const currentData = await getFinancialData(pool, userId, currentStartDate, currentEndDate);
      
      // Get previous period data for comparison
      let comparisonData = null;
      if (includeComparison) {
        comparisonData = await getFinancialData(pool, userId, previousStartDate, previousEndDate);
      }

      await pool.end();

      // Generate AI-powered recommendations
      let recommendations: string[] = [];
      if (includeAdvice) {
        recommendations = await generateAIRecommendations(mastra, currentData, comparisonData);
      }

      // Calculate financial health score
      const financialHealth = calculateFinancialHealth(currentData);

      logger?.info('✅ [ExpenseInsights] Successfully generated insights');

      return {
        success: true,
        insights: {
          period: `${currentStartDate} to ${currentEndDate}`,
          totalIncome: currentData.totalIncome,
          totalExpenses: currentData.totalExpenses,
          netSavings: currentData.totalIncome - currentData.totalExpenses,
          savingsRate: currentData.totalIncome > 0 ? 
            ((currentData.totalIncome - currentData.totalExpenses) / currentData.totalIncome) * 100 : 0,
          topExpenseCategories: currentData.categoryBreakdown,
          spendingTrends: currentData.dailyTrends,
          paymentMethodBreakdown: currentData.paymentMethods,
          comparison: comparisonData ? {
            previousPeriod: `${previousStartDate} to ${previousEndDate}`,
            incomeChange: ((currentData.totalIncome - comparisonData.totalIncome) / Math.max(comparisonData.totalIncome, 1)) * 100,
            expenseChange: ((currentData.totalExpenses - comparisonData.totalExpenses) / Math.max(comparisonData.totalExpenses, 1)) * 100,
            savingsChange: ((currentData.totalIncome - currentData.totalExpenses) - 
                           (comparisonData.totalIncome - comparisonData.totalExpenses)),
          } : undefined,
        },
        recommendations,
        financialHealth,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger?.error('❌ [ExpenseInsights] Error generating insights', { error: errorMessage });
      
      return {
        success: false,
        insights: {
          period: '',
          totalIncome: 0,
          totalExpenses: 0,
          netSavings: 0,
          savingsRate: 0,
          topExpenseCategories: [],
          spendingTrends: [],
          paymentMethodBreakdown: [],
        },
        recommendations: [`Failed to generate insights: ${errorMessage}`],
        financialHealth: {
          score: 0,
          status: 'Error',
          areas: ['Unable to calculate'],
        },
      };
    }
  },
});

async function getFinancialData(pool: Pool, userId: number, startDate: string, endDate: string) {
  // Get totals by transaction type
  const totalsResult = await pool.query(`
    SELECT 
      transaction_type,
      SUM(amount) as total
    FROM expenses 
    WHERE user_id = $1 AND transaction_date BETWEEN $2 AND $3
    GROUP BY transaction_type
  `, [userId, startDate, endDate]);

  let totalIncome = 0;
  let totalExpenses = 0;
  totalsResult.rows.forEach(row => {
    if (row.transaction_type === 'income') {
      totalIncome = parseFloat(row.total);
    } else if (row.transaction_type === 'expense') {
      totalExpenses = parseFloat(row.total);
    }
  });

  // Get category breakdown
  const categoryResult = await pool.query(`
    SELECT 
      ec.name as category,
      SUM(e.amount) as amount,
      COUNT(*) as count
    FROM expenses e
    LEFT JOIN expense_categories ec ON e.category_id = ec.id
    WHERE e.user_id = $1 AND e.transaction_date BETWEEN $2 AND $3 AND e.transaction_type = 'expense'
    GROUP BY ec.name
    ORDER BY amount DESC
  `, [userId, startDate, endDate]);

  const categoryBreakdown = categoryResult.rows.map(row => ({
    category: row.category,
    amount: parseFloat(row.amount),
    percentage: totalExpenses > 0 ? (parseFloat(row.amount) / totalExpenses) * 100 : 0,
    count: parseInt(row.count),
  }));

  // Get daily spending trends
  const trendsResult = await pool.query(`
    SELECT 
      transaction_date::text as date,
      SUM(amount) as amount
    FROM expenses 
    WHERE user_id = $1 AND transaction_date BETWEEN $2 AND $3 AND transaction_type = 'expense'
    GROUP BY transaction_date
    ORDER BY transaction_date
  `, [userId, startDate, endDate]);

  const dailyTrends = trendsResult.rows.map(row => ({
    date: row.date,
    amount: parseFloat(row.amount),
  }));

  // Get payment method breakdown
  const paymentResult = await pool.query(`
    SELECT 
      COALESCE(payment_method, 'Not specified') as method,
      SUM(amount) as amount,
      COUNT(*) as count
    FROM expenses 
    WHERE user_id = $1 AND transaction_date BETWEEN $2 AND $3
    GROUP BY payment_method
    ORDER BY amount DESC
  `, [userId, startDate, endDate]);

  const paymentMethods = paymentResult.rows.map(row => ({
    method: row.method,
    amount: parseFloat(row.amount),
    count: parseInt(row.count),
  }));

  return {
    totalIncome,
    totalExpenses,
    categoryBreakdown,
    dailyTrends,
    paymentMethods,
  };
}

async function generateAIRecommendations(mastra: any, currentData: any, comparisonData: any): Promise<string[]> {
  try {
    const agent = mastra?.getAgent('expenseAgent');
    if (!agent) return [];

    const prompt = `Based on this Indian user's financial data, provide 3-5 specific, actionable recommendations:

Current Period:
- Income: ₹${currentData.totalIncome.toLocaleString('en-IN')}
- Expenses: ₹${currentData.totalExpenses.toLocaleString('en-IN')}
- Net Savings: ₹${(currentData.totalIncome - currentData.totalExpenses).toLocaleString('en-IN')}

Top Expense Categories:
${currentData.categoryBreakdown.slice(0, 5).map((cat: any) => 
  `- ${cat.category}: ₹${cat.amount.toLocaleString('en-IN')} (${cat.percentage.toFixed(1)}%)`
).join('\n')}

${comparisonData ? `
Previous Period Comparison:
- Income Change: ${((currentData.totalIncome - comparisonData.totalIncome) / Math.max(comparisonData.totalIncome, 1) * 100).toFixed(1)}%
- Expense Change: ${((currentData.totalExpenses - comparisonData.totalExpenses) / Math.max(comparisonData.totalExpenses, 1) * 100).toFixed(1)}%
` : ''}

Provide Indian-context financial advice focusing on:
1. Practical savings tips for Indian lifestyle
2. Category-specific recommendations
3. Investment suggestions suitable for India
4. Budget optimization tips

Format as a simple array of recommendation strings.`;

    const result = await agent.generate([
      { role: "user", content: prompt }
    ]);

    // Parse recommendations from AI response
    const recommendations = result.text
      .split('\n')
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => line.replace(/^\d+\.\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter((line: string) => line.length > 10)
      .slice(0, 5);

    return recommendations.length > 0 ? recommendations : [
      "Monitor your top spending categories and set monthly limits",
      "Consider using more UPI payments for better expense tracking",
      "Look for opportunities to reduce food delivery expenses by cooking at home",
    ];
  } catch (error) {
    return [
      "Monitor your spending patterns regularly",
      "Set monthly budgets for each expense category",
      "Consider investing your savings in SIP or mutual funds",
    ];
  }
}

function calculateFinancialHealth(data: any): { score: number; status: string; areas: string[] } {
  let score = 0;
  const areas: string[] = [];
  
  // Savings rate (40% of score)
  const savingsRate = data.totalIncome > 0 ? 
    ((data.totalIncome - data.totalExpenses) / data.totalIncome) * 100 : 0;
  
  if (savingsRate >= 20) score += 40;
  else if (savingsRate >= 10) score += 30;
  else if (savingsRate >= 0) score += 20;
  else score += 0;
  
  if (savingsRate < 20) areas.push("Increase savings rate");
  
  // Expense diversification (30% of score)
  const topCategoryPercentage = data.categoryBreakdown.length > 0 ? 
    data.categoryBreakdown[0].percentage : 0;
  
  if (topCategoryPercentage <= 40) score += 30;
  else if (topCategoryPercentage <= 50) score += 20;
  else score += 10;
  
  if (topCategoryPercentage > 40) areas.push("Diversify spending across categories");
  
  // Regular transaction pattern (30% of score)
  const regularityScore = data.dailyTrends.length >= 7 ? 30 : 20;
  score += regularityScore;
  
  if (data.dailyTrends.length < 7) areas.push("Maintain regular expense tracking");
  
  let status: string;
  if (score >= 80) status = "Excellent";
  else if (score >= 60) status = "Good"; 
  else if (score >= 40) status = "Fair";
  else status = "Needs Improvement";
  
  return { score, status, areas };
}