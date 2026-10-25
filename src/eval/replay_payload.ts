import { extractScoredFields, type ScoredFields, type ScoredLine } from '../lib/invoice_snapshots.js';

type Json = Record<string, unknown>;

/** Maps the WID references a request carries to the reference-ID keys a Workday read-back (and so a snapshot) uses. */
export interface ReferenceResolver {
  supplierKey(workdayId: string): Promise<string | undefined>;
  companyKey(workdayId: string): Promise<string | undefined>;
}

export interface MappedPayload {
  fields: ScoredFields;
  /** Things that may make the replay look different from a read-back for reasons that are not the pipeline's. */
  warnings: string[];
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function numeric(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A line the pipeline sends with a quantity and unit cost but no Extended_Amount is stored by Workday with the
 * product as its extended amount, so a read-back always has one.
 */
function withExtendedAmount(line: Json): Json {
  if (numeric(line.Extended_Amount) !== undefined) return line;
  const quantity = numeric(line.Quantity);
  const unitCost = numeric(line.Unit_Cost);
  if (quantity === undefined || unitCost === undefined) return line;
  return { ...line, Extended_Amount: Math.round(quantity * unitCost * 100) / 100 };
}

/**
 * Reads the scored fields out of the `Submit_Supplier_Invoice` request the pipeline built. The request carries the
 * same `Supplier_Invoice_Data` field names a Get_Supplier_Invoices read-back does, so the production extractor
 * (`extractScoredFields`) does the reading; what the mapping adds is what Workday fills in or rewrites on save:
 * extended amounts, and WID references that read back as reference IDs.
 */
export async function scoredFieldsFromSubmitRequest(
  request: { Submit_Supplier_Invoice_Request?: { Supplier_Invoice_Data?: unknown } },
  resolver?: ReferenceResolver
): Promise<MappedPayload> {
  const data = (request.Submit_Supplier_Invoice_Request?.Supplier_Invoice_Data ?? {}) as Json;
  const lines = asArray(data.Invoice_Line_Replacement_Data as Json | Json[] | undefined).map(withExtendedAmount);
  const fields = extractScoredFields({ ...data, Invoice_Line_Replacement_Data: lines });
  const warnings: string[] = [];

  const resolveHeader = async (
    field: 'supplier' | 'company',
    lookup: ((workdayId: string) => Promise<string | undefined>) | undefined
  ) => {
    const key = fields[field];
    if (!key?.startsWith('WID=')) return;
    const resolved = lookup ? await lookup(key.slice('WID='.length)) : undefined;
    if (resolved) fields[field] = resolved;
    else warnings.push(`${field} is a WID (${key.slice('WID='.length)}) that could not be mapped to a reference ID, so it may show as a false correction`);
  };
  await resolveHeader('supplier', resolver ? (wid) => resolver.supplierKey(wid) : undefined);
  await resolveHeader('company', resolver ? (wid) => resolver.companyKey(wid) : undefined);

  const withSplits = lines.filter((line) => asArray(line.Supplier_Invoice_Split_Line_Data as unknown[] | undefined).length > 0).length;
  if (withSplits) {
    warnings.push(`${withSplits} line(s) carry PO split rows; the scorer reads only line-level worktags, as it does on a read-back`);
  }
  return { fields, warnings };
}

function reference(key: string): Json {
  const at = key.indexOf('=');
  const type = at >= 0 ? key.slice(0, at) : 'WID';
  const value = at >= 0 ? key.slice(at + 1) : key;
  return { ID: [{ $attributes: { type }, $value: value }] };
}

function lineData(line: ScoredLine): Json {
  const worktags = [line.costCenter, line.fund, line.lineOfBusiness, ...line.otherWorktags].filter((key): key is string => Boolean(key));
  return {
    ...(line.lineOrder !== undefined ? { Line_Order: line.lineOrder } : {}),
    ...(line.itemDescription ? { Item_Description: line.itemDescription } : {}),
    ...(line.amount !== undefined ? { Extended_Amount: line.amount } : {}),
    ...(line.purchaseOrderLine ? { Purchase_Order_Line_Reference: reference(line.purchaseOrderLine) } : {}),
    ...(line.spendCategory ? { Spend_Category_Reference: reference(line.spendCategory) } : {}),
    ...(worktags.length ? { Worktags_Reference: worktags.map(reference) } : {}),
    ...(line.memo ? { Memo: line.memo } : {}),
  };
}

/**
 * The inverse of `extractScoredFields`: a `Supplier_Invoice_Data` object that reads back as `fields`. The enrich replay
 * uses it to stand in for the OCR invoice Workday held before the agent wrote, built from the baseline snapshot.
 */
export function invoiceDataFromScoredFields(fields: ScoredFields, invoiceNumber?: string): Json {
  return {
    ...(invoiceNumber ? { Invoice_Number: invoiceNumber } : {}),
    ...(fields.supplier ? { Supplier_Reference: reference(fields.supplier) } : {}),
    ...(fields.company ? { Company_Reference: reference(fields.company) } : {}),
    ...(fields.suppliersInvoiceNumber ? { Suppliers_Invoice_Number: fields.suppliersInvoiceNumber } : {}),
    ...(fields.invoiceDate ? { Invoice_Date: fields.invoiceDate } : {}),
    ...(fields.dueDate ? { Due_Date_Override: fields.dueDate } : {}),
    ...(fields.controlTotal !== undefined ? { Control_Amount_Total: fields.controlTotal } : {}),
    ...(fields.memo ? { Memo: fields.memo } : {}),
    ...(fields.lines.length ? { Invoice_Line_Replacement_Data: fields.lines.map(lineData) } : {}),
  };
}
