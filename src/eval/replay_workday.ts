import type { PresignedAttachment, WorkdayInvoice } from '../lib/types.js';
import type { WorkdayReplayHook } from '../lib/workday.js';

type Callback = (error: unknown, result?: unknown) => void;
type Json = Record<string, unknown>;

export interface RecordedSubmit {
  request: { Submit_Supplier_Invoice_Request?: { Supplier_Invoice_Reference?: unknown; Supplier_Invoice_Data?: unknown } };
  /** The invoice WID of an update; undefined for a create. */
  invoiceWorkdayId?: string;
}

export interface ReplayWorkdayOptions {
  /** `Supplier_Invoice_Data` Workday would return for an invoice WID (the OCR invoice, for an enrich replay). */
  invoices?: Map<string, Json>;
  /** Raw `Get_Purchase_Orders` responses by document number, as exported with the case. */
  purchaseOrders?: Map<string, unknown>;
  /** The attachments the enrich pipeline reads from the invoice, loaded from the pinned S3 versions. */
  loadAttachments?: (workdayId: string) => Promise<PresignedAttachment[]>;
}

export interface ReplayWorkday {
  hook: WorkdayReplayHook;
  submits: RecordedSubmit[];
  /** Everything the fake refused, for the run log. */
  blocked: string[];
}

export const REPLAY_CREATED_WID = 'replay-created-invoice';

function referenceId(reference: unknown, type: string): string | undefined {
  const ids = (reference as { ID?: unknown } | undefined)?.ID;
  for (const id of Array.isArray(ids) ? ids : ids ? [ids] : []) {
    const record = id as { $attributes?: { type?: string }; $value?: unknown };
    if (record.$attributes?.type === type && record.$value != null) return String(record.$value);
  }
  return undefined;
}

/**
 * The replay's stand-in for Workday. It answers the three calls the pipeline makes during a run (invoice read, PO read,
 * invoice submit) from the case, records every submit instead of sending it, and fails every other call, so a run that
 * reaches for anything else stops loudly rather than touching the tenant.
 */
export function createReplayWorkday(options: ReplayWorkdayOptions = {}): ReplayWorkday {
  const submits: RecordedSubmit[] = [];
  const blocked: string[] = [];
  const invoices = options.invoices ?? new Map<string, Json>();
  const purchaseOrders = options.purchaseOrders ?? new Map<string, unknown>();

  const handlers: Record<string, (request: Json, callback: Callback) => void> = {
    Submit_Supplier_Invoice: (request, callback) => {
      const body = request as RecordedSubmit['request'];
      const reference = body.Submit_Supplier_Invoice_Request?.Supplier_Invoice_Reference;
      const invoiceWorkdayId = referenceId(reference, 'WID');
      submits.push({ request: body, ...(invoiceWorkdayId ? { invoiceWorkdayId } : {}) });
      const wid = invoiceWorkdayId ?? REPLAY_CREATED_WID;
      callback(null, { Supplier_Invoice_Reference: { ID: [{ $attributes: { type: 'WID' }, $value: wid }] } });
    },
    Get_Supplier_Invoices: (request, callback) => {
      const reference = (request.Get_Supplier_Invoices_Request as Json | undefined)?.Request_References as Json | undefined;
      const wid = referenceId(reference?.Supplier_Invoice_Reference, 'WID');
      const invoice = wid ? invoices.get(wid) : undefined;
      callback(null, invoice
        ? { Response_Data: { Supplier_Invoice: [{ Supplier_Invoice_Data: [invoice] }] } }
        : { Response_Data: {} });
    },
    Get_Purchase_Orders: (request, callback) => {
      const reference = (request.Get_Purchase_Orders_Request as Json | undefined)?.Request_References as Json | undefined;
      const documentNumber = referenceId(reference?.Purchase_Order_Reference, 'Document_Number');
      callback(null, (documentNumber ? purchaseOrders.get(documentNumber) : undefined) ?? { Response_Data: {} });
    },
  };

  const client = new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      const handler = handlers[property];
      if (handler) return (request: Json, callback: Callback) => handler(request, callback);
      // SOAP operations are Capitalized_With_Underscores; anything else (lastRequest, then, ...) reads as absent.
      if (!/^[A-Z][A-Za-z]*(_[A-Za-z]+)+$/.test(property)) return undefined;
      return (_request: Json, callback: Callback) => {
        blocked.push(property);
        callback(new Error(`Workday operation ${property} is blocked in an eval replay`));
      };
    },
  });

  return {
    hook: {
      client,
      loadInvoiceWithAttachments: async (workdayId) => {
        const invoice = invoices.get(workdayId);
        if (!invoice) throw new Error(`No invoice found for workdayID: ${workdayId}`);
        return {
          invoice: invoice as WorkdayInvoice,
          presignedAttachments: options.loadAttachments ? await options.loadAttachments(workdayId) : [],
        };
      },
    },
    submits,
    blocked,
  };
}
