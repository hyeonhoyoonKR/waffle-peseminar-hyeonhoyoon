const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSettlement, replaySettlements, statusForDay } = require('./settlement.js');

test('saves an unused positive remainder after confirmation', () => {
  assert.deepEqual(calculateSettlement({ allowance: 20000, spent: 7200, piggyBalance: 0 }), {
    saved: 12800, deducted: 0, balanceAfter: 12800, keptBudget: true,
  });
});

test('settles an exactly used budget without a piggy transaction amount', () => {
  assert.deepEqual(calculateSettlement({ allowance: 10000, spent: 10000, piggyBalance: 5000 }), {
    saved: 0, deducted: 0, balanceAfter: 5000, keptBudget: true,
  });
});

test('deducts overspending only up to the available piggy balance', () => {
  assert.deepEqual(calculateSettlement({ allowance: 20000, spent: 25000, piggyBalance: 3000 }), {
    saved: 0, deducted: 3000, balanceAfter: 0, keptBudget: false,
  });
});

test('does not create a negative balance when the piggy bank is empty', () => {
  const result = calculateSettlement({ allowance: 20000, spent: 45000, piggyBalance: 0 });
  assert.equal(result.deducted, 0);
  assert.equal(result.balanceAfter, 0);
});

test('ignores a legacy negative balance when computing new settlements', () => {
  assert.equal(calculateSettlement({ allowance: 10000, spent: 12000, piggyBalance: -900 }).balanceAfter, 0);
});

test('maps legacy settled days and unconfirmed past days during migration', () => {
  assert.equal(statusForDay('2026-11-22', '2026-11-23', true), 'SETTLED');
  assert.equal(statusForDay('2026-11-22', '2026-11-23', false), 'AWAITING_SETTLEMENT');
  assert.equal(statusForDay('2026-11-23', '2026-11-23', false), 'OPEN');
  assert.equal(statusForDay('2026-11-24', '2026-11-23', false), 'OPEN');
});

test('replays later overspending after an earlier settled expense is edited', () => {
  const beforeEdit = replaySettlements([
    { day: '2026-11-20', allowance: 10000, spent: 6000 },
    { day: '2026-11-21', allowance: 10000, spent: 14000 },
  ]);
  assert.deepEqual(beforeEdit.settlements, [
    { day: '2026-11-20', kind: 'deposit', amount: 4000 },
    { day: '2026-11-21', kind: 'withdrawal', amount: 4000 },
  ]);

  const afterEdit = replaySettlements([
    { day: '2026-11-20', allowance: 10000, spent: 9000 },
    { day: '2026-11-21', allowance: 10000, spent: 14000 },
  ]);
  assert.deepEqual(afterEdit.settlements, [
    { day: '2026-11-20', kind: 'deposit', amount: 1000 },
    { day: '2026-11-21', kind: 'withdrawal', amount: 1000 },
  ]);
  assert.equal(afterEdit.balance, 0);
});

test('caps historical manual withdrawals to the balance available at that point', () => {
  const result = replaySettlements(
    [{ day: '2026-11-20', allowance: 10000, spent: 0 }],
    [{ id: 'legacy-withdrawal', day: '2026-11-21', amount: 15000 }],
  );
  assert.deepEqual(result.adjustedWithdrawals, [{ id: 'legacy-withdrawal', amount: 10000 }]);
  assert.equal(result.balance, 0);
});
