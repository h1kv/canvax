import type { WebSocket } from "ws";
import { resolveReview } from "../../state/reviewStore.js";
import { debug } from "../../../utils/debug.js";

export function handleReviewRespond(
  _ws: WebSocket,
  _userId: string,
  message: Record<string, unknown>
): void {
  const reviewId = message.reviewId as string | undefined;
  const action = message.action as string | undefined;
  const notes = message.notes as string | undefined;

  if (!reviewId || !action) {
    debug("review:respond:invalid", { reviewId, action });
    return;
  }

  if (action !== "approve" && action !== "reject" && action !== "request-changes") {
    debug("review:respond:bad-action", { action });
    return;
  }

  const resolved = resolveReview(reviewId, action, notes);
  debug(resolved ? "review:resolved" : "review:not-found", { reviewId, action });
}
