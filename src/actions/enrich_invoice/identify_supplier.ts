import { debug } from '@pga/logger';
import { executeWorkdayQuery, type WorkdayConfig } from '../../lib/workday.js';
import { callOpenAIWithSchema } from '../../lib/openai.js';

export interface SupplierIdentificationResult {
  supplierId: string;
  supplierName: string;
  confidence: number;
  reasoning: string;
}

export async function identifySupplier(
  config: WorkdayConfig,
  invoice: any,
  attachmentData: any[]
): Promise<SupplierIdentificationResult> {
  debug('Identifying supplier for invoice:', invoice.invoiceNumber);
  
  // Get all registered suppliers from Workday
  const suppliersQuery = `
    SELECT 
      id,
      name,
      legalName,
      taxId,
      status
    FROM supplier
    WHERE status = "Active"
    ORDER BY name
  `;
  
  const suppliers = await executeWorkdayQuery(config, suppliersQuery);
  
  // Prepare AI request for supplier identification
  const systemPrompt = `You are a supplier identification specialist. Given an invoice and a list of registered suppliers, identify which supplier this invoice belongs to. If no match is found, respond with "None" and provide your reasoning.`;
  
  const userMessage = `Please identify the supplier for this invoice:
Invoice Number: ${invoice.invoiceNumber}
Invoice Data: ${JSON.stringify(invoice, null, 2)}
Attachments: ${JSON.stringify(attachmentData)}

Available Suppliers:
${suppliers.map(s => `${s.name} (ID: ${s.id})`).join('\n')}`;

  const schema = {
    type: 'object',
    properties: {
      supplierId: { type: 'string', description: 'Workday supplier ID if found' },
      supplierName: { type: 'string', description: 'Supplier name if found' },
      confidence: { type: 'number', description: 'Confidence level 0-1' },
      reasoning: { type: 'string', description: 'Explanation of the identification' }
    },
    required: ['supplierId', 'supplierName', 'confidence', 'reasoning']
  };

  const result = await callOpenAIWithSchema({
    prompt: systemPrompt,
    schema,
    messages: [{ role: 'user', content: userMessage }]
  });

  debug('Supplier identification result:', JSON.stringify(result, null, 2));
  
  return result as SupplierIdentificationResult;
}
