import * as dotenv from 'dotenv';
import { getSupplierInvoice, getWorkdaySoapConfig } from './lib/workday.js';

dotenv.config();

async function main() {
  const workdayID = process.argv[2];

  if (!workdayID) {
    console.error('❌ Error: Please provide a Workday ID as an argument');
    console.error('');
    console.error('Usage: tsx src/get-supplier-invoice.ts <workdayID>');
    console.error('Example: tsx src/get-supplier-invoice.ts abc123def456');
    process.exit(1);
  }

  try {
    console.log('🚀 Starting Workday SOAP API Test');
    console.log('='.repeat(50));
    console.log('');

    const workdaySoapConfig = getWorkdaySoapConfig(process.env);
    const context = { workdaySoapConfig };

    const invoice = await getSupplierInvoice(context, workdayID);

    console.log('📄 Invoice Data:');
    console.log('='.repeat(50));
    console.log(JSON.stringify(invoice, null, 2));
    console.log('');
    console.log('✅ Test completed successfully!');

  } catch (error) {
    console.error('');
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

main();
