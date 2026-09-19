import type {
  TodoDecisionStateDto,
  TodoDetailDto,
  TodoSubmissionDto,
  TodoSubmitResultDto,
  TodoValidationIssueDto,
} from "./contracts.js";

/**
 * The rendering boundary after a person submits a todo.
 *
 * Only a confirmed `processed` decision may remove the waiting presentation or
 * show the success copy. A transport refusal, an unexpected response, or a
 * todo reported gone during this request is a rejected submission: the screen
 * keeps both the todo and the exact draft so the person can retry. Validation
 * issues are separate because they can point at a field without claiming that
 * the request was accepted.
 */
export type TodoSubmissionProjection =
  | {
      readonly kind: "confirmed";
      readonly todo: TodoDetailDto;
      readonly submission: TodoSubmissionDto;
      readonly decision: Extract<TodoDecisionStateDto, { readonly status: "processed" }>;
    }
  | {
      readonly kind: "awaiting_confirmation";
      readonly todo: TodoDetailDto;
      readonly submission: TodoSubmissionDto;
      readonly decision: Exclude<TodoDecisionStateDto, { readonly status: "processed" }>;
    }
  | {
      readonly kind: "validation_failed";
      readonly todo: TodoDetailDto;
      readonly submission: TodoSubmissionDto;
      readonly issues: readonly TodoValidationIssueDto[];
    }
  | {
      readonly kind: "submission_rejected";
      readonly todo: TodoDetailDto;
      readonly submission: TodoSubmissionDto;
      readonly messageKey: "answer_not_submitted";
    };

/**
 * Projects one response without reading the todo list again. This function
 * owns no durable state; the page owns the draft and the ledger owns whether
 * the work is still waiting. Concurrent refresh and submit responses are
 * ordered by the page request id before this projection is applied.
 */
export function projectTodoSubmission(
  todo: TodoDetailDto,
  submission: TodoSubmissionDto,
  result: TodoSubmitResultDto,
): TodoSubmissionProjection {
  if (result.kind === "invalid") {
    return { kind: "validation_failed", todo, submission, issues: result.issues };
  }
  if (result.kind === "recorded") {
    if (result.state.status === "processed") {
      return { kind: "confirmed", todo, submission, decision: result.state };
    }
    return { kind: "awaiting_confirmation", todo, submission, decision: result.state };
  }
  // `failed` and `gone` are the same answer to the person: the result was not
  // kept, so the todo stays and the draft is kept for a retry.
  return { kind: "submission_rejected", todo, submission, messageKey: "answer_not_submitted" };
}
