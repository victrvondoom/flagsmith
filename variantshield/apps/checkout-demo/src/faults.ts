export const FAULT_TYPES = ["none", "payment_failures", "duplicate_submissions", "slow_responses", "server_errors"] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

export interface Fault { variant: string; type: FaultType; rate: number }

/** Controlled fault injection: makes one variant visibly fine but operationally unsafe, on demand. */
export class FaultController {
  private fault: Fault = { variant: "", type: "none", rate: 0 };
  set(f: Fault): void { this.fault = f; }
  clear(): void { this.fault = { variant: "", type: "none", rate: 0 }; }
  get(): Fault { return this.fault; }
  /** The active fault for a variant, or "none". */
  forVariant(variant: string | null): { type: FaultType; rate: number } {
    return this.fault.type !== "none" && variant === this.fault.variant ? { type: this.fault.type, rate: this.fault.rate } : { type: "none", rate: 0 };
  }
}

export const FAULT_DEFAULTS: Record<Exclude<FaultType, "none">, number> = { payment_failures: 0.09, duplicate_submissions: 0.07, slow_responses: 1, server_errors: 0.04 };
