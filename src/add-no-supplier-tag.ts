#!/usr/bin/env tsx
/**
 * Local script to add a no-supplier work queue tag to an invoice
 *
 * Usage: tsx src/add-no-supplier-tag.ts <invoiceWorkdayID>
 * Example: tsx src/add-no-supplier-tag.ts abc123def456
 */

import * as dotenv from 'dotenv';
import { addNoSupplierTagToInvoice, getWorkdayConfig } from './lib/workday.js';

dotenv.config();

async function main() {
  const invoiceWorkdayID = process.argv[2];

  if (!invoiceWorkdayID) {
    console.error('❌ Error: Please provide an invoice Workday ID');
    console.error('');
    console.error('Usage: tsx src/add-no-supplier-tag.ts <invoiceWorkdayID>');
    console.error('Example: tsx src/add-no-supplier-tag.ts abc123def456');
    process.exit(1);
  }

  try {
    console.log('🚀 Starting No-Supplier Tag Addition');
    console.log('='.repeat(50));
    console.log('');
    console.log(`📄 Invoice Workday ID: ${invoiceWorkdayID}`);
    console.log('');

    const workdayConfig = getWorkdayConfig(process.env);
    const context = { workdayConfig };

    console.log('⏳ Adding no-supplier tag to invoice...');
    console.log('');

    const result = await addNoSupplierTagToInvoice(
      context,
      invoiceWorkdayID
    );

    console.log('✅ Success!');
    console.log('');
    console.log('Result:', result.message);
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ Tag addition failed:', error);
    process.exit(1);
  }
}

main();
