interface FetchResult {
  url: string;
  data?: any;
  status: number;
  error?: string;
}

async function processAllUrls(urls: string[]): Promise<FetchResult[]> {
  const results: FetchResult[] = [];
  const MAX_CONCURRENT = 50; // Limit concurrent requests to prevent resource exhaustion

  // Process URLs with controlled concurrency
  for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
    const batch = urls.slice(i, i + MAX_CONCURRENT);
    const batchResults = await processBatch(batch);
    results.push(...batchResults);
  }

  return results;
}

async function processBatch(urls: string[]): Promise<FetchResult[]> {
  return Promise.allSettled(
    urls.map(url => fetchWithRetry(url))
  ).then(results =>
    results.map((result, index) => {
      const url = urls[index];
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          url,
          status: 0,
          error: result.reason.message || 'Request failed'
        };
      }
    })
  );
}

async function fetchWithRetry(url: string, retryCount = 0): Promise<FetchResult> {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000;

  try {
    const resp = await fetch(url);

    // Handle 429 with exponential backoff
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('retry-after');
      const delay = retryAfter ?
        parseInt(retryAfter) * 1000 :
        BASE_DELAY * Math.pow(2, retryCount);

      if (retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, retryCount + 1);
      }

      // Return 429 status after max retries
      let data;
      try {
        data = await resp.json();
      } catch {
        data = null;
      }
      return { url, data, status: 429 };
    }

    // Parse response
    let data;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }

    return { url, data, status: resp.status };

  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, BASE_DELAY * (retryCount + 1)));
      return fetchWithRetry(url, retryCount + 1);
    }

    return {
      url,
      status: 0,
      error: error.message
    };
  }
}

// Example usage:
// const results = await processAllUrls(largeListOfUrls);
// console.log(`Successfully processed ${results.filter(r => r.status !== 0).length} URLs`);

module.exports = { processAllUrls, FetchResult };