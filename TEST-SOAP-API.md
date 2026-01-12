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

## Available Scripts

### 1. Get Supplier Invoice (Read-Only)

The `get-supplier-invoice.ts` script allows you to fetch a supplier invoice by its Workday ID without processing attachments.

**Usage:**

```bash
npx tsx src/get-supplier-invoice.ts <invoiceWorkdayID>
```

### 2. Update Invoice Supplier (Write Operation)

The `update-invoice-supplier.ts` script allows you to update an invoice's supplier by providing both the invoice and supplier Workday IDs.

**Usage:**

```bash
npx tsx src/update-invoice-supplier.ts <invoiceWorkdayID> <supplierWorkdayID>
```

## What the Scripts Do

### Get Supplier Invoice Script

1. Loads configuration from your `.env` file
2. Creates a Workday SOAP client using the `strong-soap` library
3. Authenticates using WS-Security with username/password
4. Sends a `Get_Supplier_Invoices` request for the specified Workday ID
5. Returns the invoice data **without** fetching or processing attachments
6. Displays the invoice data in JSON format

### Update Invoice Supplier Script

1. Loads configuration from your `.env` file
2. Creates a Workday SOAP client using the `strong-soap` library
3. Authenticates using WS-Security with username/password
4. Sends a `Submit_Supplier_Invoice` request with the new supplier reference
5. Updates the invoice's supplier field in Workday
6. Returns success confirmation

## Expected Output

### Get Invoice Script

If successful, you'll see output like:

```
🚀 Starting Workday SOAP API Test
==================================================

📄 Invoice Data:
==================================================
{
  "Invoice_Number": "12649",
  "Supplier_Reference": {
    "ID": [
      {
        "$attributes": {
          "type": "Supplier_ID"
        },
        "$value": "S-0032"
      }
    ]
  },
  ...
}

✅ Test completed successfully!
```

### Update Invoice Script

If successful, you'll see output like:

```
🚀 Starting Supplier Invoice Update
==================================================

📄 Invoice Workday ID: 79dde6884d3e90d6f3036e70178f2a22
🏢 Supplier Workday ID: 5e9cfa37f37d46cf8a4fa91ec37a7564

⏳ Updating invoice supplier...

✅ Success!

Result: Successfully updated invoice 79dde6884d3e90d6f3036e70178f2a22 with supplier 5e9cfa37f37d46cf8a4fa91ec37a7564
```

## Troubleshooting

### Authentication Errors

- Verify your `WORKDAY_USER` and `WORKDAY_PASSWORD` in `.env`
- Ensure the user has proper permissions for Resource Management API
- For the update script, ensure the user has write permissions to submit supplier invoices

### WSDL Not Found

- Run `npm run build` to copy the WSDL file to the dist folder

### Missing Dependencies

- Run `npm install` to ensure all dependencies are installed

### Invalid Workday ID

- Verify the Workday ID exists and is a valid WID (Workday ID)
- Check that the invoice ID corresponds to a Supplier Invoice object
- Check that the supplier ID corresponds to a valid Supplier object

### Update Script Fails

- Ensure the invoice is in a status that allows updates (e.g., DRAFT)
- Verify the supplier Workday ID is valid and active
- Check that you have permission to modify the invoice

## Important Notes

⚠️ **Warning**: The `update-invoice-supplier.ts` script makes **write operations** to Workday. Use with caution:

- Double check that you are pointing to a test tenant in workday before running
- Verify the supplier Workday ID before running the update
- Consider the invoice status - some statuses may not allow updates
- Changes made through this script are permanent and may trigger workflows in Workday

## Functions Available in workday.ts

Both scripts use functions exported from `src/lib/workday.ts` that can also be used in Lambda functions:

- **`getSupplierInvoice()`** - Fetch invoice without attachments (read-only)
- **`updateSupplierInvoiceSupplier()`** - Update an invoice's supplier (write operation)
- **`getSupplierInvoiceWithAttachments()`** - Fetch invoice with attachments, process PDFs, upload to S3 (production Lambda)
