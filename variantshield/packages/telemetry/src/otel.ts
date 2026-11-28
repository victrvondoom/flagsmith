import type { TelemetryEvent } from "./types.ts";

/**
 * Maps an event to OpenTelemetry attributes. `feature_flag.key`, `feature_flag.result.variant`
 * follow the feature-flag semantic conventions (release candidate); everything VariantShield-specific
 * is namespaced under `variantshield.` so it can never collide with a future convention.
 */
export function toOtelAttributes(e: TelemetryEvent): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "feature_flag.key": e.featureKey,
    "variantshield.event.type": e.type,
    "variantshield.identity.id": e.identityId,
    "variantshield.request.id": e.requestId,
    "variantshield.operation": e.operation,
    "variantshield.outcome": e.outcome,
    "variantshield.attribution": e.attribution,
    "variantshield.data_source": e.source,
  };
  if (e.attribution === "valid" && e.variantKey) attrs["feature_flag.result.variant"] = e.variantKey;
  if (e.experimentId) attrs["variantshield.experiment.id"] = e.experimentId;
  if (e.latencyMs !== null) attrs["variantshield.latency_ms"] = e.latencyMs;
  if (e.errorCategory) attrs["error.type"] = e.errorCategory;
  if (e.httpStatus !== null) attrs["http.response.status_code"] = e.httpStatus;
  return attrs;
}
