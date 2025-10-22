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

export interface CompanyIdentificationResult {
  companyId: string;
  companyName: string;
  confidence: number;
  reasoning: string;
}

// Event Types
export interface ScheduleEvent {
  action: string;
  query: string;
  bulk?: boolean;
}

export interface WorkdayQueryResultDetail {
  action: string;
  data: unknown;
  timestamp: string;
  requestId: string;
}
