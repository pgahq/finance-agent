import { debug } from '@pga/logger';
import { getDocumentsByWorkdayIds, type DatabaseConnection } from './database.js';
import type { PurchaseOrderSupplier } from './workday.js';

export interface SupplierIdentity {
  names: string[];
  phones: string[];
  emails: string[];
}

export interface InvoiceSupplierEvidence {
  resolvedName?: string | null;
  extractedName?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface PurchaseOrderSupplierInput {
  purchaseOrderNumber?: string;
  purchaseOrderSupplier?: PurchaseOrderSupplier;
  /** The supplier resolved from the invoice (or the default supplier). */
  invoiceSupplierWID?: string;
  invoiceSupplier: InvoiceSupplierEvidence;
}

export type PurchaseOrderSupplierRelation = 'same' | 'related' | 'unrelated';

/** The PO's supplier, which the invoice is submitted with, and how the invoice's own supplier relates to it. */
export interface PurchaseOrderSupplierDecision {
  workdayId: string;
  descriptor: string;
  purchaseOrderNumber: string;
  relation: PurchaseOrderSupplierRelation;
  reason?: string;
  invoiceSupplierName?: string;
}

const NAME_STOPWORDS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'the',
  'mfg', 'manufacturing', 'usa', 'us', 'america', 'of', 'and', 'group', 'division', 'dba',
  'intl', 'international', 'enterprises', 'holdings', 'lp', 'llp', 'pllc', 'pc',
]);

// Domains many unrelated senders share: free mail, ISP mail, billing platforms that send on a vendor's
// behalf, and PGA's own domains (a misread bill-to block or a supplier record can carry them).
const SHARED_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'zoho.com',
  'comcast.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'verizon.net', 'cox.net', 'charter.net',
  'spectrum.net', 'earthlink.net', 'frontier.com', 'frontiernet.net', 'centurylink.net', 'optonline.net',
  'windstream.net', 'roadrunner.com', 'twc.com',
  'intuit.com', 'quickbooks.com', 'bill.com', 'hq.bill.com', 'paypal.com', 'squareup.com', 'stripe.com',
  'freshbooks.com', 'xero.com', 'invoicecloud.com',
  'pgahq.com', 'pga.com', 'pgaofamerica.com',
]);

/** A name-only match needs this many distinctive words, so generic one-word names like "Golf" never tie suppliers. */
const MIN_NAME_MATCH_TOKENS = 2;

function nameTokens(name: string): Set<string> {
  const tokens = name
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 2 && !NAME_STOPWORDS.has(token));
  return new Set(tokens);
}

/** Names match only when they reduce to the same set of at least two distinctive words. */
export function supplierNamesMatch(left: string, right: string): boolean {
  const a = nameTokens(left);
  const b = nameTokens(right);
  return a.size >= MIN_NAME_MATCH_TOKENS && a.size === b.size && [...a].every((token) => b.has(token));
}

function namesShareToken(left: string[], right: string[]): boolean {
  const rightTokens = new Set(right.flatMap((name) => [...nameTokens(name)]));
  return left.some((name) => [...nameTokens(name)].some((token) => rightTokens.has(token)));
}

function phoneKey(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : undefined;
}

function businessEmailDomain(email: string): string | undefined {
  const domain = email.trim().toLowerCase().split('@')[1]?.replace(/[>\s,;].*$/, '');
  return domain && !SHARED_EMAIL_DOMAINS.has(domain) ? domain : undefined;
}

function present(values: Array<string | null | undefined>): string[] {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
}

/** Splits a comma-joined list, as cached supplier documents and enrichment both write phones and emails. */
function listValues(value: string | null | undefined): string[] {
  return present(value?.split(',') ?? []);
}

function contentLine(content: string, label: string): string | undefined {
  return content.split('\n').find((row) => row.startsWith(`${label}:`))?.slice(label.length + 1);
}

/** Reads a cached supplier document (see `createSupplierContent`) into the names and contacts used to relate suppliers. */
export function supplierIdentityFromDocument(row: { content?: string | null; metadata?: unknown }): SupplierIdentity {
  const content = row.content ?? '';
  const metadataName = row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as { supplierName?: unknown }).supplierName
    : undefined;
  return {
    names: present([
      contentLine(content, 'Company Name'),
      ...listValues(contentLine(content, 'Alternate Names')),
      typeof metadataName === 'string' ? metadataName : undefined,
    ]),
    phones: listValues(contentLine(content, 'Phone')),
    emails: listValues(contentLine(content, 'Email')),
  };
}

function mergeIdentities(...identities: Array<SupplierIdentity | undefined>): SupplierIdentity {
  return {
    names: identities.flatMap((identity) => identity?.names ?? []),
    phones: identities.flatMap((identity) => identity?.phones ?? []),
    emails: identities.flatMap((identity) => identity?.emails ?? []),
  };
}

