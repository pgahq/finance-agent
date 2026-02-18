// Core Domain Types

// AI Result Types
export interface SupplierIdentificationResult {
  workdayId: string;
  supplierId: string;
  supplierName: string;
  confidence: number;
  reasoning: string;
}



// Data types for actions
export interface SupplierData {
  total: number;
  data: Array<{
    supplier: {
      descriptor: string;
      id: string;
    };
    lastUpdatedDateTime: string;
    supplierStatus: {
      descriptor: string;
      id: string;
    };
    allPhoneNumbers?: Array<{
      descriptor: string;
      id: string;
    }>;
    allEmailAddresses?: Array<{
      descriptor: string;
      id: string;
    }>;
    allAddresses?: Array<{
      descriptor: string;
      id: string;
    }>;
    allAlternateNames?: Array<{
      descriptor: string;
      id: string;
    }>;
  }>;
}

export interface InvoiceData {
  workdayID: string;
  invoiceStatusAsText: string;
  OCRSupplierInvoice: {
    descriptor: string;
    id: string;
  };
  supplier?: {
    descriptor: string;
    id: string;
  };
  emailContext?: {
    emailFrom?: string;
    subject?: string;
    plainTextBody?: string;
  };
}


// Event Types
export interface ScheduleEvent {
  action: string; // Function name as action
  query: string;
  bulk?: boolean;
}

export interface WorkdayQueryResultDetail {
  action: string;
  data?: unknown;
  query?: string;
  bulk?: boolean;
  timestamp: string;
  requestId: string;
}

// Attachment Types

export interface DownloadedAttachment {
  id: string;
  fileName: string;
  contentType: string;
  buffer: Buffer;
  size: number;
}

export interface PresignedAttachment {
  id: string;
  fileName: string;
  contentType: string;
  presignedUrl: string;
  expiresAt: Date;
  s3Key: string;
  buffer?: Buffer; // Optional buffer for AI processing
}

// Detailed invoice returned by getSupplierInvoiceWithAttachments (SOAP response)
export interface WorkdayReference {
  descriptor: string;
  id: string;
}

export interface WorkdayInvoice {
  Invoice_Number?: string;
  controlTotalAmount?: string;
  company1?: WorkdayReference;
  OCRSupplierInvoice?: WorkdayReference;
  allAddresses?: WorkdayReference[];
  allPhoneNumbers?: WorkdayReference[];
  allEmailAddresses?: WorkdayReference[];
  [key: string]: unknown; // allow additional SOAP fields
}

// SOAP API Types
export interface SupplierInvoiceSoapResponse {
  $attributes?: any;
  Request_References?: any;
  Response_Group?: any;
  Response_Results?: any;
  Response_Data?: {
    Supplier_Invoice: {
      Supplier_Invoice_Data: {
        Invoice_ID: string;
        Attachment_Data?: {
          $attributes: {
            Filename: string;
            Content_Type: string;
          };
          File_Content: string; // base64
        };
      };
    };
  };
}
