import { annotateSupplierInvoice, executeWorkdayQuery, getAllPaymentTerms, getSupplierInvoiceWithAttachments, getWorkdayConfig, parsePurchaseOrderLines, submitSupplierInvoiceUpdate } from '../lib/workday.js';

// Mock the dependencies
jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

// Mock fetch globally
global.fetch = jest.fn();

// Mock strong-soap
jest.mock('strong-soap', () => ({
  soap: {
    createClient: jest.fn(),
    BearerSecurity: jest.fn()
  }
}));

// Mock path module
jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/'))
}));

jest.mock('../lib/s3.js', () => ({
  uploadAttachmentToS3: jest.fn().mockResolvedValue({
    id: 'test-id',
    presignedUrl: 'https://test-url.com',
    expiresAt: new Date(),
    s3Key: 'test-key'
  })
}));

jest.mock('../lib/workday_submit_repair.js', () => ({
  proposeWorkdaySubmitRepair: jest.fn()
}));

jest.mock('../lib/workday_validation_field_agent.js', () => ({
  classifyWorkdayValidationField: jest.fn()
}));

describe('Workday utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { classifyWorkdayValidationField } = require('../lib/workday_validation_field_agent.js');
    classifyWorkdayValidationField.mockImplementation(({ validation }: { validation: { message?: string; detailMessage?: string; xpath?: string } }) => {
      const text = `${validation.message ?? ''} ${validation.detailMessage ?? ''} ${validation.xpath ?? ''}`.toLowerCase();

      if (/payment[_\s-]*terms?|\bterms?\b/.test(text)) {
        return Promise.resolve({ retryField: 'paymentTerms', reason: 'test payment terms classification' });
      }

      if (/invoice[_\s-]*date|\bdate\b/.test(text)) {
        return Promise.resolve({ retryField: 'invoiceDate', reason: 'test invoice date classification' });
      }

      if (/cost[_\s-]*center/.test(text)) {
        return Promise.resolve({ retryField: 'worktag:costCenter', reason: 'test cost center classification' });
      }

      if (/\bfund\b/.test(text)) {
        return Promise.resolve({ retryField: 'worktag:fund', reason: 'test fund classification' });
      }

      if (/spend[_\s-]*category/.test(text)) {
        return Promise.resolve({ retryField: 'worktag:spendCategory', reason: 'test spend category classification' });
      }

      if (/\bevent\b/.test(text)) {
        return Promise.resolve({ retryField: 'worktag:event', reason: 'test event classification' });
      }

      if (/line[_\s-]*of[_\s-]*business|\blob\b/.test(text)) {
        return Promise.resolve({ retryField: 'worktag:lob', reason: 'test LOB classification' });
      }

      if (/worktags?/.test(text)) {
        return Promise.resolve({ retryField: 'unknown', reason: 'cannot identify specific worktag type' });
      }

      if (/supplier/.test(text)) {
        return Promise.resolve({ retryField: 'supplier', reason: 'test supplier classification' });
      }

      return Promise.resolve({ retryField: 'unknown', reason: 'test unknown classification' });
    });
  });

  describe('getWorkdayConfig', () => {
    it('should extract configuration from environment variables', () => {
      const mockEnv = {
        WORKDAY_DOMAIN: 'test.workday.com',
        WORKDAY_TENANT: 'test-tenant',
        WORKDAY_CLIENT_ID: 'test-client-id',
        WORKDAY_CLIENT_SECRET: 'test-client-secret',
        WORKDAY_REFRESH_TOKEN: 'test-refresh-token',
      };

      const config = getWorkdayConfig(mockEnv);

      expect(config).toEqual({
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token',
      });
    });

    it('should handle missing environment variables', () => {
      const mockEnv = {};

      const config = getWorkdayConfig(mockEnv);
      expect(config.domain).toBeUndefined();
      expect(config.tenant).toBeUndefined();
      expect(config.clientId).toBeUndefined();
      expect(config.clientSecret).toBeUndefined();
      expect(config.refreshToken).toBeUndefined();
    });
  });

  describe('executeWorkdayQuery', () => {
    const mockConfig = {
      domain: 'test.workday.com',
      tenant: 'test-tenant',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token'
    };

    it('should execute WQL query successfully', async () => {
      const mockQuery = 'SELECT id, name FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = {
        data: [
          { id: '1', name: 'Supplier A' },
          { id: '2', name: 'Supplier B' }
        ]
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockQueryResponse);
    });

    it('should handle query response with new format', async () => {
      const mockQuery = 'SELECT workdayID, invoiceNumber FROM supplierInvoices';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = {
        total: 2,
        data: [
          { workdayID: '123', invoiceNumber: 'INV-001' },
          { workdayID: '456', invoiceNumber: 'INV-002' }
        ]
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(result).toEqual(mockQueryResponse);
    });

    it('should handle empty query response', async () => {
      const mockQuery = 'SELECT id FROM emptyTable';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = { total: 0, data: [] };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(result).toEqual({ total: 0, data: [] });
    });

    it('should handle query response without data property', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = { total: 0, data: [] };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(result).toEqual({ total: 0, data: [] });
    });

    it('should throw error when token request fails', async () => {
      const mockQuery = 'SELECT id FROM suppliers';

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: jest.fn().mockResolvedValue('Invalid credentials')
      });

      await expect(executeWorkdayQuery(mockConfig, mockQuery))
        .rejects.toThrow('Failed to get access token: 401 Unauthorized - Invalid credentials');
    });

    it('should throw error when token response has no access_token', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { error: 'invalid_grant' };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockTokenResponse)
      });

      await expect(executeWorkdayQuery(mockConfig, mockQuery))
        .rejects.toThrow('Unable to generate bearer token!');
    });

    it('should throw error when query request fails', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: jest.fn().mockResolvedValue('Invalid query syntax')
        });

      await expect(executeWorkdayQuery(mockConfig, mockQuery))
        .rejects.toThrow('Workday API error: 400 Bad Request - Invalid query syntax');
    });

    it('should construct correct URLs for token and query requests', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = { data: [] };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      await executeWorkdayQuery(mockConfig, mockQuery);

      // Check token request
      expect(global.fetch).toHaveBeenNthCalledWith(1,
        'https://test.workday.com/ccx/oauth2/test-tenant/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Basic ')
          }),
          body: expect.any(URLSearchParams)
        })
      );

      // Check query request
      expect(global.fetch).toHaveBeenNthCalledWith(2,
        expect.stringContaining('https://test.workday.com/api/wql/v1/test-tenant/data?query='),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer mock-access-token',
            'Accept': 'application/json'
          })
        })
      );
    });
  });

  describe('getSupplierInvoiceWithAttachments', () => {
    const mockContext = {
      workdayConfig: {
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token'
      },
      s3Config: {
        bucketName: 'test-bucket'
      }
    };

    const mockWorkdayID = 'test-workday-id';

    beforeEach(() => {
      // Mock process.cwd to return a predictable path
      Object.defineProperty(process, 'cwd', {
        value: jest.fn(() => '/test/path'),
        writable: true
      });

      // Mock fetch for OAuth token
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ access_token: 'mock-access-token' })
      });
    });

    it('should handle SOAP client creation error', async () => {
      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(new Error('WSDL not found'), null);
      });

      await expect(getSupplierInvoiceWithAttachments(mockContext, mockWorkdayID))
        .rejects.toThrow('WSDL not found');
    });

    it('should handle SOAP request error', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(new Error('SOAP request failed'), null);
      });

      await expect(getSupplierInvoiceWithAttachments(mockContext, mockWorkdayID))
        .rejects.toThrow('SOAP request failed');
    });

    it('should handle missing invoice in response', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      // Mock response without Supplier_Invoice
      const mockResponse = {
        Response_Data: {}
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockResponse);
      });

      await expect(getSupplierInvoiceWithAttachments(mockContext, mockWorkdayID))
        .rejects.toThrow(`No invoice found for workdayID: ${mockWorkdayID}`);
    });

    it('should process invoice with attachments successfully', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      // Mock response with invoice and attachment (OAuth structure with arrays)
      const mockResponse = {
        Response_Data: {
          Supplier_Invoice: [
            {
              Supplier_Invoice_Data: [
                {
                  Invoice_ID: 'INV-001',
                  Attachment_Data: {
                    $attributes: {
                      Filename: 'test.pdf',
                      Content_Type: 'application/pdf'
                    },
                    File_Content: 'JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9Db2x'
                  }
                }
              ]
            }
          ]
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockResponse);
      });

      const result = await getSupplierInvoiceWithAttachments(mockContext, mockWorkdayID);
      const { uploadAttachmentToS3 } = require('../lib/s3.js');

      expect(result.invoice).toEqual({
        Invoice_ID: 'INV-001',
        Attachment_Data: {
          $attributes: {
            Filename: 'test.pdf',
            Content_Type: 'application/pdf'
          },
          File_Content: 'JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9Db2x'
        }
      });
      expect(result.presignedAttachments).toBeDefined();
      expect(uploadAttachmentToS3).toHaveBeenCalledTimes(1);
    });

    it('should handle invoice without attachments', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      // Mock response with invoice but no attachments (OAuth structure with arrays)
      const mockResponse = {
        Response_Data: {
          Supplier_Invoice: [
            {
              Supplier_Invoice_Data: [
                {
                  Invoice_ID: 'INV-001'
                }
              ]
            }
          ]
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockResponse);
      });

      const result = await getSupplierInvoiceWithAttachments(mockContext, mockWorkdayID);

      expect(result.invoice).toEqual({
        Invoice_ID: 'INV-001'
      });
      expect(result.presignedAttachments).toEqual([]);
    });
  });

  describe('submitSupplierInvoiceUpdate', () => {
    const mockContext = {
      workdayConfig: {
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token'
      }
    };

    const mockInvoiceWorkdayID = 'invoice-wid';
    const mockSupplierID = 'abc123supplierWID';
    const submitSupplierInvoiceUpdateForTest = (overrides: Partial<Parameters<typeof submitSupplierInvoiceUpdate>[1]> = {}) => submitSupplierInvoiceUpdate(mockContext, {
      invoiceWorkdayID: mockInvoiceWorkdayID,
      supplierWID: mockSupplierID,
      buildNotes: () => '',
      ...overrides
    });

    beforeEach(() => {
      Object.defineProperty(process, 'cwd', {
        value: jest.fn(() => '/test/path'),
        writable: true
      });

      delete process.env.FALLBACK_PAYMENT_TERMS_ID;
      delete process.env.FALLBACK_FUND_ID;
      delete process.env.FALLBACK_COST_CENTER_ID;
      delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
      delete process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
      delete process.env.FALLBACK_SPEND_CATEGORY_ID;

      // Mock fetch for OAuth token
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ access_token: 'mock-access-token' })
      });

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      proposeWorkdaySubmitRepair.mockResolvedValue({
        decision: 'give_up',
        reason: 'No safe repair available',
        supplierMode: 'preserve'
      });
    });

    it('should throw error when invoice not found', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockResponse = {
        Response_Data: {}
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockResponse);
      });

      await expect(submitSupplierInvoiceUpdateForTest())
        .rejects.toThrow(`No invoice found for workdayID: ${mockInvoiceWorkdayID}`);
    });

    it('should handle SOAP update error', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      // Mock successful getSupplierInvoice
      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(new Error('Update failed'), null);
      });

      await expect(submitSupplierInvoiceUpdateForTest())
        .rejects.toThrow('Update failed');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
    });

    it('should retry invoice date validation faults with the default invoice date', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-02-21T12:00:00Z'));

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);

        if (capturedRequests.length === 1) {
          callback({
            Validation_Fault: {
              Validation_Error: {
                Message: 'The entered information does not meet the restrictions defined for this field.',
                Detail_Message: 'The invoice date must be the first day of the month.',
                Xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Date'
              }
            }
          }, null);
          return;
        }

        callback(null, { Response_Data: { success: true } });
      });

      const result = await submitSupplierInvoiceUpdateForTest({
        invoiceDate: '2025-02-15'
      });

      expect(result.success).toBe(true);
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(2);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-02-15');
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-02-01');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      const { classifyWorkdayValidationField } = require('../lib/workday_validation_field_agent.js');
      expect(classifyWorkdayValidationField).toHaveBeenCalledWith({
        validation: {
          message: 'The entered information does not meet the restrictions defined for this field.',
          detailMessage: 'The invoice date must be the first day of the month.',
          xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Date'
        },
        allowedRetryFields: ['invoiceDate']
      });
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('should not repair-retry validation faults when that field already uses a fallback value', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-02-21T12:00:00Z'));

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(new Error('Validation_Fault: invoice date is invalid'), null);
      });

      await expect(
        submitSupplierInvoiceUpdateForTest()
      ).rejects.toThrow('Validation_Fault: invoice date is invalid');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      const { classifyWorkdayValidationField } = require('../lib/workday_validation_field_agent.js');
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(1);
      expect(classifyWorkdayValidationField).not.toHaveBeenCalled();
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('should retry payment terms validation faults with fallback payment terms', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const existingPaymentTerms = { ID: [{ $attributes: { type: 'WID' }, $value: 'existing-payment-terms-wid' }] };
      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Payment_Terms_Reference: existingPaymentTerms
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);

        if (capturedRequests.length === 1) {
          callback(new Error('Validation_Fault: payment terms are invalid'), null);
          return;
        }

        callback(null, { Response_Data: { success: true } });
      });

      process.env.FALLBACK_PAYMENT_TERMS_ID = 'fallback-payment-terms-id';

      const result = await submitSupplierInvoiceUpdateForTest({
        invoiceDate: '2025-02-15'
      });

      expect(result.success).toBe(true);
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(2);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toEqual(existingPaymentTerms);
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toEqual({
        ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'fallback-payment-terms-id' }]
      });

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
    });

    it('should retry only the failing non-fallback field when another field already uses a fallback', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-02-21T12:00:00Z'));

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);

        if (capturedRequests.length === 1) {
          callback(new Error('Validation_Fault: supplier is invalid'), null);
          return;
        }

        callback(null, { Response_Data: { success: true } });
      });

      process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'default-supplier-wid';

      const result = await submitSupplierInvoiceUpdateForTest();

      expect(result.success).toBe(true);
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(2);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-02-01');
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-02-01');
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Supplier_Reference.ID[0].$value).toBe(mockSupplierID);
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Supplier_Reference.ID[0].$value).toBe('default-supplier-wid');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('should repeat field-specific fallback retries for new validation fields up to three attempts', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const existingPaymentTerms = { ID: [{ $attributes: { type: 'WID' }, $value: 'existing-payment-terms-wid' }] };
      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Payment_Terms_Reference: existingPaymentTerms
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);

        if (capturedRequests.length === 1) {
          callback(new Error('Validation_Fault: supplier is invalid'), null);
          return;
        }

        if (capturedRequests.length === 2) {
          callback(new Error('Validation_Fault: payment terms are invalid'), null);
          return;
        }

        callback(null, { Response_Data: { success: true } });
      });

      process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'default-supplier-wid';
      process.env.FALLBACK_PAYMENT_TERMS_ID = 'fallback-payment-terms-id';

      const result = await submitSupplierInvoiceUpdateForTest({
        invoiceDate: '2025-02-15'
      });

      expect(result.success).toBe(true);
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(3);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Supplier_Reference.ID[0].$value).toBe(mockSupplierID);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toEqual(existingPaymentTerms);
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Supplier_Reference.ID[0].$value).toBe('default-supplier-wid');
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toEqual(existingPaymentTerms);
      expect(capturedRequests[2].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Supplier_Reference.ID[0].$value).toBe('default-supplier-wid');
      expect(capturedRequests[2].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toEqual({
        ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'fallback-payment-terms-id' }]
      });
    });

    it('should rethrow validation faults after a fallback retry fails', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-03-21T12:00:00Z'));

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);
        callback(new Error('Validation_Fault: invoice date must be valid'), null);
      });

      await expect(
        submitSupplierInvoiceUpdateForTest({
          invoiceDate: '2025-03-15'
        })
      ).rejects.toThrow('Validation_Fault: invoice date must be valid');

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(2);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-03-15');
      expect(capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-03-01');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('should not retry validation faults without a matching configured fallback field', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);
        callback(new Error('Validation_Fault: duplicate payload should not be retried'), null);
      });

      await expect(
        submitSupplierInvoiceUpdateForTest({
          invoiceDate: '2025-04-15'
        })
      ).rejects.toThrow('Validation_Fault: duplicate payload should not be retried');

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(1);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2025-04-15');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
    });

    it('should update supplier successfully', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      // Mock successful getSupplierInvoice
      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Payment_Terms_Reference: { ID: 'payment-terms-wid' }
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const mockSubmitResponse = {
        Response_Data: { success: true }
      };

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, mockSubmitResponse);
      });

      const extractedInvoiceDate = '2025-02-15';
      const result = await submitSupplierInvoiceUpdateForTest({
        invoiceDate: extractedInvoiceDate
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain(mockInvoiceWorkdayID);
      expect(result.message).toContain(mockSupplierID);

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Reference: expect.objectContaining({
              ID: expect.arrayContaining([
                expect.objectContaining({
                  $attributes: { type: 'WID' },
                  $value: mockInvoiceWorkdayID
                })
              ])
            }),
            Supplier_Invoice_Data: expect.objectContaining({
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: extractedInvoiceDate,
              Invoice_Number: '12345',
              Control_Amount_Total: '100.00',
              Supplier_Reference: expect.objectContaining({
                ID: expect.arrayContaining([
                  expect.objectContaining({
                    $attributes: { type: 'WID' },
                    $value: mockSupplierID
                  })
                ])
              })
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should default invoice date to the first day of the current month when document date is unavailable', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-21T12:00:00Z'));

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2026-04-01');

      jest.useRealTimers();
    });

    it('should preserve optional fields when present', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Payment_Terms_Reference: { ID: 'payment-terms-wid' },
              Due_Date_Override: '2024-02-01',
              Default_Tax_Option_Reference: { ID: 'tax-option-wid' }
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Data: expect.objectContaining({
              Payment_Terms_Reference: { ID: 'payment-terms-wid' },
              Due_Date_Override: '2024-02-01',
              Tax_Amount: 0,
              Default_Tax_Option_Reference: { ID: [{ $attributes: { type: 'Tax_Option_ID' }, $value: 'ENTER_TAX_DUE' }] }
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should include work queue tag when environment variable is set', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: { success: true } });
      });

      process.env.WORKDAY_AGENT_MODIFIED_TAG_WID = 'test-work-queue-tag-wid';

      await submitSupplierInvoiceUpdateForTest();

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Data: expect.objectContaining({
              Work_Queue_Information_Data: expect.objectContaining({
                Work_Queue_Tags_Reference: expect.arrayContaining([
                  expect.objectContaining({
                    ID: expect.arrayContaining([
                      expect.objectContaining({
                        $attributes: { type: 'Work_Queue_Tag_ID' },
                        $value: 'test-work-queue-tag-wid'
                      })
                    ])
                  })
                ])
              })
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should include memo when provided', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: { success: true } });
      });

      const testNotes = 'AI Agent found matching supplier';
      const testMemo = 'Office supplies for March 2024';

      await submitSupplierInvoiceUpdateForTest({
        buildNotes: () => testNotes,
        memo: testMemo
      });

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Data: expect.objectContaining({
              Memo: testMemo,
              Work_Queue_Information_Data: expect.objectContaining({
                Work_Queue_Notes: `FINANCE AGENT:\n${testNotes}`
              })
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should not include memo when not provided', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Memo).toBeUndefined();
    });

    it('should preserve existing memo when invoice already has one', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const existingMemo = 'Existing memo from user';
      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Memo: existingMemo
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: { success: true } });
      });

      const aiMemo = 'AI extracted memo';
      await submitSupplierInvoiceUpdateForTest({
        memo: aiMemo
      });

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Data: expect.objectContaining({
              Memo: existingMemo
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should include completed invoice lines in submit', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const completedLine = {
        Supplier_Invoice_Line_ID: 'LINE-1',
        Item_Description: 'Item 1',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'CAT-1' }] },
        Worktags_Reference: { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'CC-100' }] },
        Quantity: '1',
        Unit_Cost: '100',
        Extended_Amount: '100'
      };

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Invoice_Line_Replacement_Data: [completedLine]
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Data: expect.objectContaining({
              Invoice_Line_Replacement_Data: [
                expect.objectContaining({
                  Supplier_Invoice_Line_ID: 'LINE-1',
                  Worktags_Reference: [completedLine.Worktags_Reference]
                })
              ]
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should apply default OCR spend category to incomplete lines missing a spend category', async () => {
      process.env.FALLBACK_SPEND_CATEGORY_ID = 'DEFAULT-SPEND-CAT';

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const incompleteLine = {
        Supplier_Invoice_Line_ID: 'LINE-1',
        Item_Description: 'OCR Item',
        Quantity: '1',
        Unit_Cost: '100',
        Extended_Amount: '100'
        // No Spend_Category_Reference, Item_Reference, or Worktags_Reference
      };

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Invoice_Line_Replacement_Data: [incompleteLine]
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      delete process.env.FALLBACK_SPEND_CATEGORY_ID;

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data).toEqual([
        expect.objectContaining({
          Supplier_Invoice_Line_ID: 'LINE-1',
          Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'DEFAULT-SPEND-CAT' }] }
        })
      ]);
    });

    it('should apply default OCR spend category to incomplete lines while preserving existing categories', async () => {
      process.env.FALLBACK_SPEND_CATEGORY_ID = 'DEFAULT-SPEND-CAT';

      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const completedLine = {
        Supplier_Invoice_Line_ID: 'LINE-1',
        Item_Description: 'Coded Item',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'CAT-1' }] },
        Worktags_Reference: { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'CC-100' }] },
        Quantity: '1',
        Unit_Cost: '100',
        Extended_Amount: '100'
      };

      const incompleteLine = {
        Supplier_Invoice_Line_ID: 'LINE-2',
        Item_Description: 'OCR Item',
        Quantity: '2',
        Unit_Cost: '50',
        Extended_Amount: '100'
        // No Spend_Category_Reference, Item_Reference, or Worktags_Reference
      };

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '200.00',
              Invoice_Line_Replacement_Data: [completedLine, incompleteLine]
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      delete process.env.FALLBACK_SPEND_CATEGORY_ID;

      const lines = capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        Supplier_Invoice_Line_ID: 'LINE-1',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'CAT-1' }] }
      });
      expect(lines[1]).toMatchObject({
        Supplier_Invoice_Line_ID: 'LINE-2',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'DEFAULT-SPEND-CAT' }] }
      });
    });

    it('should not apply fallback payment terms unless payment terms validation fails', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      process.env.FALLBACK_PAYMENT_TERMS_ID = 'fallback-payment-terms-id';
      await submitSupplierInvoiceUpdateForTest();
      delete process.env.FALLBACK_PAYMENT_TERMS_ID;

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toBeUndefined();
    });

    it('should not override existing payment terms with fallback', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const existingPaymentTerms = { ID: [{ $attributes: { type: 'WID' }, $value: 'existing-payment-terms-wid' }] };
      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Payment_Terms_Reference: existingPaymentTerms
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      process.env.FALLBACK_PAYMENT_TERMS_ID = 'fallback-payment-terms-wid';
      await submitSupplierInvoiceUpdateForTest();
      delete process.env.FALLBACK_PAYMENT_TERMS_ID;

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Payment_Terms_Reference).toEqual(existingPaymentTerms);
    });

    it('should apply fallback worktags on first submission when line is missing those worktag types', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const line = {
        Supplier_Invoice_Line_ID: 'LINE-1',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'CAT-1' }] },
        Extended_Amount: '100'
        // No Worktags_Reference
      };

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Invoice_Line_Replacement_Data: [line]
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      process.env.FALLBACK_FUND_ID = 'fallback-fund-id';
      process.env.FALLBACK_COST_CENTER_ID = 'fallback-cost-center-id';
      await submitSupplierInvoiceUpdateForTest();
      delete process.env.FALLBACK_FUND_ID;
      delete process.env.FALLBACK_COST_CENTER_ID;

      const submittedLine = capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data[0];
      expect(submittedLine.Worktags_Reference).toEqual([
        { ID: [{ $attributes: { type: 'Fund_ID' }, $value: 'fallback-fund-id' }] },
        { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'fallback-cost-center-id' }] }
      ]);
    });

    it('should only apply fallback for worktag types that are absent from the line', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const existingFundWorktag = {
        ID: [
          { $attributes: { type: 'WID' }, $value: 'existing-fund-wid' },
          { $attributes: { type: 'Fund_ID' }, $value: 'existing-fund-id' }
        ]
      };
      const line = {
        Supplier_Invoice_Line_ID: 'LINE-1',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'CAT-1' }] },
        Worktags_Reference: [existingFundWorktag],
        Extended_Amount: '100'
      };

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00',
              Invoice_Line_Replacement_Data: [line]
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      process.env.FALLBACK_FUND_ID = 'fallback-fund-id';
      process.env.FALLBACK_COST_CENTER_ID = 'fallback-cost-center-id';
      await submitSupplierInvoiceUpdateForTest();
      delete process.env.FALLBACK_FUND_ID;
      delete process.env.FALLBACK_COST_CENTER_ID;

      const submittedLine = capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data[0];
      expect(submittedLine.Worktags_Reference).toEqual([
        existingFundWorktag,
        { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'fallback-cost-center-id' }] }
      ]);
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(1);
    });

    describe('finalLines', () => {
      const mockBaseGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '500.00'
            }
          }
        }
      };

      const setupMockClient = () => {
        const mockClient = {
          setSecurity: jest.fn(),
          setEndpoint: jest.fn(),
          Get_Supplier_Invoices: jest.fn(),
          Submit_Supplier_Invoice: jest.fn()
        };
        const { soap } = require('strong-soap');
        soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
          callback(null, mockClient);
        });
        mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
          callback(null, mockBaseGetResponse);
        });
        let capturedRequest: any;
        mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
          capturedRequest = request;
          callback(null, { Response_Data: { success: true } });
        });
        return { mockClient, getCapturedRequest: () => capturedRequest };
      };

      it('should build invoice lines from finalLines with all worktags applied', async () => {
        const { getCapturedRequest } = setupMockClient();

        await submitSupplierInvoiceUpdateForTest({
          finalLines: [
            { lineOrder: 1, description: 'Consulting Services', quantity: 5, unitCost: 200, extendedAmount: 1000, fundId: 'FUND-001', costCenterId: 'CC-001', spendCategoryId: 'SC-001' }
          ]
        });

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines).toHaveLength(1);
        expect(lines[0]).toEqual({
          Line_Order: 1,
          Item_Description: 'Consulting Services',
          Quantity: 5,
          Unit_Cost: 200,
          Extended_Amount: 1000,
          Worktags_Reference: [
            { ID: [{ $attributes: { type: 'Fund_ID' }, $value: 'FUND-001' }] },
            { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'CC-001' }] }
          ],
          Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'SC-001' }] }
        });
      });

      it('should use Line_Order from finalLines for each line', async () => {
        const { getCapturedRequest } = setupMockClient();

        await submitSupplierInvoiceUpdateForTest({
          finalLines: [
            { lineOrder: 1, description: 'Line A', quantity: 1, unitCost: 100, extendedAmount: 100 },
            { lineOrder: 2, description: 'Line B', quantity: 2, unitCost: 50, extendedAmount: 100 },
            { lineOrder: 3, description: 'Line C', quantity: null, unitCost: null, extendedAmount: null }
          ]
        });

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines).toHaveLength(3);
        expect(lines[0].Line_Order).toBe(1);
        expect(lines[1].Line_Order).toBe(2);
        expect(lines[2].Line_Order).toBe(3);
      });

      it('should omit optional fields when null', async () => {
        const { getCapturedRequest } = setupMockClient();

        await submitSupplierInvoiceUpdateForTest({
          finalLines: [{ lineOrder: 1, description: 'Simple Service', quantity: null, unitCost: null, extendedAmount: null }]
        });

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines[0]).toEqual({ Line_Order: 1, Item_Description: 'Simple Service', Quantity: 1 });
        expect(lines[0].Unit_Cost).toBeUndefined();
        expect(lines[0].Extended_Amount).toBeUndefined();
        expect(lines[0].Worktags_Reference).toBeUndefined();
        expect(lines[0].Spend_Category_Reference).toBeUndefined();
        expect(lines[0].Purchase_Order_Line_Reference).toBeUndefined();
      });

      it('should set Quantity and Unit_Cost to 0 for discount lines without a PO line', async () => {
        const { getCapturedRequest } = setupMockClient();

        await submitSupplierInvoiceUpdateForTest({
          finalLines: [{ lineOrder: 1, description: 'Discount', hasDiscount: true, quantity: null, unitCost: null, extendedAmount: -50 }]
        });

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines[0].Quantity).toBe(0);
        expect(lines[0].Unit_Cost).toBe(0);
        expect(lines[0].Extended_Amount).toBe(-50);
      });

      it('should use non-zero quantity for discount lines linked to a PO line', async () => {
        const { getCapturedRequest } = setupMockClient();

        await submitSupplierInvoiceUpdateForTest({
          finalLines: [{ lineOrder: 1, description: 'Discount', hasDiscount: true, quantity: null, unitCost: null, extendedAmount: -50, purchaseOrderLineId: 'POL-001' }]
        });

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines[0].Quantity).toBe(1);
        expect(lines[0].Extended_Amount).toBe(-50);
      });

      it('should include Purchase_Order_Line_Reference when purchaseOrderLineId is present', async () => {
        const { getCapturedRequest } = setupMockClient();

        await submitSupplierInvoiceUpdateForTest({
          finalLines: [{ lineOrder: 1, description: 'Consulting Services', quantity: 1, unitCost: 500, extendedAmount: 500, purchaseOrderLineId: 'POL-001' }]
        });

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines[0].Purchase_Order_Line_Reference).toEqual({
          ID: [{ $attributes: { type: 'Purchase_Order_Line_ID' }, $value: 'POL-001' }]
        });
      });

      it('should append fallback worktags to finalLines missing those worktag types', async () => {
        const { getCapturedRequest } = setupMockClient();

        process.env.FALLBACK_COST_CENTER_ID = 'fallback-cc-id';
        await submitSupplierInvoiceUpdateForTest({
          finalLines: [{ lineOrder: 1, description: 'Service', quantity: 1, unitCost: 100, extendedAmount: 100, fundId: 'FUND-001' }]
        });
        delete process.env.FALLBACK_COST_CENTER_ID;

        const lines = getCapturedRequest().Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data;
        expect(lines[0].Worktags_Reference).toEqual([
          { ID: [{ $attributes: { type: 'Fund_ID' }, $value: 'FUND-001' }] },
          { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'fallback-cc-id' }] }
        ]);
      });

      it('should replace cost center with fallback on worktag validation fault retry', async () => {
        const mockClient = {
          setSecurity: jest.fn(),
          setEndpoint: jest.fn(),
          Get_Supplier_Invoices: jest.fn(),
          Submit_Supplier_Invoice: jest.fn()
        };
        const { soap } = require('strong-soap');
        soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
          callback(null, mockClient);
        });
        mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
          callback(null, mockBaseGetResponse);
        });

        const capturedRequests: any[] = [];
        mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
          capturedRequests.push(request);
          if (capturedRequests.length === 1) {
            callback({
              Validation_Fault: {
                Validation_Error: {
                  Message: 'When "Cost Center: CC-Technology Services" is entered then these worktag types must also have a value: Line of Business.',
                  Detail_Message: 'Worktags_for_Procurement_Webservices--IS Restricted by Supplier Invoice Line Replacement Data',
                  Xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[1]/wd:Worktags_Reference'
                }
              }
            }, null);
            return;
          }
          callback(null, { Response_Data: { success: true } });
        });

        process.env.FALLBACK_COST_CENTER_ID = 'fallback-cc-id';
        const result = await submitSupplierInvoiceUpdateForTest({
          finalLines: [
            { lineOrder: 1, description: 'Service', quantity: 1, unitCost: 10980, extendedAmount: 10980, fundId: 'FUND-General_Fund_Unrestricted', costCenterId: 'CC-Technology_Services', spendCategoryId: 'SC-Contingent_Workers' }
          ]
        });
        delete process.env.FALLBACK_COST_CENTER_ID;

        expect(result.success).toBe(true);
        expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(2);

        const firstLine = capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data[0];
        expect(firstLine.Worktags_Reference).toEqual([
          { ID: [{ $attributes: { type: 'Fund_ID' }, $value: 'FUND-General_Fund_Unrestricted' }] },
          { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'CC-Technology_Services' }] }
        ]);

        const retryLine = capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data[0];
        expect(retryLine.Worktags_Reference).toEqual([
          { ID: [{ $attributes: { type: 'Fund_ID' }, $value: 'FUND-General_Fund_Unrestricted' }] },
          { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'fallback-cc-id' }] }
        ]);
      });

    });

    it('should not include Purchase_Order_Reference when purchaseOrderNumber is not provided', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Purchase_Order_Reference).toBeUndefined();
    });

  });

  describe('parsePurchaseOrderLines', () => {
    const makeWorktag = (type: string, value: string) => ({
      ID: [
        { $attributes: { type: 'WID' }, $value: `wid-${value}` },
        { $attributes: { type }, $value: value }
      ]
    });

    const makePoResponse = (serviceLineData: any) => ({
      Response_Data: {
        Purchase_Order: {
          Purchase_Order_Data: {
            Document_Number: 'PO-404770',
            Service_Line_Data: serviceLineData
          }
        }
      }
    });

    it('should parse a single service line', () => {
      const response = makePoResponse({
        Line_Number: 1,
        Description: 'Design/Mapping Services for the 2025 PGA Championship',
        Resource_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'SC-Design_Mapping' }] },
        Extended_Amount: 653000,
        Worktags_Reference: [
          makeWorktag('Fund_ID', 'FUND-General_Fund_Unrestricted'),
          makeWorktag('Cost_Center_Reference_ID', 'CC-2025_PGA_Championship')
        ]
      });

      const lines = parsePurchaseOrderLines(response);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        purchaseOrderDocumentNumber: 'PO-404770',
        purchaseOrderLineId: undefined,
        lineOrder: 1,
        description: 'Design/Mapping Services for the 2025 PGA Championship',
        spendCategoryReference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'SC-Design_Mapping' }] },
        extendedAmount: 653000,
        worktagsReference: [
          makeWorktag('Fund_ID', 'FUND-General_Fund_Unrestricted'),
          makeWorktag('Cost_Center_Reference_ID', 'CC-2025_PGA_Championship')
        ],
        shipToAddressId: null,
      });
    });

    it('should parse multiple service lines', () => {
      const response = makePoResponse([
        {
          Line_Number: 1,
          Description: 'Line 1',
          Resource_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'SC-A' }] },
          Extended_Amount: 10000,
          Worktags_Reference: [makeWorktag('Fund_ID', 'FUND-A')]
        },
        {
          Line_Number: 2,
          Description: 'Line 2',
          Resource_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'SC-B' }] },
          Extended_Amount: 20000,
          Worktags_Reference: [makeWorktag('Cost_Center_Reference_ID', 'CC-B')]
        }
      ]);

      const lines = parsePurchaseOrderLines(response);

      expect(lines).toHaveLength(2);
      expect(lines[0].lineOrder).toBe(1);
      expect(lines[0].extendedAmount).toBe(10000);
      expect(lines[1].lineOrder).toBe(2);
      expect(lines[1].extendedAmount).toBe(20000);
    });

    it('should handle Purchase_Order as an array', () => {
      const response = {
        Response_Data: {
          Purchase_Order: [
            {
              Purchase_Order_Data: {
                Service_Line_Data: {
                  Line_Number: 1,
                  Description: 'Single line',
                  Extended_Amount: 5000,
                  Worktags_Reference: []
                }
              }
            }
          ]
        }
      };

      const lines = parsePurchaseOrderLines(response);

      expect(lines).toHaveLength(1);
      expect(lines[0].lineOrder).toBe(1);
      expect(lines[0].description).toBe('Single line');
    });

    it('should return empty array when Response_Data is missing', () => {
      expect(parsePurchaseOrderLines({})).toEqual([]);
      expect(parsePurchaseOrderLines(null)).toEqual([]);
      expect(parsePurchaseOrderLines(undefined)).toEqual([]);
    });

    it('should return empty array when Purchase_Order_Data is missing', () => {
      const response = { Response_Data: { Purchase_Order: {} } };
      expect(parsePurchaseOrderLines(response)).toEqual([]);
    });

    it('should return empty array when no service lines exist', () => {
      const response = makePoResponse(undefined);
      expect(parsePurchaseOrderLines(response)).toEqual([]);
    });

    it('should handle a line with no worktags', () => {
      const response = makePoResponse({
        Line_Number: 1,
        Description: 'No worktags line',
        Extended_Amount: 100
      });

      const lines = parsePurchaseOrderLines(response);

      expect(lines).toHaveLength(1);
      expect(lines[0].worktagsReference).toEqual([]);
    });

    it('should handle a line with a single Worktags_Reference object (not array)', () => {
      const singleWorktag = makeWorktag('Fund_ID', 'FUND-A');
      const response = makePoResponse({
        Line_Number: 1,
        Extended_Amount: 100,
        Worktags_Reference: singleWorktag
      });

      const lines = parsePurchaseOrderLines(response);

      expect(lines[0].worktagsReference).toEqual([singleWorktag]);
    });

    it('should handle a line missing optional fields', () => {
      const response = makePoResponse({ Line_Number: 3 });

      const lines = parsePurchaseOrderLines(response);

      expect(lines).toHaveLength(1);
      expect(lines[0].lineOrder).toBe(3);
      expect(lines[0].description).toBeUndefined();
      expect(lines[0].spendCategoryReference).toBeUndefined();
      expect(lines[0].extendedAmount).toBeUndefined();
      expect(lines[0].worktagsReference).toEqual([]);
    });
  });

  describe('annotateSupplierInvoice', () => {
    const mockContext = {
      workdayConfig: {
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token'
      }
    };

    const mockInvoiceWorkdayID = 'invoice-wid';

    beforeEach(() => {
      Object.defineProperty(process, 'cwd', {
        value: jest.fn(() => '/test/path'),
        writable: true
      });

      delete process.env.FALLBACK_PAYMENT_TERMS_ID;
      delete process.env.FALLBACK_FUND_ID;
      delete process.env.FALLBACK_COST_CENTER_ID;
      delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
      delete process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
      delete process.env.FALLBACK_SPEND_CATEGORY_ID;

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ access_token: 'mock-access-token' })
      });
    });

    it('should not fallback-retry validation faults when only annotating invoice data', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-01-01',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);
        callback(new Error('Validation_Fault: spend category is required'), null);
      });

      await expect(
        annotateSupplierInvoice(mockContext, {
          invoiceWorkdayID: mockInvoiceWorkdayID,
          notes: 'notes only'
        })
      ).rejects.toThrow('Validation_Fault: spend category is required');

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(1);
      expect(capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2024-01-01');

      const { proposeWorkdaySubmitRepair } = require('../lib/workday_submit_repair.js');
      expect(proposeWorkdaySubmitRepair).not.toHaveBeenCalled();
    });

    it('should use the existing invoice date from Workday, not default to first of month', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: '2024-03-15',
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await annotateSupplierInvoice(mockContext, { invoiceWorkdayID: mockInvoiceWorkdayID });

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2024-03-15');
    });

    it('should throw instead of defaulting when annotating an invoice without an existing invoice date', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      await expect(
        annotateSupplierInvoice(mockContext, { invoiceWorkdayID: mockInvoiceWorkdayID })
      ).rejects.toThrow(`Current invoice date is required to annotate invoice ${mockInvoiceWorkdayID} without changing its date`);

      expect(mockClient.Submit_Supplier_Invoice).not.toHaveBeenCalled();
    });

    it('should use the existing invoice date when it is a Date object from the SOAP library', async () => {
      const mockClient = {
        setSecurity: jest.fn(),
        setEndpoint: jest.fn(),
        Get_Supplier_Invoices: jest.fn(),
        Submit_Supplier_Invoice: jest.fn()
      };

      const { soap } = require('strong-soap');
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      const mockGetResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_Number: '12345',
              Company_Reference: { ID: 'company-wid' },
              Currency_Reference: { ID: 'USD' },
              Invoice_Date: new Date('2024-03-15T00:00:00.000Z'),
              Control_Amount_Total: '100.00'
            }
          }
        }
      };

      mockClient.Get_Supplier_Invoices.mockImplementation((_request: any, callback: any) => {
        callback(null, mockGetResponse);
      });

      let capturedRequest: any;
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequest = request;
        callback(null, { Response_Data: { success: true } });
      });

      await annotateSupplierInvoice(mockContext, { invoiceWorkdayID: mockInvoiceWorkdayID });

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Date).toBe('2024-03-15');
    });
  });

  describe('getAllPaymentTerms', () => {
    const mockContext = {
      workdayConfig: {
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token'
      }
    };

    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ access_token: 'mock-access-token' })
      });
    });

    it('should parse payment terms from Response_Data.Payment_Term array', async () => {
      const { soap } = require('strong-soap');
      const mockClient = { setSecurity: jest.fn(), setEndpoint: jest.fn(), Get_Payment_Terms: jest.fn() };
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      mockClient.Get_Payment_Terms.mockImplementation((_request: any, callback: any) => {
        callback(null, {
          Response_Data: {
            Payment_Term: [
              {
                Payment_Term_Reference: { ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'NET_30' }] },
                Payment_Term_Data: { Payment_Terms_Name: 'Net 30' }
              },
              {
                Payment_Term_Reference: { ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'NET_60' }] },
                Payment_Term_Data: { Payment_Terms_Name: 'Net 60' }
              }
            ]
          }
        });
      });

      const result = await getAllPaymentTerms(mockContext);

      expect(result).toEqual([
        { paymentTermsId: 'NET_30', name: 'Net 30' },
        { paymentTermsId: 'NET_60', name: 'Net 60' }
      ]);
    });

    it('should handle a single Payment_Term object (non-array) via concat normalisation', async () => {
      const { soap } = require('strong-soap');
      const mockClient = { setSecurity: jest.fn(), setEndpoint: jest.fn(), Get_Payment_Terms: jest.fn() };
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      mockClient.Get_Payment_Terms.mockImplementation((_request: any, callback: any) => {
        callback(null, {
          Response_Data: {
            Payment_Term: {
              Payment_Term_Reference: { ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'NET_30' }] },
              Payment_Term_Data: { Payment_Terms_Name: 'Net 30' }
            }
          }
        });
      });

      const result = await getAllPaymentTerms(mockContext);

      expect(result).toEqual([{ paymentTermsId: 'NET_30', name: 'Net 30' }]);
    });

    it('should return empty array when Response_Data has no Payment_Term', async () => {
      const { soap } = require('strong-soap');
      const mockClient = { setSecurity: jest.fn(), setEndpoint: jest.fn(), Get_Payment_Terms: jest.fn() };
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      mockClient.Get_Payment_Terms.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: {} });
      });

      const result = await getAllPaymentTerms(mockContext);

      expect(result).toEqual([]);
    });

    it('should skip entries missing paymentTermsId or name', async () => {
      const { soap } = require('strong-soap');
      const mockClient = { setSecurity: jest.fn(), setEndpoint: jest.fn(), Get_Payment_Terms: jest.fn() };
      soap.createClient.mockImplementation((_wsdlPath: any, _options: any, callback: any) => {
        callback(null, mockClient);
      });

      mockClient.Get_Payment_Terms.mockImplementation((_request: any, callback: any) => {
        callback(null, {
          Response_Data: {
            Payment_Term: [
              {
                Payment_Term_Reference: { ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'NET_30' }] },
                Payment_Term_Data: { Payment_Terms_Name: 'Net 30' }
              },
              {
                Payment_Term_Reference: { ID: [] },
                Payment_Term_Data: { Payment_Terms_Name: 'Missing ID' }
              },
              {
                Payment_Term_Reference: { ID: [{ $attributes: { type: 'Payment_Terms_ID' }, $value: 'NET_60' }] },
                Payment_Term_Data: {}
              }
            ]
          }
        });
      });

      const result = await getAllPaymentTerms(mockContext);

      expect(result).toEqual([{ paymentTermsId: 'NET_30', name: 'Net 30' }]);
    });
  });

});