/** Explains why two suppliers look like the same company, or returns undefined when nothing ties them. */
export function relateSupplierIdentities(invoice: SupplierIdentity, purchaseOrder: SupplierIdentity): string | undefined {
  for (const invoiceName of invoice.names) {
    const match = purchaseOrder.names.find((poName) => supplierNamesMatch(invoiceName, poName));
    if (match) return `name "${invoiceName}" matches "${match}"`;
  }
  const poPhones = new Set(present(purchaseOrder.phones.map(phoneKey)));
  const sharedPhone = invoice.phones.find((phone) => {
    const key = phoneKey(phone);
    return key !== undefined && poPhones.has(key);
  });
  if (sharedPhone) return `phone ${sharedPhone} matches`;
  // A shared business domain counts only alongside a shared name word, since one sender can bill for several companies.
  if (!namesShareToken(invoice.names, purchaseOrder.names)) return undefined;
  const poDomains = new Set(present(purchaseOrder.emails.map(businessEmailDomain)));
  for (const email of invoice.emails) {
    const domain = businessEmailDomain(email);
    if (domain && poDomains.has(domain)) return `email domain ${domain} matches`;
  }
  return undefined;
}

/**
 * When the invoice's PO exists in Workday, the invoice is submitted with the PO's supplier: Workday only lets
 * that supplier invoice the PO. The relation to the invoice's own supplier only decides whether AP is asked to
 * confirm the PO number, since an unrelated supplier usually means a wrong PO number.
 */
export function decidePurchaseOrderSupplier(
  input: PurchaseOrderSupplierInput,
  profiles: { invoice?: SupplierIdentity; purchaseOrder?: SupplierIdentity } = {}
): PurchaseOrderSupplierDecision | undefined {
  const { purchaseOrderNumber, purchaseOrderSupplier, invoiceSupplierWID, invoiceSupplier } = input;
  if (!purchaseOrderNumber || !purchaseOrderSupplier) return undefined;

  const invoiceSupplierName = present([invoiceSupplier.resolvedName, invoiceSupplier.extractedName])[0];
  const base = {
    workdayId: purchaseOrderSupplier.workdayId,
    descriptor: purchaseOrderSupplier.descriptor,
    purchaseOrderNumber,
    ...(invoiceSupplierName ? { invoiceSupplierName } : {}),
  };
  if (invoiceSupplierWID === purchaseOrderSupplier.workdayId) return { ...base, relation: 'same' };

  const invoiceIdentity = mergeIdentities(
    {
      names: present([invoiceSupplier.resolvedName, invoiceSupplier.extractedName]),
      phones: listValues(invoiceSupplier.phone),
      emails: listValues(invoiceSupplier.email),
    },
    profiles.invoice,
  );
  const purchaseOrderIdentity = mergeIdentities({ names: [purchaseOrderSupplier.descriptor], phones: [], emails: [] }, profiles.purchaseOrder);
  const reason = relateSupplierIdentities(invoiceIdentity, purchaseOrderIdentity);
  return reason ? { ...base, relation: 'related', reason } : { ...base, relation: 'unrelated' };
}

/** Like `decidePurchaseOrderSupplier`, enriched with cached supplier profiles; falls back to names alone when the cache is unavailable. */
export async function resolvePurchaseOrderSupplier(
  db: DatabaseConnection | undefined,
  input: PurchaseOrderSupplierInput
): Promise<PurchaseOrderSupplierDecision | undefined> {
  const poSupplierWID = input.purchaseOrderSupplier?.workdayId;
  if (!input.purchaseOrderNumber || !poSupplierWID) return undefined;

  const profiles: { invoice?: SupplierIdentity; purchaseOrder?: SupplierIdentity } = {};
  if (db && input.invoiceSupplierWID !== poSupplierWID) {
    try {
      const rows = await getDocumentsByWorkdayIds(db, 'supplier', present([input.invoiceSupplierWID, poSupplierWID]));
      for (const row of rows) {
        if (row.workday_id === poSupplierWID) profiles.purchaseOrder = supplierIdentityFromDocument(row);
        else if (row.workday_id === input.invoiceSupplierWID) profiles.invoice = supplierIdentityFromDocument(row);
      }
    } catch (error) {
      debug('Failed to load cached supplier profiles for PO supplier check; relating by names only:', error);
    }
  }

  const decision = decidePurchaseOrderSupplier(input, profiles);
  debug('PO supplier check', {
    purchaseOrderNumber: input.purchaseOrderNumber,
    purchaseOrderSupplier: input.purchaseOrderSupplier?.descriptor,
    purchaseOrderSupplierWID: poSupplierWID,
    invoiceSupplierWID: input.invoiceSupplierWID,
    relation: decision?.relation,
    reason: decision?.reason,
  });
  return decision;
}

/** Workday note for a supplier taken from the PO; empty when the invoice already resolved to that supplier. */
export function formatPurchaseOrderSupplierNotes(decision: PurchaseOrderSupplierDecision | undefined): string {
  if (!decision || decision.relation === 'same') return '';
  const set = `\n\nSupplier from PO: Set to ${decision.descriptor}, the supplier on ${decision.purchaseOrderNumber}.`;
  if (!decision.invoiceSupplierName) return set;
  return decision.relation === 'related'
    ? `${set} The invoice names ${decision.invoiceSupplierName} (${decision.reason}).`
    : `${set} The invoice names ${decision.invoiceSupplierName}, which does not look like the same company; confirm the PO number.`;
}

/** Slack review line when the PO's supplier does not look like the company the invoice names. */
export function purchaseOrderSupplierReviewLine(decision: PurchaseOrderSupplierDecision | undefined): string | undefined {
  if (decision?.relation !== 'unrelated' || !decision.invoiceSupplierName) return undefined;
  return `Supplier set from ${decision.purchaseOrderNumber} (${decision.descriptor}); the invoice names ${decision.invoiceSupplierName}, which does not look like the same company. Confirm the PO number.`;
}
