import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";

const getDbPool = () => {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
};

export const addExpenseTool = createTool({
  id: "add-expense-tool",
  description: `Add a new expense entry to the database with automatic AI categorization. This tool understands natural language descriptions and Indian contexts.`,
  inputSchema: z.object({
    userId: z.number().describe("User ID for the expense entry"),
    naturalLanguageEntry: z.string().describe("Natural language description of the expense (e.g., 'I spent ₹500 on groceries at Big Bazaar')"),
    amount: z.number().optional().describe("Amount in rupees (will be extracted if not provided)"),
    transactionDate: z.string().optional().describe("Date of transaction in YYYY-MM-DD format (defaults to today)"),
    paymentMethod: z.string().optional().describe("Payment method used (UPI, Cash, Card, Net Banking, etc.)"),
    location: z.string().optional().describe("Location where expense occurred"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    expenseId: z.number().optional(),
    suggestedCategory: z.string().optional(),
    extractedAmount: z.number().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const { userId, naturalLanguageEntry, amount, transactionDate, paymentMethod, location } = context;
    
    logger?.info('💰 [AddExpense] Starting expense processing', { 
      userId, 
      naturalLanguageEntry,
      amount,
      transactionDate,
      paymentMethod,
      location 
    });

    try {
      // Parse natural language entry to extract information
      const extractionPrompt = `Analyze this Indian expense entry and extract structured information:
      "${naturalLanguageEntry}"
      
      Extract and return a JSON response with:
      - amount (number): Amount in rupees
      - description (string): Clean description 
      - category (string): One of these Indian categories: Food & Dining, Transportation, Bills & Utilities, Shopping, Entertainment, Healthcare, Education, Personal Care, Travel & Vacation, Family & Kids, Gifts & Donations, Business, Investment, EMI & Loans, Miscellaneous
      - transactionType (string): "expense" or "income"
      - merchantName (string): Store/merchant name if identifiable
      - confidence (number): Your confidence in categorization (0-1)
      
      Examples:
      "Paid ₹500 for groceries at BigBazaar" → {"amount": 500, "description": "Groceries at BigBazaar", "category": "Food & Dining", "transactionType": "expense", "merchantName": "BigBazaar", "confidence": 0.95}
      "Got salary ₹50000" → {"amount": 50000, "description": "Salary", "category": "Miscellaneous", "transactionType": "income", "merchantName": null, "confidence": 0.9}`;

      let extracted;
      
      try {
        // Use OpenAI to extract expense information
        const extractionResult = await mastra?.getAgent('expenseAgent')?.generate([
          { role: "user", content: extractionPrompt }
        ], {
          output: z.object({
            amount: z.number(),
            description: z.string(),
            category: z.string(),
            transactionType: z.enum(["expense", "income"]),
            merchantName: z.string().nullable(),
            confidence: z.number(),
          }),
        });

        if (!extractionResult?.object) {
          throw new Error("Failed to extract expense information from natural language");
        }

        extracted = extractionResult.object;
      } catch (aiError) {
        const errorMessage = aiError instanceof Error ? aiError.message : 'Unknown AI error';
        logger?.warn('⚠️ [AddExpense] AI extraction failed, using fallback parser', { error: errorMessage });
        
        // Fallback: Simple pattern matching for demo purposes
        extracted = parseExpenseWithFallback(naturalLanguageEntry);
      }
      const finalAmount = amount || extracted.amount;
      const finalDate = transactionDate || new Date().toISOString().split('T')[0];
      
      logger?.info('🤖 [AddExpense] AI extracted information', { extracted });

      // Get category ID from database
      const pool = getDbPool();
      const categoryResult = await pool.query(
        'SELECT id FROM expense_categories WHERE name = $1',
        [extracted.category]
      );

      if (categoryResult.rows.length === 0) {
        throw new Error(`Category not found: ${extracted.category}`);
      }

      const categoryId = categoryResult.rows[0].id;

      // Insert expense into database
      const insertResult = await pool.query(`
        INSERT INTO expenses (
          user_id, amount, currency, description, category_id, 
          transaction_type, payment_method, merchant_name, location, 
          transaction_date, ai_suggested_category, ai_confidence_score
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `, [
        userId,
        finalAmount,
        'INR',
        extracted.description,
        categoryId,
        extracted.transactionType,
        paymentMethod || 'Not specified',
        extracted.merchantName,
        location,
        finalDate,
        true,
        extracted.confidence
      ]);

      const expenseId = insertResult.rows[0].id;
      await pool.end();

      logger?.info('✅ [AddExpense] Successfully added expense', { expenseId });

      return {
        success: true,
        expenseId,
        suggestedCategory: extracted.category,
        extractedAmount: extracted.amount,
        message: `Successfully added ${extracted.transactionType} of ₹${finalAmount} in ${extracted.category} category`
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger?.error('❌ [AddExpense] Error adding expense', { error: errorMessage });
      
      return {
        success: false,
        message: `Failed to add expense: ${errorMessage}`
      };
    }
  },
});

// Fallback parser for when AI is not available
function parseExpenseWithFallback(entry: string) {
  // Simple pattern matching for demo purposes
  const amountMatch = entry.match(/₹(\d+(?:,\d+)*(?:\.\d+)?)/);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 100;
  
  // Determine transaction type
  const incomeKeywords = ['salary', 'income', 'payment received', 'earned', 'bonus'];
  const transactionType = incomeKeywords.some(keyword => 
    entry.toLowerCase().includes(keyword)) ? 'income' : 'expense';
  
  // Simple category mapping
  const categoryMap = {
    'grocery': 'Food & Dining',
    'groceries': 'Food & Dining', 
    'food': 'Food & Dining',
    'restaurant': 'Food & Dining',
    'taxi': 'Transportation',
    'auto': 'Transportation',
    'petrol': 'Transportation',
    'fuel': 'Transportation',
    'bill': 'Bills & Utilities',
    'electricity': 'Bills & Utilities',
    'mobile': 'Bills & Utilities',
    'shopping': 'Shopping',
    'clothes': 'Shopping',
    'movie': 'Entertainment',
    'entertainment': 'Entertainment',
    'doctor': 'Healthcare',
    'medicine': 'Healthcare',
    'school': 'Education',
    'travel': 'Travel & Vacation'
  };
  
  let category = 'Miscellaneous';
  for (const [keyword, cat] of Object.entries(categoryMap)) {
    if (entry.toLowerCase().includes(keyword)) {
      category = cat;
      break;
    }
  }
  
  // Extract merchant name (simple approach)
  const merchantMatch = entry.match(/at\s+([A-Za-z\s]+)/i);
  const merchantName = merchantMatch ? merchantMatch[1].trim() : null;
  
  return {
    amount,
    description: entry.length > 100 ? entry.substring(0, 100) : entry,
    category,
    transactionType,
    merchantName,
    confidence: 0.7 // Lower confidence for fallback parsing
  };
}