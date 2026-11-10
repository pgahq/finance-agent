// Runs the real merge model (no mocks) on PO shapes that put the "no PO line describes it" rule at risk. It is
// skipped unless RUN_LIVE_MERGE_EVAL=1 and AI_GATEWAY_API_KEY are set, so CI never calls the model:
//   RUN_LIVE_MERGE_EVAL=1 npx jest --ci src/__tests__/merge_po_linking.live.test.ts
import { buildFinalInvoiceLines, unlinkedPoRowsNote } from '../lib/invoice_lines.js';
import { GOODS_LINE } from './fixtures/supin_472110.js';

const live = process.env.RUN_LIVE_MERGE_EVAL === '1' && process.env.AI_GATEWAY_API_KEY ? describe : describe.skip;

const poLine = (purchaseOrderLineId: string, description: string, extendedAmount: number) => ({
  lineOrder: 1,
  purchaseOrderLineId,
  purchaseOrderDocumentNumber: 'PO-LIVE',
  description,
  extendedAmount,
});

const row = (description: string, amount: string) => ({ description, quantity: 1, unitCost: amount, totalPrice: `$${amount}`, hasDiscount: false });

const merge = (rows: ReturnType<typeof row>[], poLines: ReturnType<typeof poLine>[]) =>
  buildFinalInvoiceLines(rows as any, poLines as any, undefined, {}, undefined, undefined, true, { invoiceDate: '2026-10-27', servicePeriod: null });

const RUNS = 3;

live('merge model on single broad PO lines (live)', () => {
  it.each([
    ['Q3 services', 'Q3 services', 5000, [row('Consulting hours', '3000.00'), row('Project management', '1500.00'), row('Travel expenses', '500.00')]],
    ['Event rentals', 'Event rentals', 10000, [row('Tent rental', '6000.00'), row('Table and chair rental', '3000.00'), row('Linen rental', '1000.00')]],
    ['Marketing', 'Marketing campaign support', 8000, [row('Creative design', '4500.00'), row('Media buy', '3000.00'), row('Reporting', '500.00')]],
  ])('links every row to the one broad PO line: %s', async (_name, poDescription, amount, rows) => {
    const poLines = [poLine('LINE-BROAD', poDescription as string, amount as number)];
    for (let run = 0; run < RUNS; run++) {
      const built = await merge(rows as any, poLines);
      expect(built.lines.map(line => line.purchaseOrderLineId)).toEqual(rows.map(() => 'LINE-BROAD'));
      expect(built.modelUnlinkedPoRows).toBeUndefined();
    }
  }, 300000);

  it('keeps every link when a single broad PO line is overbilled', async () => {
    const poLines = [poLine('LINE-BROAD', 'Annual maintenance', 1000)];
    const rows = [row('Labor', '600.00'), row('Parts', '500.00')];
    for (let run = 0; run < RUNS; run++) {
      const built = await merge(rows, poLines);
      expect(built.lines.map(line => line.purchaseOrderLineId)).toEqual(['LINE-BROAD', 'LINE-BROAD']);
      expect(unlinkedPoRowsNote(built.unlinkedPoRows, built.modelUnlinkedPoRows)).toBeUndefined();
    }
  }, 300000);

  it('still leaves fuel off a light tower line that does not describe it', async () => {
    const poLines = [poLine(GOODS_LINE, 'LIGHT TOWER,4-7KW LED VERT MAST', 1348)];
    const rows = [row('LIGHT TOWER A', '674.00'), row('LIGHT TOWER B', '674.00'), row('DIESEL FUEL', '27.94')];
    for (let run = 0; run < RUNS; run++) {
      const built = await merge(rows, poLines);
      expect(built.lines.map(line => line.purchaseOrderLineId)).toEqual([GOODS_LINE, GOODS_LINE, null]);
    }
  }, 300000);
});
