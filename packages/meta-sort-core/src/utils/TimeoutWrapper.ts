/**
 * Timeout Wrapper Utility
 *
 * Provides timeout functionality for async operations with configurable retry logic
 */

export interface TimeoutConfig {
  /** Base timeout in milliseconds (default: 30000ms = 30s) */
  baseTimeout: number;
  /** Timeout multiplier for each retry (default: 1.5x) */
  timeoutMultiplier: number;
  /** Maximum timeout in milliseconds (default: 600000ms = 10min) */
  maxTimeout: number;
}

const DEFAULT_CONFIG: TimeoutConfig = {
  baseTimeout: 30000, // 30 seconds
  timeoutMultiplier: 1.5,
  maxTimeout: 600000 // 10 minutes
};

/**
 * Calculate timeout for a specific retry attempt
 */
export function calculateTimeout(retryCount: number, config: TimeoutConfig = DEFAULT_CONFIG): number {
  const timeout = config.baseTimeout * Math.pow(config.timeoutMultiplier, retryCount);
  return Math.min(timeout, config.maxTimeout);
}

/**
 * Execute an async function with timeout
 * @param fn - Function to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param label - Label for error messages
 * @returns Promise that rejects if timeout is exceeded
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string = 'Operation'
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timeoutHandle!);
    return result;
  } catch (error) {
    clearTimeout(timeoutHandle!);
    throw error;
  }
}

/**
 * Execute an async function with timeout and retry logic
 * @param fn - Function to execute
 * @param retryCount - Current retry count (0-based)
 * @param config - Timeout configuration
 * @param label - Label for error messages
 * @returns Promise that resolves with result or rejects with timeout error
 */
export async function withTimeoutAndRetry<T>(
  fn: () => Promise<T>,
  retryCount: number,
  config: TimeoutConfig = DEFAULT_CONFIG,
  label: string = 'Operation'
): Promise<T> {
  const timeout = calculateTimeout(retryCount, config);
  return withTimeout(fn, timeout, label);
}
