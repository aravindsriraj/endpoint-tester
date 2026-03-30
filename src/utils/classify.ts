import type { EndpointStatus } from "../types";

/** Maps HTTP status code to a suggested EndpointStatus.
 * This is a hint for the LLM — the final classification considers the response body too.
 */
export function suggestClassification(httpStatus: number): EndpointStatus {
  if (httpStatus >= 200 && httpStatus < 300) return "valid";
  if (httpStatus === 404 || httpStatus === 405) return "invalid_endpoint";
  if (httpStatus === 401 || httpStatus === 403) return "insufficient_scopes";
  return "error";
}
