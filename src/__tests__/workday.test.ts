import { executeWorkdayQuery, getSupplierInvoiceWithAttachments, getWorkdayConfig, getWorkdaySoapConfig, updateSupplierInvoiceSupplier } from '../lib/workday.js';

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
    WSSecurity: jest.fn()
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

  describe('getWorkdaySoapConfig', () => {
    it('should extract SOAP configuration from environment variables', () => {
      const mockEnv = {
        WORKDAY_DOMAIN: 'test.workday.com',
        WORKDAY_TENANT: 'test-tenant',
        WORKDAY_USER: 'test-user',
        WORKDAY_PASSWORD: 'test-password',
      };

      const config = getWorkdaySoapConfig(mockEnv);

      expect(config).toEqual({
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        username: 'test-user',
        password: 'test-password',
      });
    });

    it('should handle missing environment variables', () => {
      const mockEnv = {};

      const config = getWorkdaySoapConfig(mockEnv);
      expect(config.domain).toBeUndefined();
      expect(config.tenant).toBeUndefined();
      expect(config.username).toBeUndefined();
      expect(config.password).toBeUndefined();
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
      workdaySoapConfig: {
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        username: 'test-user',
        password: 'test-password'
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
    });

    it('should throw error when password is missing', async () => {
      const contextWithoutPassword = {
        ...mockContext,
        workdaySoapConfig: {
          ...mockContext.workdaySoapConfig,
          password: undefined as any
        }
      };

      await expect(getSupplierInvoiceWithAttachments(contextWithoutPassword, mockWorkdayID))
        .rejects.toThrow('Workday SOAP password is not configured');
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

      // Mock response with invoice and attachment
      const mockResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_ID: 'INV-001',
              Attachment_Data: {
                $attributes: {
                  Filename: 'test.pdf',
                  Content_Type: 'application/pdf'
                },
                File_Content: 'JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9Db2x'
              }
            }
          }
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

      // Mock response with invoice but no attachments
      const mockResponse = {
        Response_Data: {
          Supplier_Invoice: {
            Supplier_Invoice_Data: {
              Invoice_ID: 'INV-001'
            }
          }
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

  describe('updateSupplierInvoiceSupplier', () => {
    const mockContext = {
      workdaySoapConfig: {
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        username: 'test-user',
        password: 'test-password'
      }
    };

    const mockInvoiceWorkdayID = 'invoice-wid';
    const mockSupplierWorkdayID = 'supplier-wid';

    beforeEach(() => {
      Object.defineProperty(process, 'cwd', {
        value: jest.fn(() => '/test/path'),
        writable: true
      });
    });

    it('should throw error when password is missing', async () => {
      const contextWithoutPassword = {
        ...mockContext,
        workdaySoapConfig: {
          ...mockContext.workdaySoapConfig,
          password: undefined as any
        }
      };

      await expect(updateSupplierInvoiceSupplier(contextWithoutPassword, mockInvoiceWorkdayID, mockSupplierWorkdayID))
        .rejects.toThrow('Workday SOAP password is not configured');
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

      await expect(updateSupplierInvoiceSupplier(mockContext, mockInvoiceWorkdayID, mockSupplierWorkdayID))
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

      await expect(updateSupplierInvoiceSupplier(mockContext, mockInvoiceWorkdayID, mockSupplierWorkdayID))
        .rejects.toThrow('Update failed');
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

      const result = await updateSupplierInvoiceSupplier(mockContext, mockInvoiceWorkdayID, mockSupplierWorkdayID);

      expect(result.success).toBe(true);
      expect(result.message).toContain(mockInvoiceWorkdayID);
      expect(result.message).toContain(mockSupplierWorkdayID);

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
              Invoice_Date: '2024-01-01',
              Invoice_Number: '12345',
              Control_Amount_Total: '100.00',
              Supplier_Reference: expect.objectContaining({
                ID: expect.arrayContaining([
                  expect.objectContaining({
                    $attributes: { type: 'WID' },
                    $value: mockSupplierWorkdayID
                  })
                ])
              })
            })
          })
        }),
        expect.any(Function)
      );
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

      await updateSupplierInvoiceSupplier(mockContext, mockInvoiceWorkdayID, mockSupplierWorkdayID);

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
  });

});
