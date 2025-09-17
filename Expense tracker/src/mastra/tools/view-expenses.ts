import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";

const getDbPool = () => {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
};

export const viewExpensesTool = createTool({
  id: "view-expenses-tool",
  description: `View and analyze expenses with various filters and Indian spending insights. Shows spending patterns, category breakdowns, and financial summaries.`,
  inputSchema: z.object({
    userId: z.number().describe("User ID to fetch expenses for"),
    startDate: z.string().optional().describe("Start date for filtering (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("End date for filtering (YYYY-MM-DD)"),
    category: z.string().optional().describe("Filter by specific category"),
    transactionType: z.enum(["expense", "income", "all"]).default("all").describe("Filter by transaction type"),
    limit: z.number().default(50).describe("Maximum number of records to return"),
    groupBy: z.enum(["category", "date", "month", "none"]).default("none").describe("Group results by specified field"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    expenses: z.array(z.object({
      id: z.number(),
      amount: z.number(),
      currency: z.string(),
      description: z.string(),
      category: z.string(),
      categoryHindi: z.string().nullable(),
      transactionType: z.string(),
      paymentMethod: z.string().nullable(),
      merchantName: z.string().nullable(),
      location: z.string().nullable(),
      transactionDate: z.string(),
      aiSuggested: z.boolean(),
      aiConfidence: z.number().nullable(),
    })),
    summary: z.object({
      totalExpenses: z.number(),
      totalIncome: z.number(),
      netAmount: z.number(),
      transactionCount: z.number(),
      topCategories: z.array(z.object({
        category: z.string(),
        amount: z.number(),
        count: z.number(),
      })),
    }),
    insights: z.array(z.string()),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const { userId, startDate, endDate, category, transactionType, limit, groupBy } = context;
    
    logger?.info('📊 [ViewExpenses] Starting expense analysis', { 
      userId, 
      startDate,
      endDate,
      category,
      transactionType,
      limit,
      groupBy
    });

    try {
      const pool = getDbPool();

      // Build dynamic WHERE clause
      const conditions = ['e.user_id = $1'];
      const params: any[] = [userId];
      let paramIndex = 2;

      if (startDate) {
        conditions.push(`e.transaction_date >= $${paramIndex}`);
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        conditions.push(`e.transaction_date <= $${paramIndex}`);
        params.push(endDate);
        paramIndex++;
      }

      if (category) {
        conditions.push(`ec.name = $${paramIndex}`);
        params.push(category);
        paramIndex++;
      }

      if (transactionType !== 'all') {
        conditions.push(`e.transaction_type = $${paramIndex}`);
        params.push(transactionType);
        paramIndex++;
      }

      const whereClause = conditions.join(' AND ');

      // Fetch expenses with category information
      const expensesQuery = `
        SELECT 
          e.id, e.amount, e.currency, e.description, 
          ec.name as category, ec.name_hindi as category_hindi,
          e.transaction_type, e.payment_method, e.merchant_name, 
          e.location, e.transaction_date, e.ai_suggested_category as ai_suggested,
          e.ai_confidence_score as ai_confidence
        FROM expenses e
        LEFT JOIN expense_categories ec ON e.category_id = ec.id
        WHERE ${whereClause}
        ORDER BY e.transaction_date DESC, e.created_at DESC
        LIMIT $${paramIndex}
      `;
      params.push(limit);

      const expensesResult = await pool.query(expensesQuery, params);

      // Calculate summary statistics
      const summaryQuery = `
        SELECT 
          SUM(CASE WHEN e.transaction_type = 'expense' THEN e.amount ELSE 0 END) as total_expenses,
          SUM(CASE WHEN e.transaction_type = 'income' THEN e.amount ELSE 0 END) as total_income,
          COUNT(*) as transaction_count
        FROM expenses e
        LEFT JOIN expense_categories ec ON e.category_id = ec.id
        WHERE ${whereClause.replace(`LIMIT $${paramIndex}`, '')}
      `;

      const summaryResult = await pool.query(summaryQuery, params.slice(0, -1));
      const summary = summaryResult.rows[0];

      // Get top categories
      const topCategoriesQuery = `
        SELECT 
          ec.name as category,
          SUM(e.amount) as amount,
          COUNT(*) as count
        FROM expenses e
        LEFT JOIN expense_categories ec ON e.category_id = ec.id
        WHERE ${whereClause.replace(`LIMIT $${paramIndex}`, '')} AND e.transaction_type = 'expense'
        GROUP BY ec.name
        ORDER BY amount DESC
        LIMIT 5
      `;

      const topCategoriesResult = await pool.query(topCategoriesQuery, params.slice(0, -1));

      await pool.end();

      // Generate insights based on spending patterns
      const insights = generateIndianSpendingInsights(expensesResult.rows, summary);

      logger?.info('✅ [ViewExpenses] Successfully retrieved expenses', { 
        recordCount: expensesResult.rows.length 
      });

      return {
        success: true,
        expenses: expensesResult.rows.map(row => ({
          id: row.id,
          amount: parseFloat(row.amount),
          currency: row.currency,
          description: row.description,
          category: row.category,
          categoryHindi: row.category_hindi,
          transactionType: row.transaction_type,
          paymentMethod: row.payment_method,
          merchantName: row.merchant_name,
          location: row.location,
          transactionDate: row.transaction_date.toISOString().split('T')[0],
          aiSuggested: row.ai_suggested,
          aiConfidence: row.ai_confidence ? parseFloat(row.ai_confidence) : null,
        })),
        summary: {
          totalExpenses: parseFloat(summary.total_expenses || '0'),
          totalIncome: parseFloat(summary.total_income || '0'),
          netAmount: parseFloat(summary.total_income || '0') - parseFloat(summary.total_expenses || '0'),
          transactionCount: parseInt(summary.transaction_count || '0'),
          topCategories: topCategoriesResult.rows.map(row => ({
            category: row.category,
            amount: parseFloat(row.amount),
            count: parseInt(row.count),
          })),
        },
        insights,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger?.error('❌ [ViewExpenses] Error retrieving expenses', { error: errorMessage });
      
      return {
        success: false,
        expenses: [],
        summary: {
          totalExpenses: 0,
          totalIncome: 0,
          netAmount: 0,
          transactionCount: 0,
          topCategories: [],
        },
        insights: [`Failed to retrieve expenses: ${errorMessage}`],
      };
    }
  },
});

function generateIndianSpendingInsights(expenses: any[], summary: any): string[] {
  const insights: string[] = [];
  const totalExpenses = parseFloat(summary.total_expenses || '0');
  const totalIncome = parseFloat(summary.total_income || '0');
  
  // Net spending insight
  if (totalIncome > totalExpenses) {
    const savings = totalIncome - totalExpenses;
    const savingsPercent = ((savings / totalIncome) * 100).toFixed(1);
    insights.push(`💰 Great job! You're saving ₹${savings.toLocaleString('en-IN')} (${savingsPercent}% of income)`);
  } else if (totalExpenses > totalIncome) {
    const deficit = totalExpenses - totalIncome;
    insights.push(`⚠️ You're spending ₹${deficit.toLocaleString('en-IN')} more than your income this period`);
  }

  // Category-specific insights
  const categoryTotals: { [key: string]: number } = {};
  expenses.forEach(expense => {
    if (expense.transaction_type === 'expense') {
      categoryTotals[expense.category] = (categoryTotals[expense.category] || 0) + parseFloat(expense.amount);
    }
  });

  // Food spending insight
  const foodSpending = categoryTotals['Food & Dining'] || 0;
  if (foodSpending > totalExpenses * 0.4) {
    insights.push(`🍽️ Food expenses are ${((foodSpending/totalExpenses)*100).toFixed(1)}% of spending. Consider home cooking to save money`);
  }

  // Transportation insight
  const transportSpending = categoryTotals['Transportation'] || 0;
  if (transportSpending > totalExpenses * 0.3) {
    insights.push(`🚗 Transportation costs are high (${((transportSpending/totalExpenses)*100).toFixed(1)}%). Consider shared rides or public transport`);
  }

  // UPI usage insight
  const upiTransactions = expenses.filter(e => e.payment_method?.toLowerCase().includes('upi')).length;
  const totalTransactions = expenses.length;
  if (upiTransactions > totalTransactions * 0.7) {
    insights.push(`📱 You're using UPI for ${((upiTransactions/totalTransactions)*100).toFixed(1)}% of transactions - very digital!`);
  }

  // Spending frequency insight
  if (expenses.length > 20) {
    insights.push(`📊 You have ${expenses.length} transactions this period - quite active spending`);
  }

  return insights;
}