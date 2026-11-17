// A payroll recharge invoice with invented names and amounts: the supplier bills PGA for staff wages, benefits, and
// employer payroll taxes. It prints "Sales Tax Amount $0.00" and a separate "Taxes" row (employer payroll taxes).
const row = (description: string, amount: string) => ({
  description,
  quantity: null,
  unitCost: null,
  totalPrice: amount,
  hasDiscount: null,
});

export const payrollRechargeSiblingRows = [
  row('Wages', '4000.00'),
  row('401K', '200.00'),
  row('Benefits', '300.00'),
  row('Medical', '250.00'),
  row('Workers Comp', '150.00'),
];

export const payrollTaxesRow = row('Taxes', '500.00');

export const payrollRechargeRows = [...payrollRechargeSiblingRows, payrollTaxesRow];

export const payrollRechargeHeader = {
  extractedAmountDue: '$5,400.00',
  extractedTaxAmount: '$0.00',
  extractedTaxLabel: 'Sales Tax Amount',
};

export const payrollTaxesCharge = { label: 'Taxes', amount: '$500.00' };

// The PO line for the recharge, which says the amount includes taxes.
export const payrollRechargePoLine = {
  lineOrder: 1,
  purchaseOrderLineId: 'POL-900001-1',
  purchaseOrderDocumentNumber: 'PO-900001',
  description: 'Staff labor recharge, wages, benefits and taxes',
  extendedAmount: 5400,
};
