/**
 * 本地存储读取重试
 * 记录仪文件（IndexedDB 读数）偶发读不出时，由值班员侧按有限次数重试；
 * 仅用于读取路径 —— 写入（尤其管理员手填的出入房时刻）绝不走重试覆盖，避免互相顶掉。
 */

/** 最多尝试次数（含首次） */
export const DEFAULT_READ_ATTEMPTS = 3;
/** 首次重试前等待毫秒数，之后逐次递增 */
export const DEFAULT_READ_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 带退避的读取重试；全部失败后抛出最后一次错误 */
export async function readWithRetry<T>(
  reader: () => Promise<T>,
  attempts: number = DEFAULT_READ_ATTEMPTS,
  delayMs: number = DEFAULT_READ_DELAY_MS,
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await reader();
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) await sleep(delayMs * (index + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('本地数据读取失败');
}
