import type { FastifyInstance } from "fastify";
import type {
  WorkRecordDetail,
  WorkRecordReadFailureCode,
  WorkRecordReader,
  WorkRecordSearchQuery,
  WorkRecordSearchResult,
} from "../observability/work-record-reader.js";

export interface WorkRecordSearchRequest {
  requestId: string;
  query: WorkRecordSearchQuery;
}

export type WorkRecordSearchState =
  | { kind: "idle"; draft: WorkRecordSearchQuery }
  | { kind: "loading"; request: WorkRecordSearchRequest }
  | { kind: "empty"; request: WorkRecordSearchRequest }
  | {
      kind: "failed";
      request: WorkRecordSearchRequest;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | {
      kind: "ready";
      request: WorkRecordSearchRequest;
      result: WorkRecordSearchResult;
      selection: WorkRecordSelectionState;
    };

export type WorkRecordSelectionState =
  | { kind: "none" }
  | { kind: "loading"; runId: string; requestId: string }
  | {
      kind: "failed";
      runId: string;
      requestId: string;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | { kind: "ready"; runId: string; requestId: string; record: WorkRecordDetail };

export type WorkRecordScreenEvent =
  | { type: "search_started"; request: WorkRecordSearchRequest }
  | { type: "search_succeeded"; requestId: string; result: WorkRecordSearchResult }
  | {
      type: "search_failed";
      requestId: string;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | { type: "selection_started"; runId: string; requestId: string }
  | { type: "selection_succeeded"; requestId: string; record: WorkRecordDetail }
  | {
      type: "selection_failed";
      requestId: string;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | { type: "active_record_refreshed"; runId: string; record: WorkRecordDetail };

/**
 * The browser owns drafts, submitted criteria, and selection. Starting a search
 * drops the previous result and detail; requestId prevents an older response
 * from restoring stale content after a newer search.
 */
export declare function reduceWorkRecordScreen(
  state: WorkRecordSearchState,
  event: WorkRecordScreenEvent,
): WorkRecordSearchState;

export interface WorkRecordRouteOptions {
  /** The API may cap ranges and result counts without changing literal-match semantics. */
  maximumRangeMs: number;
  maximumResults: number;
}

/**
 * Registers GET /api/work-records and GET /api/work-records/:runId. Read
 * failures map to stable codes; no endpoint mutates or controls a work run.
 */
export declare function registerWorkRecordRoutes(
  app: FastifyInstance,
  reader: WorkRecordReader,
  options: WorkRecordRouteOptions,
): Promise<void>;
