export type SettlementInput = {
  allowance: number;
  spent: number;
  piggyBalance: number;
};

export type SettlementResult = {
  saved: number;
  deducted: number;
  balanceAfter: number;
  keptBudget: boolean;
};

export function calculateSettlement(input: SettlementInput): SettlementResult;

export type SettlementStatus = 'OPEN' | 'AWAITING_SETTLEMENT' | 'SETTLED';

export function statusForDay(day: string, today: string, hasLegacySettlement: boolean): SettlementStatus;

export type SettlementDay = { day: string; allowance: number; spent: number };
export type ManualWithdrawal = { id: string; day: string; amount: number };
export type SettlementEvent = { day: string; kind: 'deposit' | 'withdrawal'; amount: number };
export function replaySettlements(days: SettlementDay[], withdrawals?: ManualWithdrawal[]): {
  settlements: SettlementEvent[];
  adjustedWithdrawals: Array<{ id: string; amount: number }>;
  balance: number;
};
