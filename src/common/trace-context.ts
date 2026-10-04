import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContextData {
  requestId: string;
  queryCount: number;
  queryTimeMs: number;
}

export const traceContext = new AsyncLocalStorage<TraceContextData>();
