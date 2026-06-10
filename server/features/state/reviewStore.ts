type ReviewAction = "approve" | "reject" | "request-changes";

interface PendingReview {
  resolve: (result: { action: ReviewAction; notes?: string }) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingReview>();

export function waitForReview(
  reviewId: string,
  abortSignal: AbortSignal
): Promise<{ action: ReviewAction; notes?: string }> {
  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new Error("Review aborted: chain was stopped"));
      return;
    }

    pending.set(reviewId, { resolve, reject });

    abortSignal.addEventListener("abort", () => {
      pending.delete(reviewId);
      reject(new Error("Review aborted: chain was stopped"));
    }, { once: true });
  });
}

export function resolveReview(reviewId: string, action: ReviewAction, notes?: string): boolean {
  const entry = pending.get(reviewId);
  if (!entry) return false;
  pending.delete(reviewId);
  entry.resolve({ action, notes });
  return true;
}

export function rejectAllPending(reason: string): void {
  for (const [, entry] of pending) {
    entry.reject(new Error(reason));
  }
  pending.clear();
}
