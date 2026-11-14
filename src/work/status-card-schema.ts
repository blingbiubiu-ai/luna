export type StepStatus = "done" | "active" | "pending" | "blocked";
export type CardStatus = "in_progress" | "completed" | "cancelled" | "blocked";

export interface StatusCardStep {
  readonly name: string;
  readonly status: StepStatus;
  readonly note?: string;
}

export interface StatusCardOutput {
  readonly title: string;
  readonly status: CardStatus;
  readonly steps: readonly StatusCardStep[];
  readonly summary: string;
}
