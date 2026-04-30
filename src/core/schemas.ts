import { z } from "zod";

export const ShellVerifySchema = z.object({
  type: z.literal("shell"),
  cmd: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout_ms: z.number().int().positive().max(3_600_000).default(120_000),
  expect_exit: z.number().int().default(0),
});

export const HttpVerifySchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]).default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  expect_status: z.union([z.number().int(), z.array(z.number().int()).min(1)]).default(200),
  expect_body_regex: z.string().optional(),
  timeout_ms: z.number().int().positive().max(600_000).default(15_000),
});

export const PlaywrightVerifySchema = z.object({
  type: z.literal("playwright"),
  spec: z.string().min(1),
  config: z.string().optional(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(1_800_000).default(180_000),
});

const LeafVerifySchema = z.discriminatedUnion("type", [
  ShellVerifySchema,
  HttpVerifySchema,
  PlaywrightVerifySchema,
]);
export type LeafVerify = z.infer<typeof LeafVerifySchema>;
type LeafVerifyInput = z.input<typeof LeafVerifySchema>;

export type Verify =
  | LeafVerify
  | { type: "all"; verifiers: Verify[] }
  | { type: "any"; verifiers: Verify[] };

type VerifyInput =
  | LeafVerifyInput
  | { type: "all"; verifiers: VerifyInput[] }
  | { type: "any"; verifiers: VerifyInput[] };

export const VerifySchema: z.ZodType<Verify, z.ZodTypeDef, VerifyInput> = z.lazy(() =>
  z.union([
    LeafVerifySchema,
    z.object({
      type: z.literal("all"),
      verifiers: z.array(VerifySchema).min(1).max(20),
    }),
    z.object({
      type: z.literal("any"),
      verifiers: z.array(VerifySchema).min(1).max(20),
    }),
  ]),
);

export const PhaseSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_\-:.]+$/, "phase id must be alphanumeric with _-:."),
  goal: z.string().min(1).max(500),
  deliverable: z.string().min(1).max(500),
  verify: VerifySchema,
  done_criteria: z.string().min(1).max(500),
  risky: z.boolean().default(false),
  max_retries: z.number().int().min(0).max(10).default(3),
});
export type Phase = z.infer<typeof PhaseSchema>;

export const PlanSchema = z
  .object({
    goal: z.string().min(1).max(1000),
    phases: z.array(PhaseSchema).min(1).max(50),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const [i, p] of plan.phases.entries()) {
      if (ids.has(p.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate phase id "${p.id}"`,
          path: ["phases", i, "id"],
        });
      }
      ids.add(p.id);
    }
  });
export type Plan = z.infer<typeof PlanSchema>;

export const PhaseStatusSchema = z.enum([
  "pending",
  "in_progress",
  "verifying",
  "passed",
  "failed",
  "blocked",
]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export const PhaseStateSchema = z.object({
  status: PhaseStatusSchema,
  retries: z.number().int().min(0).default(0),
  evidence: z.string().nullable().default(null),
  last_failure: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
});
export type PhaseState = z.infer<typeof PhaseStateSchema>;

export const ApprovalSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
  asked_at: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const LogEntrySchema = z.object({
  ts: z.string(),
  kind: z.string(),
  data: z.unknown().optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  session_id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  plan: PlanSchema,
  current_phase_idx: z.number().int().min(0),
  phase_state: z.record(PhaseStateSchema),
  continuations_used: z.number().int().min(0).default(0),
  max_continuations: z.number().int().min(1).max(500).default(30),
  awaiting_approval: ApprovalSchema.nullable().default(null),
  followup_queue: z.array(z.string()).default([]),
  halted: z.boolean().default(false),
  halt_reason: z.string().nullable().default(null),
  log: z.array(LogEntrySchema).default([]),
});
export type State = z.infer<typeof StateSchema>;
