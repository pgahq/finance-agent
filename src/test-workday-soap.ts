import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();


interface WorkdaySoapConfig {
  domain: string;
  tenant: string;
  username: string;
  password: string;
}

interface SupplierInvoiceSoapResponse {
  Response_Data?: {
    Supplier_Invoice?: {
      Supplier_Invoice_Data?: any;
    };
  };
}

// Get configuration from environment variables
const getWorkdaySoapConfig = (): WorkdaySoapConfig => {
  const domain = process.env.WORKDAY_DOMAIN;
  const tenant = process.env.WORKDAY_TENANT;
  const username = process.env.WORKDAY_USER;
  const password = process.env.WORKDAY_PASSWORD;

  if (!domain || !tenant || !username || !password) {
    throw new Error(
      'Missing required environment variables. Please ensure WORKDAY_DOMAIN, WORKDAY_TENANT, WORKDAY_USER, and WORKDAY_PASSWORD are set in your .env file.'
    );
  }

  return { domain, tenant, username, password };
};

async function getSupplierInvoice(
  config: WorkdaySoapConfig,
  workdayID: string
): Promise<any> {
  const strongSoapModule = await import('strong-soap');
  const soap = strongSoapModule.soap;

  const username = `${config.username}@${config.tenant}`;
  const wsdlPath = path.join(process.cwd(), 'dist', 'soap', 'Resource_Management.wsdl');

  console.log('🔧 Configuring Workday SOAP client...');
  console.log(`   WSDL path: ${wsdlPath}`);
  console.log(`   WorkdayID: ${workdayID}`);
  console.log(`   Username: ${username}`);
  console.log(`   Domain: ${config.domain}`);
  console.log(`   Tenant: ${config.tenant}`);
  console.log(`   password: ${config.password}`);

  const soapResponse = await new Promise<SupplierInvoiceSoapResponse>((resolve, reject) => {
    soap.createClient(wsdlPath, {}, (err: any, client: any) => {
      if (err) {
        console.error('❌ Failed to create SOAP client:', err);
        return reject(err);
      }

      client.setSecurity(new soap.WSSecurity(username, config.password, {
        passwordType: 'PasswordText',
        mustUnderstand: true
      }));

      const endpoint = `https://${config.domain}/ccx/service/${config.tenant}/Resource_Management/v44.1`;
      client.setEndpoint(endpoint);

      console.log(`📡 Sending request to: ${endpoint}`);
      console.log('');

      const request = {
        Get_Supplier_Invoices_Request: {
          Request_References: {
            Supplier_Invoice_Reference: {
              ID: [{ $attributes: { type: 'WID' }, $value: workdayID }]
            }
          },
          Response_Group: {
            Include_Reference: true,
            Include_Attachment_Data: false // Don't fetch attachment data for testing
          }
        }
      };

      console.log('⏳ Requesting Supplier Invoice from Workday...');

      client.Get_Supplier_Invoices(request, (err: any, result: any) => {
        if (err) {
          console.error('❌ Error from Workday SOAP API:', err);
          return reject(err);
        }
        console.log('✅ Successfully received response from Workday!');
        console.log('');
        resolve(result);
      });
    });
  });

  const supplierInvoice = soapResponse?.Response_Data?.Supplier_Invoice;
  const invoiceData = supplierInvoice?.Supplier_Invoice_Data

  if (!invoiceData) {
    throw new Error(`No invoice found for workdayID: ${workdayID}`);
  }


  return invoiceData;
}

async function main() {
  const workdayID = process.argv[2];

  if (!workdayID) {
    console.error('❌ Error: Please provide a Workday ID as an argument');
    console.error('');
    console.error('Usage: tsx test-workday-soap.ts <workdayID>');
    console.error('Example: tsx test-workday-soap.ts abc123def456');
    process.exit(1);
  }

  try {
    console.log('🚀 Starting Workday SOAP API Test');
    console.log('='.repeat(50));
    console.log('');

    const config = getWorkdaySoapConfig();
    const invoice = await getSupplierInvoice(config, workdayID);

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
