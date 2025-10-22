// Core Domain Types
export interface CachedSupplier {
  supplierId: string;
  supplierName: string;
  lastUpdatedDateTime: string;
  supplierStatus: string;
  allPhoneNumbers: string[];
  allEmailAddresses: string[];
  allAddresses: string[];
}

export interface SupplierCacheData {
  cachedAt: string;
  totalCount: number;
  suppliers: CachedSupplier[];
}

// AI Result Types
export interface SupplierIdentificationResult {
  supplierId: string;
  supplierName: string;
  confidence: number;
  reasoning: string;
}

export interface BatchSupplierIdentificationResult {
  supplierId: string;
  supplierName: string;
  confidence: number;
  reasoning: string;
  batchIndex: number;
  totalBatches: number;
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
  }>;
}

export interface InvoiceData {
  workdayID: string;
  invoiceStatusAsText: string;
  OCRSupplierInvoice: {
    descriptor: string;
    id: string;
  };
}

export interface CompanyIdentificationResult {
  companyId: string;
  companyName: string;
  confidence: number;
  reasoning: string;
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
