# Testing Workday SOAP API Locally

This guide explains how to test the Workday SOAP API connection locally without using AWS Lambda.
I created this just to be able to run some specific SOAP actions locally without deploying to AWS.

## Prerequisites

1. You will need the required environment variables in your `.env` file:

   ```bash
   WORKDAY_DOMAIN=your-domain.workday.com
   WORKDAY_TENANT=your-tenant-name
   WORKDAY_USER=your-integration-username
   WORKDAY_PASSWORD=your-integration-password
   ```

2. Make sure the project is built (so the WSDL file is in the dist folder):
   ```bash
   npm run build
   ```

## Running the Test Script

The script `test-workday-soap.ts` allows you to fetch a supplier invoice by its Workday ID without processing attachments.

### Example

```bash
tsx src/test-workday-soap.ts abc123def456
```

## What the Script Does

The test script:

1. Loads configuration from your `.env` file
2. Creates a Workday SOAP client using the `strong-soap` library
3. Authenticates using WS-Security with username/password
4. Sends a `Get_Supplier_Invoices` request for the specified Workday ID
5. Returns the invoice data **without** fetching or processing attachments
6. Displays the invoice data in JSON format

## Key Differences from Lambda Function

| Feature        | Lambda Function         | Test Script            |
| -------------- | ----------------------- | ---------------------- |
| Attachments    | Downloads and processes | Skipped (set to false) |
| S3 Upload      | Yes                     | No                     |
| PDF Conversion | Yes                     | No                     |
| Environment    | AWS Lambda              | Local machine          |
| Purpose        | Production processing   | API connectivity test  |

## Expected Output

If successful, you'll see output like:

```
🚀 Starting Workday SOAP API Test
==================================================

🔧 Configuring Workday SOAP client...
   WSDL path: /path/to/dist/soap/Resource_Management.wsdl
   WorkdayID: abc123def456
   Username: integration-user@tenant
   Domain: domain.workday.com
   Tenant: tenant

📡 Sending request to: https://domain.workday.com/ccx/service/tenant/Resource_Management/v44.1

⏳ Requesting Supplier Invoice from Workday...
✅ Successfully received response from Workday!

📄 Invoice Data:
==================================================
{
  "Invoice_ID": "INV-12345",
  "Invoice_Number": "2024-001",
  "Supplier": {
    "descriptor": "Acme Corp",
    "id": "supplier-wid"
  },
  ...
}

✅ Test completed successfully!
```

## Troubleshooting

### Authentication Errors

- Verify your `WORKDAY_USER` and `WORKDAY_PASSWORD` in `.env`
- Ensure the user has proper permissions for Resource Management API

### WSDL Not Found

- Run `npm run build` to copy the WSDL file to the dist folder

### Missing Dependencies

- Run `npm install` to ensure all dependencies are installed

### Invalid Workday ID

- Verify the Workday ID exists and is a valid WID (Workday ID)
- Check that the ID corresponds to a Supplier Invoice object
