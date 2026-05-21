#!/usr/bin/env tsx
/**
 * Local script to update a supplier invoice's supplier
 *
 * Usage: tsx src/update-invoice-supplier.ts <invoiceWorkdayID> <supplierWorkdayID>
 * Example: tsx src/update-invoice-supplier.ts abc123def456 xyz789ghi012
 */

import * as dotenv from 'dotenv';
import { getWorkdayConfig, submitSupplierInvoiceUpdate } from './lib/workday.js';

// Load environment variables from .env file
dotenv.config();

async function main() {
  const invoiceWorkdayID = process.argv[2];
  const supplierWorkdayID = process.argv[3];

  if (!invoiceWorkdayID || !supplierWorkdayID) {
    console.error('❌ Error: Please provide both invoice and supplier Workday IDs');
    console.error('');
    console.error('Usage: tsx src/update-invoice-supplier.ts <invoiceWorkdayID> <supplierWorkdayID>');
    console.error('Example: tsx src/update-invoice-supplier.ts abc123def456 xyz789ghi012');
    process.exit(1);
  }

  try {
    console.log('🚀 Starting Supplier Invoice Update');
    console.log('='.repeat(50));
    console.log('');
    console.log(`📄 Invoice Workday ID: ${invoiceWorkdayID}`);
    console.log(`🏢 Supplier Workday ID: ${supplierWorkdayID}`);
    console.log('');

    const workdayConfig = getWorkdayConfig(process.env);
    const context = { workdayConfig };

    console.log('⏳ Updating invoice supplier...');
    console.log('');

    const result = await submitSupplierInvoiceUpdate(context, {
      invoiceWorkdayID,
      supplierWID: supplierWorkdayID,
      buildNotes: () => ''
    });

    console.log('✅ Success!');
    console.log('');
    console.log('Result:', result.message);
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ Update failed:', error);
    process.exit(1);
  }
}

main();
