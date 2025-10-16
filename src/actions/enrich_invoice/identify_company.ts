import { debug } from '@pga/logger';
import { executeWorkdayQuery, type WorkdayConfig } from '../../lib/workday.js';
import { callOpenAIWithSchema } from '../../lib/openai.js';

export interface CompanyIdentificationResult {
  companyId: string;
  companyName: string;
  confidence: number;
  reasoning: string;
}

export async function identifyCompany(
  config: WorkdayConfig,
  invoice: any,
  attachmentData: any[]
): Promise<CompanyIdentificationResult> {
  debug('Identifying company for invoice:', invoice.invoiceNumber);
  
  // Get all companies from Workday
  const companiesQuery = `
    SELECT 
      id,
      name,
      legalName,
      taxId,
      status
    FROM company
    WHERE status = "Active"
    ORDER BY name
  `;
  
  const companies = await executeWorkdayQuery(config, companiesQuery) as Array<{
    id: string;
    name: string;
    legalName: string;
    taxId: string;
    status: string;
  }>;
  
  // Prepare AI request for company identification
  const systemPrompt = `You are a company identification specialist. Given an invoice and a list of internal companies, identify which company this invoice belongs to. If no match is found, respond with "None" and provide your reasoning.`;
  
  const userMessage = `Please identify the company for this invoice:
Invoice Number: ${invoice.invoiceNumber}
Invoice Data: ${JSON.stringify(invoice, null, 2)}
Attachments: ${JSON.stringify(attachmentData)}

Available Companies:
${companies.map(c => `${(c as any).name} (ID: ${(c as any).id})`).join('\n')}`;

  const schema = {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: 'Workday company ID if found' },
      companyName: { type: 'string', description: 'Company name if found' },
      confidence: { type: 'number', description: 'Confidence level 0-1' },
      reasoning: { type: 'string', description: 'Explanation of the identification' }
    },
    required: ['companyId', 'companyName', 'confidence', 'reasoning']
  };

  const result = await callOpenAIWithSchema({
    prompt: systemPrompt,
    schema,
    messages: [{ role: 'user', content: userMessage }]
  });

  debug('Company identification result:', JSON.stringify(result, null, 2));
  
  return result as CompanyIdentificationResult;
}
