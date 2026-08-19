import type { AddonEnvironment, SupplierInvoiceLabelState } from './gmail.js';

export interface SupplierInvoiceAddonCopy {
  cardTitle: string;
  cardSubtitle?: string;
  createButton: string;
  createAgainButton: string;
  confirmTitle: string;
  confirmBody: string;
  confirmButton: string;
  cancelButton: string;
  openAMessage: string;
  startedToast: string;
  status: Record<SupplierInvoiceLabelState | 'idle', string>;
}

export function supplierInvoiceAddonCopy(environment: AddonEnvironment): SupplierInvoiceAddonCopy {
  if (environment === 'sandbox') {
    return {
      cardTitle: 'Workday supplier invoice (sandbox)',
      cardSubtitle: 'Creates invoices in the Workday sandbox',
      createButton: 'Create supplier invoice',
      createAgainButton: 'Create supplier invoice again',
      confirmTitle: 'Create another sandbox supplier invoice?',
      confirmBody: 'This may create another Workday supplier invoice in the sandbox.',
      confirmButton: 'Create supplier invoice again',
      cancelButton: 'Cancel',
      openAMessage: 'Open a supplier email with a PDF to create a Workday supplier invoice in the sandbox.',
      startedToast: 'Supplier invoice creation started (sandbox).',
      status: {
        idle: 'No supplier invoice has been submitted from this message.',
        processing: 'Supplier invoice processing in the Workday sandbox.',
        success: 'Supplier invoice created in the Workday sandbox.',
        failure: 'Supplier invoice creation failed in the Workday sandbox.',
        partial: 'Some supplier invoices failed in the Workday sandbox.',
      },
    };
  }

  return {
    cardTitle: 'Workday supplier invoice',
    createButton: 'Create supplier invoice',
    createAgainButton: 'Create supplier invoice again',
    confirmTitle: 'Create another supplier invoice?',
    confirmBody: 'This may create another Workday supplier invoice.',
    confirmButton: 'Create supplier invoice again',
    cancelButton: 'Cancel',
    openAMessage: 'Open a supplier email with a PDF to create a Workday supplier invoice.',
    startedToast: 'Supplier invoice creation started.',
    status: {
      idle: 'No supplier invoice has been submitted from this message.',
      processing: 'Supplier invoice processing.',
      success: 'Supplier invoice created.',
      failure: 'Supplier invoice creation failed.',
      partial: 'Some supplier invoices from this message failed.',
    },
  };
}
