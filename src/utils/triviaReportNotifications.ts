// Trivia report notifications.
//
// HISTORICAL NOTE (v5.49.0): both helpers below used to dispatch push
// notifications directly via /api/send-push from the actor's browser.
// That made delivery dependent on the actor's tab staying open through
// the entire round-trip. As of migration 066, dispatch is fully
// server-side: AFTER INSERT and AFTER UPDATE OF status triggers on
// `trivia_reports` enqueue jobs in `notification_jobs`, and the worker
// at /api/notification-worker drains the queue and calls /api/send-push.
//
// We keep the public function signatures so callers don't need to change
// — but the bodies are now no-ops. The DB trigger fires the moment the
// row is inserted/updated; calling the helper just adds an extra dead-
// branch with no side effects.
//
// To remove these calls entirely you can grep for `notifySuperAdminsOfTriviaReport`
// and `notifyReporterOfResolution` and delete the imports.

export type TriviaResolutionOutcome = 'accept' | 'reject';

// Kept for type compatibility with existing callers; arguments unused.
export async function notifySuperAdminsOfTriviaReport(_opts: {
  reporterName: string;
  reason: 'wrong_answer' | 'unclear_question' | 'other';
  questionText: string;
}): Promise<void> {
  // Server-side trigger trg_enqueue_trivia_report_on_insert handles
  // dispatch. This client-side wrapper is intentionally empty.
}

export async function notifyReporterOfTriviaResolution(_opts: {
  reporterName: string;
  outcome: TriviaResolutionOutcome;
  questionText: string;
}): Promise<void> {
  // Server-side trigger trg_enqueue_trivia_report_on_resolve handles
  // dispatch. This client-side wrapper is intentionally empty.
}
