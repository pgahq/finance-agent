import { annotateSupplierInvoice, executeWorkdayQuery, getSupplierInvoiceWithAttachments, getWorkdayConfig, submitSupplierInvoiceUpdate } from '../lib/workday.js';

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

// Mock the pdf and s3 modules
jest.mock('../lib/pdf.js', () => ({
  processPdfAttachment: jest.fn().mockResolvedValue({
    originalFileName: 'test.pdf',
    images: []
  })
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

describe('Workday utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
          callback(new Error('Validation_Fault: invoice date must be the first day of the month'), null);
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
      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledTimes(1);
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
              Default_Tax_Option_Reference: { ID: 'tax-option-wid' }
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
        notes: testNotes,
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
              Invoice_Line_Replacement_Data: [completedLine]
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should exclude incomplete OCR lines and omit Invoice_Line_Replacement_Data when no completed lines exist', async () => {
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

      expect(capturedRequest.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data).toBeUndefined();
    });

    it('should include only completed lines and drop incomplete OCR lines when mixed', async () => {
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

      mockClient.Submit_Supplier_Invoice.mockImplementation((_request: any, callback: any) => {
        callback(null, { Response_Data: { success: true } });
      });

      await submitSupplierInvoiceUpdateForTest();

      expect(mockClient.Submit_Supplier_Invoice).toHaveBeenCalledWith(
        expect.objectContaining({
          Submit_Supplier_Invoice_Request: expect.objectContaining({
            Supplier_Invoice_Data: expect.objectContaining({
              Invoice_Line_Replacement_Data: [completedLine]
            })
          })
        }),
        expect.any(Function)
      );
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

    it('should not append fallback worktags unless worktag validation fails', async () => {
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
      expect(submittedLine.Worktags_Reference).toBeUndefined();
    });

    it('should append fallback worktags only after worktag validation fails', async () => {
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

      const existingWorktag = { ID: [{ $attributes: { type: 'Fund_ID' }, $value: 'fallback-fund-id' }] };
      const line = {
        Supplier_Invoice_Line_ID: 'LINE-1',
        Spend_Category_Reference: { ID: [{ $attributes: { type: 'Spend_Category_ID' }, $value: 'CAT-1' }] },
        Worktags_Reference: [existingWorktag],
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

      const capturedRequests: any[] = [];
      mockClient.Submit_Supplier_Invoice.mockImplementation((request: any, callback: any) => {
        capturedRequests.push(request);

        if (capturedRequests.length === 1) {
          callback(new Error('Validation_Fault: worktag cost center is required'), null);
          return;
        }

        callback(null, { Response_Data: { success: true } });
      });

      process.env.FALLBACK_FUND_ID = 'fallback-fund-id';
      process.env.FALLBACK_COST_CENTER_ID = 'fallback-cost-center-id';
      await submitSupplierInvoiceUpdateForTest();
      delete process.env.FALLBACK_FUND_ID;
      delete process.env.FALLBACK_COST_CENTER_ID;

      const firstSubmittedLine = capturedRequests[0].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data[0];
      const submittedLine = capturedRequests[1].Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Invoice_Line_Replacement_Data[0];
      expect(firstSubmittedLine.Worktags_Reference).toEqual([existingWorktag]);
      expect(submittedLine.Worktags_Reference).toEqual([
        existingWorktag,
        { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'fallback-cost-center-id' }] }
      ]);
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

});
