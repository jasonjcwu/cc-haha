// Backward compatible types
interface ConfigV1 {
  host: string;
  port: number;
  useSSL: boolean;
}

// New extended config
interface ConfigV2 extends ConfigV1 {
  timeout?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
}

// Union type for both config versions
type ApiClientConfig = ConfigV1 | string | ConfigV2;

class ApiClient {
  private config: ConfigV2;
  private isStringConfig: boolean;

  // Support both old config format and new string shorthand
  constructor(config: ApiClientConfig) {
    this.isStringConfig = typeof config === 'string';

    if (this.isStringConfig) {
      const url = new URL(config);
      this.config = {
        host: url.hostname,
        port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
        useSSL: url.protocol === 'https:',
        timeout: 30000,
        maxRetries: 3,
        defaultHeaders: {}
      };
    } else {
      this.config = {
        timeout: 30000,
        maxRetries: 3,
        defaultHeaders: {},
        ...config
      };
    }
  }

  // Merge default headers with request-specific headers
  private mergeHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.config.defaultHeaders,
      ...requestHeaders
    };
  }

  // Exponential backoff retry logic
  private async retryRequest<T>(
    operation: () => Promise<T>,
    maxRetries: number,
    initialTimeout: number
  ): Promise<T> {
    let attempt = 0;
    let timeout = initialTimeout;

    while (attempt <= maxRetries) {
      try {
        return await operation();
      } catch (error: any) {
        attempt++;

        if (attempt > maxRetries || !this.isRetryableError(error)) {
          throw error;
        }

        await this.sleep(timeout);
        timeout *= 2; // Exponential backoff
      }
    }

    throw new Error('Max retries exceeded');
  }

  // Determine if error is retryable (5xx, 429, network errors)
  private isRetryableError(error: any): boolean {
    if (error.name === 'TypeError' || error.name === 'AbortError') {
      return true; // Network errors
    }

    if (error.status) {
      const status = error.status;
      return status === 429 || (status >= 500 && status < 600);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Generic request with timeout and retry support
  async request<T = any>(
    path: string,
    options?: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      timeout?: number;
      maxRetries?: number;
    }
  ): Promise<T> {
    const effectiveTimeout = options?.timeout ?? this.config.timeout;
    const effectiveMaxRetries = options?.maxRetries ?? this.config.maxRetries;

    const protocol = this.config.useSSL ? 'https' : 'http';
    const url = `${protocol}://${this.config.host}:${this.config.port}${path}`;
    const headers = this.mergeHeaders(options?.headers);

    const executeRequest = async (): Promise<T> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        const response = await fetch(url, {
          method: options?.method ?? 'GET',
          body: options?.body ? JSON.stringify(options.body) : undefined,
          headers,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error: any = new Error(`HTTP ${response.status}: ${response.statusText}`);
          error.status = response.status;
          throw error;
        }

        // Handle empty responses
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await response.json();
        }

        return response.text() as T;
      } catch (error: any) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
          const timeoutError: any = new Error(`Request timeout after ${effectiveTimeout}ms`);
          timeoutError.name = 'TimeoutError';
          throw timeoutError;
        }

        throw error;
      }
    };

    return this.retryRequest(
      executeRequest,
      effectiveMaxRetries,
      1000 // Initial backoff delay
    );
  }

  // Backward compatible methods with added generic type support
  async get<T = any>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async post<T = any>(path: string, body?: any): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  // New convenience methods
  async put<T = any>(path: string, body?: any): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body });
  }

  async delete<T = any>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // Config getter for runtime config access
  getConfig(): ConfigV2 {
    return { ...this.config };
  }
}

// Example usage showing backward compatibility:

// 1. Existing usage (no changes needed):
const client1 = new ApiClient({ host: 'api.example.com', port: 443, useSSL: true });
const data1 = await client1.get('/users'); // Still returns any
const result1 = await client1.post('/users', { name: 'Alice' }); // Still returns any

// 2. New string shorthand support:
const client2 = new ApiClient('https://api.example.com');
const data2 = await client2.get('/users');

// 3. With type safety:
const client3 = new ApiClient({
  host: 'api.example.com',
  port: 443,
  useSSL: true,
  timeout: 10000,
  maxRetries: 5
});

interface User {
  id: string;
  name: string;
  email: string;
}

const users: User[] = await client3.get<User[]>('/users');

// 4. With custom headers and retry per request:
const data4 = await client3.request('/special-endpoint', {
  method: 'POST',
  body: { special: true },
  headers: { 'Authorization': 'Bearer token' },
  timeout: 5000,
  maxRetries: 1
});

// 5. Using new HTTP methods:
await client3.delete('/users/123');