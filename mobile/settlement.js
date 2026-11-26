function calculateSettlement({ allowance, spent, piggyBalance }) {
  const remainder = allowance - spent;
  const saved = Math.max(0, remainder);
  const deducted = Math.min(Math.max(0, spent - allowance), Math.max(0, piggyBalance));
  return {
    saved,
    deducted,
    balanceAfter: Math.max(0, piggyBalance) + saved - deducted,
    keptBudget: spent <= allowance,
  };
}

function statusForDay(day, today, hasLegacySettlement) {
  if (day === today || day > today) return 'OPEN';
  return hasLegacySettlement ? 'SETTLED' : 'AWAITING_SETTLEMENT';
}

function replaySettlements(days, manualWithdrawals = []) {
  let balance = 0;
  let manualIndex = 0;
  const settlements = [];
  const adjustedWithdrawals = [];
  const applyWithdrawal = (withdrawal) => {
    const amount = Math.min(Math.max(0, withdrawal.amount), balance);
    adjustedWithdrawals.push({ id: withdrawal.id, amount });
    balance -= amount;
  };
  for (const day of days) {
    while (manualIndex < manualWithdrawals.length && manualWithdrawals[manualIndex].day < day.day) {
      applyWithdrawal(manualWithdrawals[manualIndex++]);
    }
    const result = calculateSettlement({ allowance: day.allowance, spent: day.spent, piggyBalance: balance });
    if (result.saved > 0) {
      settlements.push({ day: day.day, kind: 'deposit', amount: result.saved });
      balance += result.saved;
    } else if (result.deducted > 0) {
      settlements.push({ day: day.day, kind: 'withdrawal', amount: result.deducted });
      balance -= result.deducted;
    }
    while (manualIndex < manualWithdrawals.length && manualWithdrawals[manualIndex].day === day.day) {
      applyWithdrawal(manualWithdrawals[manualIndex++]);
    }
  }
  while (manualIndex < manualWithdrawals.length) applyWithdrawal(manualWithdrawals[manualIndex++]);
  return { settlements, adjustedWithdrawals, balance };
}

module.exports = { calculateSettlement, statusForDay, replaySettlements };
