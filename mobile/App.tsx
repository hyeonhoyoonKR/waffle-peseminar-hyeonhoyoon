import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';

type Expense = { id: string; amount: number; purpose: string; createdAt: number };
type PiggyTransaction = { id: string; day: string; kind: 'deposit' | 'withdrawal'; amount: number };
type WeekDayStatus = 'kept' | 'over' | 'today' | 'todayOver' | 'inactive' | 'future';
type WeekDayRecord = { day: string; label: string; status: WeekDayStatus };
type Ledger = { dailyBudget: number; allowance: number; spent: number; piggyBalance: number; budgetKeptDays: number; weekDays: WeekDayRecord[]; expenses: Expense[]; piggyTransactions: PiggyTransaction[] };
type ResultSummary = {
  throughDay: string;
  completedDays: number;
  savedAmount: number;
  activeDays: number;
  keptDaysInPeriod: number;
  budgetKeptDays: number;
  milestoneReached: number | null;
};

const DEFAULT_DAILY_BUDGET = 30000;
const BUDGET_KEPT_MILESTONES = [3, 7, 14, 30];
const WON = new Intl.NumberFormat('ko-KR');

function seoulDay(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dayNumber(day: string) {
  return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}

function mondayOf(day: string) {
  const number = dayNumber(day);
  return number - ((number + 3) % 7);
}

function dayString(number: number) {
  return new Date(number * 86_400_000).toISOString().slice(0, 10);
}

async function initialize(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      daily_budget INTEGER NOT NULL CHECK (daily_budget > 0)
    );
    CREATE TABLE IF NOT EXISTS budget_days (
      day TEXT PRIMARY KEY,
      carry_in INTEGER NOT NULL,
      allowance INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY NOT NULL,
      day TEXT NOT NULL REFERENCES budget_days(day),
      amount INTEGER NOT NULL CHECK (amount > 0),
      purpose TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS piggy_transactions (
      id TEXT PRIMARY KEY NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
      amount INTEGER NOT NULL,
      source_day TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_days (
      day TEXT PRIMARY KEY NOT NULL
    );
    INSERT OR IGNORE INTO settings (id, daily_budget) VALUES (1, ${DEFAULT_DAILY_BUDGET});
  `);
  const piggySchema = await db.getFirstAsync<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'piggy_transactions'",
  );
  if (piggySchema?.sql && /CHECK\s*\(\s*amount\s*>=\s*0\s*\)/i.test(piggySchema.sql)) {
    await db.execAsync(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE piggy_transactions_signed (
        id TEXT PRIMARY KEY NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
        amount INTEGER NOT NULL,
        source_day TEXT UNIQUE,
        created_at INTEGER NOT NULL
      );
      INSERT INTO piggy_transactions_signed (id, day, kind, amount, source_day, created_at)
        SELECT id, day, kind, amount, source_day, created_at FROM piggy_transactions;
      DROP TABLE piggy_transactions;
      ALTER TABLE piggy_transactions_signed RENAME TO piggy_transactions;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  const savingsStart = await db.runAsync(
    'INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)', 'savings_start_day', seoulDay(),
  );
  if (savingsStart.changes > 0) {
    await db.runAsync('UPDATE budget_days SET carry_in = 0');
  }
  await db.runAsync('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)', 'progress_start_day', seoulDay());
  const progressStart = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?', 'progress_start_day',
  );
  const dayBeforeProgress = new Date((dayNumber(progressStart?.value ?? seoulDay()) - 1) * 86_400_000).toISOString().slice(0, 10);
  await db.runAsync(
    'INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)', 'result_seen_through', dayBeforeProgress,
  );
  await db.runAsync('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)', 'milestone_seen_count', '0');
}

async function ensureDaysAndSavePastRemainders(db: SQLiteDatabase, today: string, dailyBudget: number) {
  const start = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?', 'savings_start_day',
  );
  const latest = await db.getFirstAsync<{ day: string }>(
    'SELECT day FROM budget_days WHERE day < ? ORDER BY day DESC LIMIT 1', today,
  );

  if (!latest) {
    await db.runAsync(
      'INSERT OR IGNORE INTO budget_days (day, carry_in, allowance, created_at) VALUES (?, 0, ?, ?)',
      today, dailyBudget, Date.now(),
    );
  } else {
    for (let dayIndex = dayNumber(latest.day) + 1; dayIndex <= dayNumber(today); dayIndex += 1) {
      const day = new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);
      await db.runAsync(
        'INSERT OR IGNORE INTO budget_days (day, carry_in, allowance, created_at) VALUES (?, 0, ?, ?)',
        day, dailyBudget, Date.now(),
      );
    }
  }

  await db.runAsync('UPDATE budget_days SET allowance = ? WHERE day = ?', dailyBudget, today);

  if (!start?.value) return;
  const unsettledDays = await db.getAllAsync<{ day: string; allowance: number; spent: number }>(
    `SELECT d.day, d.allowance,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
     FROM budget_days d
     LEFT JOIN piggy_transactions p ON p.source_day = d.day
     WHERE d.day >= ? AND d.day < ? AND p.id IS NULL
     ORDER BY d.day ASC`,
    start.value, today,
  );
  for (const settled of unsettledDays) {
    const saved = settled.allowance - settled.spent;
    await db.runAsync(
      `INSERT OR IGNORE INTO piggy_transactions (id, day, kind, amount, source_day, created_at)
       VALUES (?, ?, 'deposit', ?, ?, ?)`,
      `save-${settled.day}`, settled.day, saved, settled.day, Date.now(),
    );
  }
}


type PiggyBankPageProps = {
  balance: number;
  budgetKeptDays: number;
  weekDays: WeekDayRecord[];
  transactions: PiggyTransaction[];
  onBack: () => void;
};

function PiggyBankPage({ balance, budgetKeptDays, weekDays, transactions, onBack }: PiggyBankPageProps) {
  const nextMilestone = BUDGET_KEPT_MILESTONES.find((day) => day > budgetKeptDays);
  const weeklyKeptDays = weekDays.filter(({ status }) => status === 'kept').length;
  return (
    <View style={styles.piggyPage}>
      <View style={styles.piggyPageHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="홈으로 돌아가기" onPress={onBack} style={styles.piggyBackButton}>
          <Text style={styles.piggyBackText}>‹</Text>
        </Pressable>
        <Text style={styles.piggyPageTitle}>저금통</Text>
        <View style={styles.piggyHeaderSpacer} />
      </View>
      <ScrollView style={styles.piggyPageScroll} contentContainerStyle={styles.piggyPageContent} showsVerticalScrollIndicator={false}>
        <View style={styles.piggyBalanceCard}>
          <View style={styles.piggyLargeMark}><Text style={styles.piggyLargeMarkText}>₩</Text></View>
          <Text style={styles.piggyPageEyebrow}>저금통 잔액</Text>
          <Text style={styles.piggyPageBalance} adjustsFontSizeToFit numberOfLines={1}>{WON.format(balance)}원</Text>
        </View>

        <View style={styles.weeklyCard}>
          <View style={styles.weeklyHeader}>
            <Text style={styles.weeklyTitle}>이번 주 기록</Text>
            <Text style={styles.weeklyCount}>예산 지킴 {weeklyKeptDays}일</Text>
          </View>
          <View style={styles.weeklyGrid}>
            {weekDays.map(({ day, label, status }) => (
              <View key={day} style={styles.weeklyDay}>
                <View style={[
                  styles.weeklyCell,
                  status === 'kept' && styles.weeklyCellKept,
                  status === 'over' && styles.weeklyCellOver,
                  status === 'today' && styles.weeklyCellToday,
                  status === 'todayOver' && styles.weeklyCellTodayOver,
                ]} />
                <Text style={[styles.weeklyDayLabel, (status === 'today' || status === 'todayOver') && styles.weeklyTodayLabel]}>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.budgetKeptCard}>
          <View style={styles.budgetKeptMark}><Text style={styles.budgetKeptMarkText}>✓</Text></View>
          <View style={styles.budgetKeptCopy}>
            <Text style={styles.budgetKeptLabel}>예산 지킨 날</Text>
            <Text style={styles.budgetKeptCount}>{budgetKeptDays}일</Text>
            <Text style={styles.budgetKeptNext}>{nextMilestone ? `다음 기록까지 ${nextMilestone - budgetKeptDays}일` : '30일 마일스톤 달성'}</Text>
          </View>
        </View>

        <View style={styles.piggyHistoryHeader}>
          <Text style={styles.piggyHistoryTitle}>저금 내역</Text>
          <Text style={styles.piggyHistoryCaption}>최근 50건</Text>
        </View>
        {transactions.length ? transactions.map((transaction) => (
          <View key={transaction.id} style={styles.piggyTransactionRow}>
            <View style={[styles.piggyTransactionIcon, (transaction.kind === 'withdrawal' || transaction.amount < 0) && styles.piggyWithdrawalIcon]}>
              <Text style={[styles.piggyTransactionIconText, (transaction.kind === 'withdrawal' || transaction.amount < 0) && styles.piggyWithdrawalIconText]}>
                {transaction.kind === 'withdrawal' || transaction.amount < 0 ? '−' : '＋'}
              </Text>
            </View>
            <View style={styles.piggyTransactionCopy}>
              <Text style={styles.piggyTransactionTitle}>
                {transaction.kind === 'withdrawal' ? '저금통 출금' : transaction.amount < 0 ? '예산 초과 반영' : '하루 예산 저금'}
              </Text>
              <Text style={styles.piggyTransactionDate}>{transaction.day.replaceAll('-', '.')}</Text>
            </View>
            <Text style={[styles.piggyTransactionAmount, (transaction.kind === 'withdrawal' || transaction.amount < 0) && styles.piggyWithdrawalAmount]}>
              {transaction.kind === 'withdrawal' || transaction.amount < 0 ? '−' : '+'}{WON.format(Math.abs(transaction.amount))}원
            </Text>
          </View>
        )) : (
          <View style={styles.piggyEmptyState}>
            <Text style={styles.piggyEmptyTitle}>아직 저금 내역이 없어요</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Home() {
  const db = useSQLiteContext();
  const { width, height } = useWindowDimensions();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');
  const budgetEditorMotion = useRef(new Animated.Value(0)).current;
  const budgetSaveInFlight = useRef(false);
  const [addingExpense, setAddingExpense] = useState(false);
  const [expenseSheetMounted, setExpenseSheetMounted] = useState(false);
  const expenseSheetMotion = useRef(new Animated.Value(0)).current;
  const [viewingExpenses, setViewingExpenses] = useState(false);
  const [expenseHistoryMounted, setExpenseHistoryMounted] = useState(false);
  const expenseHistoryMotion = useRef(new Animated.Value(0)).current;
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [expenseEditAmount, setExpenseEditAmount] = useState('');
  const [expenseEditPurpose, setExpenseEditPurpose] = useState('');
  const [showingPiggyBank, setShowingPiggyBank] = useState(false);
  const [pendingResult, setPendingResult] = useState<ResultSummary | null>(null);
  const currentDay = useRef(seoulDay());
  const animatedProgress = useRef(new Animated.Value(1)).current;

  const refresh = useCallback(async () => {
    const today = seoulDay();
    currentDay.current = today;
    const setting = await db.getFirstAsync<{ daily_budget: number }>('SELECT daily_budget FROM settings WHERE id = 1');
    const dailyBudget = setting?.daily_budget ?? DEFAULT_DAILY_BUDGET;
    await ensureDaysAndSavePastRemainders(db, today, dailyBudget);
    await db.runAsync('INSERT OR IGNORE INTO activity_days (day) VALUES (?)', today);

    const day = await db.getFirstAsync<{ allowance: number; spent: number }>(
      `SELECT d.allowance,
        COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
       FROM budget_days d WHERE d.day = ?`, today,
    );
    const weekStart = dayString(mondayOf(today));
    const weekEnd = dayString(mondayOf(today) + 6);
    const weekRows = await db.getAllAsync<{ day: string; allowance: number; spent: number; active: number }>(
      `SELECT d.day, d.allowance,
        COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent,
        CASE WHEN a.day IS NULL THEN 0 ELSE 1 END AS active
       FROM budget_days d LEFT JOIN activity_days a ON a.day = d.day
       WHERE d.day >= ? AND d.day <= ?`, weekStart, weekEnd,
    );
    const weekByDay = new Map(weekRows.map((row) => [row.day, row]));
    const weekDays: WeekDayRecord[] = Array.from({ length: 7 }, (_, index) => {
      const date = dayString(mondayOf(today) + index);
      const row = weekByDay.get(date);
      const status: WeekDayStatus = date > today ? 'future'
        : date === today ? ((day?.spent ?? 0) > (day?.allowance ?? dailyBudget) ? 'todayOver' : 'today')
          : !row?.active ? 'inactive'
            : row.spent <= row.allowance ? 'kept' : 'over';
      return { day: date, label: ['월', '화', '수', '목', '금', '토', '일'][index], status };
    });
    const expenses = await db.getAllAsync<{ id: string; amount: number; purpose: string; created_at: number }>(
      'SELECT id, amount, purpose, created_at FROM expenses WHERE day = ? ORDER BY created_at DESC', today,
    );
    const piggyTransactions = await db.getAllAsync<PiggyTransaction>(
      `SELECT id, day, kind, amount FROM piggy_transactions
       WHERE amount != 0 ORDER BY day DESC, created_at DESC LIMIT 50`,
    );
    const piggy = await db.getFirstAsync<{ balance: number }>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE -amount END), 0) AS balance
       FROM piggy_transactions`,
    );
    const progressStart = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_meta WHERE key = ?', 'progress_start_day',
    );
    const progressStartDay = progressStart?.value ?? today;
    const progress = await db.getFirstAsync<{ budget_kept_days: number }>(
      `SELECT COUNT(*) AS budget_kept_days
       FROM activity_days a
       JOIN budget_days d ON d.day = a.day
       WHERE a.day >= ? AND a.day < ?
         AND COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) <= d.allowance`,
      progressStartDay, today,
    );
    const resultCursor = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_meta WHERE key = ?', 'result_seen_through',
    );
    const pending = await db.getFirstAsync<{
      through_day: string | null;
      completed_days: number;
      saved_amount: number;
      active_days: number;
      kept_days: number;
    }>(
      `WITH day_totals AS (
         SELECT d.day, d.allowance,
           COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
         FROM budget_days d
         WHERE d.day >= ? AND d.day > ? AND d.day < ?
       )
       SELECT MAX(t.day) AS through_day,
         COUNT(t.day) AS completed_days,
         COALESCE(SUM(p.amount), 0) AS saved_amount,
         COALESCE(SUM(CASE WHEN a.day IS NOT NULL THEN 1 ELSE 0 END), 0) AS active_days,
         COALESCE(SUM(CASE WHEN a.day IS NOT NULL AND t.spent <= t.allowance THEN 1 ELSE 0 END), 0) AS kept_days
       FROM day_totals t
       JOIN piggy_transactions p ON p.source_day = t.day AND p.kind = 'deposit'
       LEFT JOIN activity_days a ON a.day = t.day`,
      progressStartDay, resultCursor?.value ?? '0000-00-00', today,
    );
    if (pending?.completed_days && pending.through_day) {
      const milestoneSeen = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM app_meta WHERE key = ?', 'milestone_seen_count',
      );
      const milestonesReached = BUDGET_KEPT_MILESTONES.filter(
        (milestone) => milestone > Number(milestoneSeen?.value ?? 0) && milestone <= (progress?.budget_kept_days ?? 0),
      );
      setPendingResult({
        throughDay: pending.through_day,
        completedDays: pending.completed_days,
        savedAmount: pending.saved_amount,
        activeDays: pending.active_days,
        keptDaysInPeriod: pending.kept_days,
        budgetKeptDays: progress?.budget_kept_days ?? 0,
        milestoneReached: milestonesReached.length ? milestonesReached[milestonesReached.length - 1] : null,
      });
    }
    setLedger({ dailyBudget, allowance: day?.allowance ?? dailyBudget, spent: day?.spent ?? 0,
      piggyBalance: piggy?.balance ?? 0,
      budgetKeptDays: progress?.budget_kept_days ?? 0,
      weekDays,
      expenses: expenses.map(({ id, amount: value, purpose: note, created_at }) =>
        ({ id, amount: value, purpose: note, createdAt: created_at })),
      piggyTransactions,
    });
  }, [db]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!showingPiggyBank) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setShowingPiggyBank(false);
      return true;
    });
    return () => subscription.remove();
  }, [showingPiggyBank]);

  useEffect(() => {
    const checkDayBoundary = () => {
      const today = seoulDay();
      if (today !== currentDay.current) void refresh();
    };
    const interval = setInterval(checkDayBoundary, 60_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkDayBoundary();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [refresh]);

  useEffect(() => {
    if (!expenseSheetMounted) return;
    const isOpening = addingExpense;
    const animation = Animated.timing(expenseSheetMotion, {
      toValue: isOpening ? 1 : 0,
      duration: isOpening ? 300 : 220,
      easing: isOpening ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !isOpening) setExpenseSheetMounted(false);
    });
    return () => animation.stop();
  }, [addingExpense, expenseSheetMounted, expenseSheetMotion]);

  useEffect(() => {
    if (!expenseHistoryMounted) return;
    const isOpening = viewingExpenses;
    const animation = Animated.timing(expenseHistoryMotion, {
      toValue: isOpening ? 1 : 0,
      duration: isOpening ? 300 : 240,
      easing: isOpening ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !isOpening) setExpenseHistoryMounted(false);
    });
    return () => animation.stop();
  }, [expenseHistoryMounted, expenseHistoryMotion, viewingExpenses]);

  useEffect(() => {
    const animation = Animated.timing(budgetEditorMotion, {
      toValue: budgetEdit ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [budgetEdit, budgetEditorMotion]);

  const openExpenseSheet = () => {
    expenseSheetMotion.setValue(0);
    setExpenseSheetMounted(true);
    setAddingExpense(true);
  };

  const dismissExpenseSheet = () => {
    setAddingExpense(false);
  };

  const openBudgetEditor = () => {
    setBudgetDraft(String(ledger?.dailyBudget ?? DEFAULT_DAILY_BUDGET));
    budgetEditorMotion.setValue(0);
    setBudgetEdit(true);
  };

  const openExpenseHistory = () => {
    expenseHistoryMotion.setValue(0);
    setExpenseHistoryMounted(true);
    setViewingExpenses(true);
  };

  const closeExpenseHistory = () => {
    setViewingExpenses(false);
    setEditingExpenseId(null);
    setExpenseEditAmount('');
    setExpenseEditPurpose('');
  };

  const addExpense = async () => {
    const value = Number(amount.replaceAll(',', '').trim());
    const note = purpose.trim();
    if (!Number.isSafeInteger(value) || value <= 0) {
      Alert.alert('금액을 확인해 주세요', '금액을 1원 이상 입력해 주세요.');
      return;
    }
    const today = seoulDay();
    await db.runAsync('INSERT INTO expenses (id, day, amount, purpose, created_at) VALUES (?, ?, ?, ?, ?)',
      `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, today, value, note, Date.now());
    setAmount('');
    setPurpose('');
    dismissExpenseSheet();
    await refresh();
  };

  const saveBudget = async () => {
    if (!budgetEdit || budgetSaveInFlight.current) return;
    const value = Number(budgetDraft.replaceAll(',', '').trim());
    if (!Number.isSafeInteger(value) || value <= 0) {
      Alert.alert('예산을 확인해 주세요', '하루 예산은 1원 이상의 정수로 입력해 주세요.');
      return;
    }
    budgetSaveInFlight.current = true;
    try {
      await db.runAsync('UPDATE settings SET daily_budget = ? WHERE id = 1', value);
      await db.runAsync('UPDATE budget_days SET allowance = ? WHERE day = ?', value, seoulDay());
      setBudgetEdit(false);
      await refresh();
    } finally {
      budgetSaveInFlight.current = false;
    }
  };

  const acknowledgeResult = async () => {
    if (!pendingResult) return;
    await db.runAsync(
      'UPDATE app_meta SET value = ? WHERE key = ?', pendingResult.throughDay, 'result_seen_through',
    );
    if (pendingResult.milestoneReached !== null) {
      await db.runAsync(
        'UPDATE app_meta SET value = ? WHERE key = ?', String(pendingResult.milestoneReached), 'milestone_seen_count',
      );
    }
    setPendingResult(null);
  };

  const openMoreMenu = () => {
    Alert.alert('더보기', '원하는 항목을 선택해 주세요.', [
      { text: '오늘 내역', onPress: openExpenseHistory },
      { text: '하루 예산 수정', onPress: openBudgetEditor },
      { text: '닫기', style: 'cancel' },
    ]);
  };

  const beginExpenseEdit = (expense: Expense) => {
    setEditingExpenseId(expense.id);
    setExpenseEditAmount(String(expense.amount));
    setExpenseEditPurpose(expense.purpose);
  };

  const cancelExpenseEdit = () => {
    setEditingExpenseId(null);
    setExpenseEditAmount('');
    setExpenseEditPurpose('');
  };

  const saveExpenseEdit = async () => {
    if (!editingExpenseId) return;
    const value = Number(expenseEditAmount.replaceAll(',', '').trim());
    const note = expenseEditPurpose.trim();
    if (!Number.isSafeInteger(value) || value <= 0) {
      Alert.alert('금액을 확인해 주세요', '금액을 1원 이상 입력해 주세요.');
      return;
    }
    await db.runAsync('UPDATE expenses SET amount = ?, purpose = ? WHERE id = ?', value, note, editingExpenseId);
    cancelExpenseEdit();
    await refresh();
  };

  const deleteExpense = async (expense: Expense) => {
    await db.runAsync('DELETE FROM expenses WHERE id = ?', expense.id);
    await refresh();
  };

  const confirmDeleteExpense = (expense: Expense) => {
    Alert.alert(
      '기록을 삭제할까요?',
      `${expense.purpose || '사용처 미입력'} · ${WON.format(expense.amount)}원`,
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => { void deleteExpense(expense); } },
      ],
    );
  };

  const remaining = (ledger?.allowance ?? 0) - (ledger?.spent ?? 0);
  const total = ledger?.allowance ?? 0;
  const progress = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  useEffect(() => {
    if (!ledger) return;
    const animation = Animated.timing(animatedProgress, {
      toValue: progress,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [animatedProgress, ledger, progress]);

  const gaugeWidth = Math.min(width - 64, 340);
  const gaugeRadius = (gaugeWidth - 24) / 2;
  const segmentPositions = Array.from({ length: 181 }, (_, index) => {
    const angle = Math.PI + (Math.PI * index) / 180;
    const x = gaugeWidth / 2 + gaugeRadius * Math.cos(angle);
    const y = gaugeRadius + gaugeRadius * Math.sin(angle);
    return { index, left: x - 5, top: y - 8, rotation: `${(angle * 180) / Math.PI + 90}deg` };
  });
  const trackSegments = segmentPositions.map(({ index, left, top, rotation }) => (
    <View key={`track-${index}`} style={[styles.gaugeSegment, { left, top, transform: [{ rotate: rotation }], backgroundColor: '#E7EAF2' }]} />
  ));
  const progressSegments = segmentPositions.map(({ index, left, top, rotation }) => {
    const threshold = index / 180;
    const fadeStart = Math.max(0, threshold - 1 / 180);
    const fadeEnd = Math.min(1, threshold + 1 / 180);
    const opacity = animatedProgress.interpolate({
      inputRange: [fadeStart, fadeEnd],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
    return <Animated.View key={`progress-${index}`} style={[styles.gaugeSegment, { left, top, transform: [{ rotate: rotation }], backgroundColor: '#4C91F2', opacity }]} />;
  });

  return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.screen}>
            {showingPiggyBank ? (
              <PiggyBankPage
                balance={ledger?.piggyBalance ?? 0}
                budgetKeptDays={ledger?.budgetKeptDays ?? 0}
                weekDays={ledger?.weekDays ?? []}
                transactions={ledger?.piggyTransactions ?? []}
                onBack={() => setShowingPiggyBank(false)}
              />
            ) : <>
            <Text style={styles.title}>DayMark</Text>
            {budgetEdit && <Pressable
              accessibilityRole="button"
              accessibilityLabel="예산 저장하고 닫기"
              onPress={() => void saveBudget()}
              style={styles.budgetSaveBackdrop}
            />}
            <View style={[styles.hero, budgetEdit && styles.budgetEditingHero, { marginTop: Math.max(36, height * 0.115) }]}>
              <View style={{ width: gaugeWidth, height: gaugeRadius + 64 }}>
                {trackSegments}
                {progressSegments}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="오늘 지출 내역 보기"
                  onPress={() => budgetEdit ? void saveBudget() : openExpenseHistory()}
                  style={[styles.gaugeCopy, { top: gaugeRadius * 0.52 }]}
                >
                  <Text style={styles.cardLabel}>오늘 남은 예산</Text>
                  <Text style={[styles.balance, remaining < 0 && styles.overBudget]} adjustsFontSizeToFit numberOfLines={1}>
                    {WON.format(remaining)}<Text style={styles.won}>원</Text>
                  </Text>
                  <Text style={styles.total}>/ {WON.format(total)}원</Text>
                </Pressable>
              </View>
              <Animated.View style={[styles.budgetControl, {
                width: budgetEditorMotion.interpolate({
                  inputRange: [0, 1],
                  outputRange: [Math.min(gaugeWidth, 230), gaugeWidth],
                }),
              }]}>
                {budgetEdit ? (
                  <View style={styles.budgetEditContent}>
                    <TextInput
                      accessibilityLabel="하루 예산"
                      autoFocus
                      keyboardType="number-pad"
                      value={budgetDraft}
                      onChangeText={setBudgetDraft}
                      onEndEditing={() => void saveBudget()}
                      style={styles.budgetEditorInput}
                    />
                    <Text style={styles.budgetUnit}>원</Text>
                  </View>
                ) : (
                  <Pressable accessibilityRole="button" onPress={openBudgetEditor} style={styles.budgetPillAction}>
                    <Text style={styles.budgetPillText}>오늘 예산 {WON.format(ledger?.allowance ?? DEFAULT_DAILY_BUDGET)}원</Text>
                  </Pressable>
                )}
              </Animated.View>
            </View>
            <View style={styles.bottomAction}>
              <Pressable accessibilityRole="button" accessibilityLabel="저금통 페이지 열기" onPress={() => setShowingPiggyBank(true)} style={styles.navButtonSlot}>
                <View style={styles.piggyNavIcon}><Text style={styles.piggyNavIconText}>₩</Text></View>
              </Pressable>
              <View style={styles.navCenterSlot}>
                <Pressable accessibilityRole="button" accessibilityLabel={addingExpense ? '지출 입력 닫기' : '지출 추가'} onPress={addingExpense ? dismissExpenseSheet : openExpenseSheet} style={styles.addButton}>
                  <Text style={[styles.plus, addingExpense && styles.plusClose]}>＋</Text>
                </Pressable>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="더보기" onPress={openMoreMenu} style={styles.navButtonSlot}>
                <View style={styles.moreIcon}>
                  <View style={styles.moreIconLine} />
                  <View style={styles.moreIconLine} />
                  <View style={styles.moreIconLine} />
                </View>
              </Pressable>
            </View>
            </>}
          </View>
        </KeyboardAvoidingView>
        {expenseSheetMounted && <Animated.View style={[styles.expenseBackdropLayer, { opacity: expenseSheetMotion }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="지출 입력 닫기"
            onPress={dismissExpenseSheet}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>}
        {expenseSheetMounted && <Animated.View style={[
          styles.expenseSheet,
          {
            opacity: expenseSheetMotion,
            transform: [{ translateY: expenseSheetMotion.interpolate({ inputRange: [0, 1], outputRange: [32, 0] }) }],
          },
        ]}>
          <View style={styles.expenseSheetHeader}>
            <Text style={styles.expenseSheetTitle}>지출 기록</Text>
            <Pressable onPress={dismissExpenseSheet}><Text style={styles.editLink}>닫기</Text></Pressable>
          </View>
          <TextInput accessibilityLabel="지출 금액" keyboardType="number-pad" value={amount} onChangeText={setAmount} placeholder="금액 (원)" style={[styles.input, styles.expenseInput]} />
          <TextInput accessibilityLabel="사용처" value={purpose} onChangeText={setPurpose} placeholder="사용처 (선택)" style={[styles.input, styles.expenseInput]} maxLength={60} returnKeyType="done" />
          <Pressable onPress={() => void addExpense()} style={[styles.primaryButton, styles.expenseSubmitButton]}><Text style={styles.primaryButtonText}>기록</Text></Pressable>
        </Animated.View>}
        <Modal
          visible={expenseHistoryMounted}
          transparent
          animationType="none"
          onRequestClose={closeExpenseHistory}
        >
          <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Animated.View style={[styles.modalBackdrop, { opacity: expenseHistoryMotion }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="오늘 내역 닫기"
                onPress={closeExpenseHistory}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
            <Animated.View style={[
              styles.recordsSheet,
              {
                maxHeight: height * 0.76,
                opacity: expenseHistoryMotion,
                transform: [{ translateY: expenseHistoryMotion.interpolate({ inputRange: [0, 1], outputRange: [48, 0] }) }],
              },
            ]}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetTitle}>{editingExpenseId ? '지출 수정' : '오늘 내역'}</Text>
                  {editingExpenseId && <Text style={styles.sheetSubtitle}>금액과 사용처를 수정해요</Text>}
                </View>
                <Pressable accessibilityRole="button" onPress={closeExpenseHistory} style={styles.closeButton}>
                  <Text style={styles.closeButtonText}>닫기</Text>
                </Pressable>
              </View>
              <View style={styles.sheetSummary}>
                <Text style={styles.sheetSummaryLabel}>오늘 사용</Text>
                <Text style={styles.sheetSummaryAmount}>{WON.format(ledger?.spent ?? 0)}원</Text>
              </View>
              {editingExpenseId ? (
                <ScrollView
                  style={styles.expenseEditScroll}
                  contentContainerStyle={styles.expenseEditForm}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  <TextInput
                    accessibilityLabel="수정할 지출 금액"
                    autoFocus
                    keyboardType="number-pad"
                    value={expenseEditAmount}
                    onChangeText={setExpenseEditAmount}
                    placeholder="금액 (원)"
                    style={[styles.input, styles.expenseInput]}
                  />
                  <TextInput
                    accessibilityLabel="수정할 사용처"
                    value={expenseEditPurpose}
                    onChangeText={setExpenseEditPurpose}
                    placeholder="사용처 (선택)"
                    maxLength={60}
                    style={[styles.input, styles.expenseInput]}
                  />
                  <View style={styles.expenseEditActions}>
                    <Pressable onPress={cancelExpenseEdit} style={styles.expenseEditCancel}>
                      <Text style={styles.expenseEditCancelText}>취소</Text>
                    </Pressable>
                    <Pressable onPress={() => void saveExpenseEdit()} style={styles.expenseEditSave}>
                      <Text style={styles.expenseEditSaveText}>저장</Text>
                    </Pressable>
                  </View>
                </ScrollView>
              ) : ledger?.expenses.length ? (
                <ScrollView style={styles.expenseList} contentContainerStyle={styles.expenseListContent} showsVerticalScrollIndicator={false}>
                  {ledger.expenses.map((expense) => (
                    <View key={expense.id} style={styles.expenseRow}>
                      <View style={styles.expenseCopy}>
                        <Text style={styles.expensePurpose}>{expense.purpose || '사용처 미입력'}</Text>
                        <Text style={styles.expenseTime}>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(expense.createdAt)}</Text>
                      </View>
                      <View style={styles.expenseActions}>
                        <Text style={styles.expenseAmount}>−{WON.format(expense.amount)}원</Text>
                        <View style={styles.expenseActionButtons}>
                          <Pressable accessibilityRole="button" accessibilityLabel={`${expense.purpose || '사용처 미입력'} 수정`} onPress={() => beginExpenseEdit(expense)} style={styles.expenseActionButton}>
                            <Text style={styles.editActionIcon}>✎</Text>
                          </Pressable>
                          <Pressable accessibilityRole="button" accessibilityLabel={`${expense.purpose || '사용처 미입력'} 삭제`} onPress={() => confirmDeleteExpense(expense)} style={styles.expenseDeleteButton}>
                            <View style={styles.trashIcon}>
                              <View style={styles.trashHandle} />
                              <View style={styles.trashLid} />
                              <View style={styles.trashBody}>
                                <View style={styles.trashLine} />
                                <View style={styles.trashLine} />
                              </View>
                            </View>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <View style={styles.emptyExpenses}>
                  <Text style={styles.emptyExpensesTitle}>아직 기록이 없어요</Text>
                  <Text style={styles.emptyExpensesText}>오늘 쓴 돈을 기록하면 여기에 보여요.</Text>
                </View>
              )}
            </Animated.View>
          </KeyboardAvoidingView>
        </Modal>
        <Modal visible={pendingResult !== null} transparent animationType="fade" onRequestClose={() => void acknowledgeResult()}>
          <View style={styles.resultModalRoot}>
            <Pressable accessibilityRole="button" accessibilityLabel="결과 확인" onPress={() => void acknowledgeResult()} style={StyleSheet.absoluteFill} />
            <View style={styles.resultCard}>
              <View style={styles.resultBadge}><Text style={styles.resultBadgeText}>✓</Text></View>
              <Text style={styles.resultEyebrow}>지난 기간의 결과</Text>
              <Text style={styles.resultTitle}>
                {(pendingResult?.savedAmount ?? 0) > 0
                  ? `${WON.format(pendingResult?.savedAmount ?? 0)}원을 저금했어요`
                  : (pendingResult?.savedAmount ?? 0) < 0
                    ? `예산 초과로 ${WON.format(Math.abs(pendingResult?.savedAmount ?? 0))}원이 차감됐어요`
                    : '이번 기간에는 저금된 금액이 없어요'}
              </Text>
              <Text style={styles.resultDescription}>
                {pendingResult?.activeDays
                  ? `예산을 지킨 날 ${pendingResult.keptDaysInPeriod}일 · 총 ${pendingResult.completedDays}일 정산`
                  : `미접속 날짜의 남은 예산도 저금통에 담았어요 · ${pendingResult?.completedDays ?? 0}일 정산`}
              </Text>
              <View style={styles.resultProgressCard}>
                <Text style={styles.resultProgressLabel}>누적 예산 지킨 날</Text>
                <Text style={styles.resultProgressValue}>{pendingResult?.budgetKeptDays ?? 0}일</Text>
                {pendingResult?.milestoneReached ? (
                  <Text style={styles.resultMilestone}>🎉 {pendingResult.milestoneReached}일 기록을 달성했어요!</Text>
                ) : (
                  <Text style={styles.resultMilestone}>
                    {BUDGET_KEPT_MILESTONES.find((day) => day > (pendingResult?.budgetKeptDays ?? 0))
                      ? `다음 단계까지 ${BUDGET_KEPT_MILESTONES.find((day) => day > (pendingResult?.budgetKeptDays ?? 0))! - (pendingResult?.budgetKeptDays ?? 0)}일`
                      : '30일 마일스톤을 달성했어요'}
                  </Text>
                )}
              </View>
              <Pressable accessibilityRole="button" onPress={() => void acknowledgeResult()} style={styles.resultConfirmButton}>
                <Text style={styles.resultConfirmText}>확인</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return <SQLiteProvider databaseName="oneul-budget.db" onInit={initialize}><Home /></SQLiteProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' }, flex: { flex: 1 },
  screen: { flex: 1, alignItems: 'center', paddingHorizontal: 24 },
  budgetSaveBackdrop: { ...StyleSheet.absoluteFill, zIndex: 1 },
  title: { color: '#20252D', fontSize: 34, lineHeight: 42, fontWeight: '800', marginTop: 48, letterSpacing: -1.2 },
  hero: { alignItems: 'center' },
  budgetEditingHero: { zIndex: 2, elevation: 2 },
  gaugeSegment: { position: 'absolute', width: 12, height: 18, borderRadius: 10 },
  gaugeCopy: { position: 'absolute', left: 8, right: 8, alignItems: 'center', gap: 4 },
  cardLabel: { color: '#5F6874', fontSize: 19, fontWeight: '500', marginBottom: 8 },
  balance: { color: '#20252D', fontSize: 56, lineHeight: 66, fontWeight: '800', letterSpacing: -2 },
  won: { fontSize: 30, letterSpacing: -1 },
  overBudget: { color: '#E05252' },
  total: { color: '#59616D', fontSize: 23, marginTop: 2 },
  budgetControl: { backgroundColor: '#E5F0FF', borderRadius: 28, minHeight: 48, justifyContent: 'center', overflow: 'hidden', marginTop: 12 },
  budgetPillAction: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingVertical: 11, paddingHorizontal: 18 },
  budgetPillText: { color: '#244A78', fontSize: 18, fontWeight: '600' },
  budgetEditContent: { flexDirection: 'row', alignItems: 'center', width: '100%', paddingHorizontal: 18 },
  budgetEditorInput: { flex: 1, minWidth: 0, paddingVertical: 11, textAlign: 'center', color: '#244A78', fontSize: 19, fontWeight: '700' },
  budgetUnit: { color: '#244A78', fontSize: 18, fontWeight: '600', marginLeft: 2 },
  navButtonSlot: { flex: 1, height: 76, alignItems: 'center', justifyContent: 'center' },
  navCenterSlot: { flex: 1, height: 76, alignItems: 'center', justifyContent: 'center' },
  piggyNavIcon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  piggyNavIconText: { color: '#687587', fontSize: 23, fontWeight: '700' },
  moreIcon: { width: 24, height: 20, justifyContent: 'space-between', paddingVertical: 2 },
  moreIconLine: { width: 22, height: 2, borderRadius: 1, backgroundColor: '#687587' },
  piggyPage: { flex: 1, width: '100%' },
  piggyPageHeader: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 38, marginBottom: 12 },
  piggyBackButton: { width: 42, height: 42, justifyContent: 'center' },
  piggyBackText: { color: '#20252D', fontSize: 36, lineHeight: 40 },
  piggyHeaderSpacer: { width: 42 },
  piggyPageTitle: { color: '#20252D', fontSize: 22, fontWeight: '800' },
  piggyPageScroll: { flex: 1 },
  piggyPageContent: { paddingBottom: 28 },
  piggyBalanceCard: { alignItems: 'center', backgroundColor: '#F2F7FF', borderRadius: 24, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20 },
  piggyLargeMark: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#DCEBFF', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  piggyLargeMarkText: { color: '#397CD4', fontSize: 23, fontWeight: '800' },
  piggyPageEyebrow: { color: '#6C7889', fontSize: 13, fontWeight: '600' },
  piggyPageBalance: { color: '#20252D', fontSize: 36, lineHeight: 44, fontWeight: '800', marginTop: 4 },
  weeklyCard: { marginTop: 14, backgroundColor: '#F5F9FF', borderWidth: 1, borderColor: '#E4EEFC', borderRadius: 20, paddingHorizontal: 17, paddingTop: 17, paddingBottom: 14 },
  weeklyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  weeklyTitle: { color: '#20252D', fontSize: 15, fontWeight: '800' },
  weeklyCount: { color: '#397CD4', backgroundColor: '#E5F0FF', overflow: 'hidden', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, fontSize: 11, fontWeight: '700' },
  weeklyGrid: { flexDirection: 'row', justifyContent: 'space-between' },
  weeklyDay: { flex: 1, alignItems: 'center', gap: 7 },
  weeklyCell: { width: 29, height: 29, borderRadius: 8, backgroundColor: '#E8EDF4' },
  weeklyCellKept: { backgroundColor: '#4C91F2' },
  weeklyCellOver: { backgroundColor: '#F2B8B8' },
  weeklyCellToday: { backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#4C91F2' },
  weeklyCellTodayOver: { backgroundColor: '#FCE7E7', borderWidth: 2, borderColor: '#D96A6A' },
  weeklyDayLabel: { color: '#8993A0', fontSize: 11, fontWeight: '600' },
  weeklyTodayLabel: { color: '#397CD4' },
  budgetKeptCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#E8EDF4', borderRadius: 18, padding: 15, marginTop: 14 },
  budgetKeptMark: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#E7F6EF', alignItems: 'center', justifyContent: 'center' },
  budgetKeptMarkText: { color: '#34835C', fontSize: 20, fontWeight: '800' },
  budgetKeptCopy: { flex: 1, gap: 2 },
  budgetKeptLabel: { color: '#667385', fontSize: 12, fontWeight: '600' },
  budgetKeptCount: { color: '#20252D', fontSize: 20, fontWeight: '800' },
  budgetKeptNext: { color: '#397CD4', fontSize: 12, fontWeight: '600', marginTop: 2 },
  piggyHistoryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 4 },
  piggyHistoryTitle: { color: '#20252D', fontSize: 17, fontWeight: '800' },
  piggyHistoryCaption: { color: '#8993A0', fontSize: 12 },
  piggyTransactionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E9EDF2' },
  piggyTransactionIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E7F6EF', alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  piggyWithdrawalIcon: { backgroundColor: '#FFF0F0' },
  piggyTransactionIconText: { color: '#34835C', fontSize: 18, fontWeight: '700' },
  piggyWithdrawalIconText: { color: '#B54747' },
  piggyTransactionCopy: { flex: 1, gap: 3 },
  piggyTransactionTitle: { color: '#263242', fontSize: 14, fontWeight: '600' },
  piggyTransactionDate: { color: '#8993A0', fontSize: 12 },
  piggyTransactionAmount: { color: '#34835C', fontSize: 14, fontWeight: '700' },
  piggyWithdrawalAmount: { color: '#B54747' },
  piggyEmptyState: { alignItems: 'center', paddingVertical: 30 },
  piggyEmptyTitle: { color: '#4A5564', fontSize: 14, fontWeight: '700' },
  sectionTitle: { color: '#20252D', fontWeight: '800', fontSize: 16 },
  input: { backgroundColor: '#F4F7FC', borderRadius: 13, paddingHorizontal: 14, paddingVertical: 14, fontSize: 16, color: '#20252D' },
  primaryButton: { alignItems: 'center', backgroundColor: '#4C91F2', paddingVertical: 15, borderRadius: 14 },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  expenseBackdropLayer: { ...StyleSheet.absoluteFill, zIndex: 1, backgroundColor: 'rgba(17, 25, 38, 0.34)' },
  expenseSheet: {
    position: 'absolute',
    zIndex: 2,
    left: 0,
    right: 0,
    bottom: Platform.OS === 'ios' ? -34 : 0,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: Platform.OS === 'ios' ? 48 : 24,
    gap: 16,
    shadowColor: '#27364A',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -4 },
    elevation: 10,
  },
  expenseSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  expenseSheetTitle: { color: '#20252D', fontSize: 20, fontWeight: '800' },
  expenseInput: { minHeight: 60, paddingVertical: 17, fontSize: 17 },
  expenseSubmitButton: { alignSelf: 'center', width: '88%', paddingVertical: 18, marginTop: 2 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(17, 25, 38, 0.34)' },
  recordsSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 22, paddingTop: 12, paddingBottom: Platform.OS === 'ios' ? 34 : 24 },
  sheetHandle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 4, backgroundColor: '#D8DDE5', marginBottom: 18 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  sheetTitle: { color: '#20252D', fontSize: 22, fontWeight: '800' },
  sheetSubtitle: { color: '#7A8492', fontSize: 13, marginTop: 4 },
  closeButton: { backgroundColor: '#F2F5F9', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 13 },
  closeButtonText: { color: '#4D5866', fontSize: 13, fontWeight: '700' },
  resultModalRoot: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, backgroundColor: 'rgba(17, 25, 38, 0.42)' },
  resultCard: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 26, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 22, alignItems: 'center' },
  resultBadge: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#E5F0FF', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  resultBadgeText: { color: '#4C91F2', fontSize: 28, fontWeight: '800' },
  resultEyebrow: { color: '#748095', fontSize: 13, fontWeight: '600' },
  resultTitle: { color: '#20252D', fontSize: 22, lineHeight: 29, fontWeight: '800', textAlign: 'center', marginTop: 7 },
  resultDescription: { color: '#6F7988', fontSize: 13, textAlign: 'center', lineHeight: 20, marginTop: 9 },
  resultProgressCard: { width: '100%', alignItems: 'center', backgroundColor: '#F3F7FD', borderRadius: 18, paddingVertical: 16, marginTop: 20 },
  resultProgressLabel: { color: '#697586', fontSize: 13, fontWeight: '600' },
  resultProgressValue: { color: '#20252D', fontSize: 28, fontWeight: '800', marginTop: 3 },
  resultMilestone: { color: '#397CD4', fontSize: 13, fontWeight: '700', marginTop: 7, textAlign: 'center' },
  resultConfirmButton: { alignSelf: 'stretch', backgroundColor: '#4C91F2', borderRadius: 14, alignItems: 'center', paddingVertical: 15, marginTop: 18 },
  resultConfirmText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  sheetSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#F2F7FF', borderRadius: 16, paddingVertical: 15, paddingHorizontal: 16, marginBottom: 8 },
  sheetSummaryLabel: { color: '#526275', fontSize: 14, fontWeight: '600' },
  sheetSummaryAmount: { color: '#20252D', fontSize: 19, fontWeight: '800' },
  expenseList: { flexShrink: 1 },
  expenseListContent: { paddingBottom: 4 },
  expenseRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E9EDF2' },
  expenseCopy: { flex: 1, gap: 4 },
  expensePurpose: { color: '#20252D', fontSize: 15, fontWeight: '600' },
  expenseTime: { color: '#8993A0', fontSize: 12 },
  expenseActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 10 },
  expenseAmount: { color: '#20252D', fontSize: 14, fontWeight: '700' },
  expenseActionButtons: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  expenseActionButton: { backgroundColor: 'transparent', paddingVertical: 5, paddingHorizontal: 4 },
  editActionIcon: { color: '#4D5866', fontSize: 18, lineHeight: 19, fontWeight: '700' },
  expenseDeleteButton: { backgroundColor: 'transparent', paddingVertical: 5, paddingHorizontal: 4 },
  trashIcon: { position: 'relative', width: 18, height: 19 },
  trashHandle: { position: 'absolute', top: 0, left: 6, width: 6, height: 2, borderRadius: 1, backgroundColor: '#B54747' },
  trashLid: { position: 'absolute', top: 3, left: 2, width: 14, height: 2, borderRadius: 1, backgroundColor: '#B54747' },
  trashBody: { position: 'absolute', top: 6, left: 4, width: 10, height: 12, borderWidth: 1.5, borderColor: '#B54747', borderBottomLeftRadius: 3, borderBottomRightRadius: 3, flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center' },
  trashLine: { width: 1, height: 6, borderRadius: 1, backgroundColor: '#B54747' },
  expenseEditScroll: { flexShrink: 1 },
  expenseEditForm: { gap: 14, paddingBottom: 8 },
  expenseEditActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 2 },
  expenseEditCancel: { backgroundColor: '#F2F5F9', borderRadius: 13, paddingVertical: 14, paddingHorizontal: 18 },
  expenseEditCancelText: { color: '#4D5866', fontSize: 14, fontWeight: '700' },
  expenseEditSave: { backgroundColor: '#4C91F2', borderRadius: 13, paddingVertical: 14, paddingHorizontal: 22 },
  expenseEditSaveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  emptyExpenses: { alignItems: 'center', paddingVertical: 36 },
  emptyExpensesTitle: { color: '#343D49', fontSize: 15, fontWeight: '700' },
  emptyExpensesText: { color: '#8993A0', fontSize: 13, marginTop: 6 },
  bottomAction: { position: 'absolute', bottom: Platform.OS === 'ios' ? -34 : 0, left: -24, right: -24, height: Platform.OS === 'ios' ? 110 : 76, paddingBottom: Platform.OS === 'ios' ? 34 : 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 32, backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, shadowColor: '#27364A', shadowOpacity: 0.11, shadowRadius: 16, shadowOffset: { width: 0, height: -4 }, elevation: 7 },
  addButton: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#4C91F2', alignItems: 'center', justifyContent: 'center', shadowColor: '#4788D9', shadowOpacity: 0.27, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  plus: { color: '#FFFFFF', fontSize: 58, fontWeight: '300', lineHeight: 64, marginTop: -5 },
  plusClose: { transform: [{ rotate: '45deg' }] },
  editLink: { color: '#4C91F2', fontSize: 13, fontWeight: '700', padding: 4 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 },
});
