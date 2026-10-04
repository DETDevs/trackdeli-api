import { Injectable } from '@nestjs/common';

interface RequestTrace {
  route: string;
  durationMs: number;
  dbQueriesCount: number;
  status: number;
  timestamp: number;
}

@Injectable()
export class LatencyDiagnosticsService {
  private traces: RequestTrace[] = [];
  private readonly MAX_TRACES = 5000;

  constructor() {
    (global as any).LatencyDiagnostics = this;
  }

  record(route: string, durationMs: number, dbQueriesCount: number, status: number) {
    this.traces.push({ route, durationMs, dbQueriesCount, status, timestamp: Date.now() });
    if (this.traces.length > this.MAX_TRACES) {
      this.traces.shift(); // Remove oldest
    }
  }

  getDiagnostics() {
    const routeStats = new Map<string, number[]>();
    const routeQueries = new Map<string, number[]>();

    for (const t of this.traces) {
      if (!routeStats.has(t.route)) {
        routeStats.set(t.route, []);
        routeQueries.set(t.route, []);
      }
      routeStats.get(t.route)!.push(t.durationMs);
      routeQueries.get(t.route)!.push(t.dbQueriesCount);
    }

    const result = [];
    for (const [route, durations] of routeStats.entries()) {
      durations.sort((a, b) => a - b);
      const queries = routeQueries.get(route)!;
      queries.sort((a, b) => a - b);
      
      const count = durations.length;
      const p50 = durations[Math.floor(count * 0.5)];
      const p95 = durations[Math.floor(count * 0.95)];
      const p99 = durations[Math.floor(count * 0.99)];
      const avgQueries = queries.reduce((a, b) => a + b, 0) / count;
      const maxQueries = queries[count - 1];

      result.push({
        route,
        count,
        p50,
        p95,
        p99,
        avgQueries: Number(avgQueries.toFixed(1)),
        maxQueries
      });
    }

    const slowestEndpoints = [...result].sort((a, b) => b.p95 - a.p95).slice(0, 10);
    const mostQueries = [...result].sort((a, b) => b.maxQueries - a.maxQueries).slice(0, 10);

    return {
      totalTraces: this.traces.length,
      slowestEndpoints,
      mostQueries,
      all: result
    };
  }
}
