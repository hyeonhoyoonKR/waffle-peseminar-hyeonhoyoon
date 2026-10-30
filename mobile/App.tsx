import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';

type Expense = { id: string; amount: number; purpose: string; createdAt: number };
type Ledger = { dailyBudget: number; carryIn: number; allowance: number; spent: number; expenses: Expense[] };

const DEFAULT_DAILY_BUDGET = 30000;
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
    INSERT OR IGNORE INTO settings (id, daily_budget) VALUES (1, ${DEFAULT_DAILY_BUDGET});
  `);
}

async function ensureToday(db: SQLiteDatabase, today: string, dailyBudget: number) {
  const exists = await db.getFirstAsync<{ day: string }>('SELECT day FROM budget_days WHERE day = ?', today);
  if (exists) return;

  const previous = await db.getFirstAsync<{ day: string; carry_in: number; allowance: number; spent: number }>(
    `SELECT d.day, d.carry_in, d.allowance,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
     FROM budget_days d WHERE d.day < ? ORDER BY d.day DESC LIMIT 1`, today,
  );
  let carryIn = 0;
  if (previous) {
    const previousRemaining = previous.carry_in + previous.allowance - previous.spent;
    const missedDays = Math.max(0, dayNumber(today) - dayNumber(previous.day) - 1);
    carryIn = previousRemaining + missedDays * dailyBudget;
  }
  await db.runAsync('INSERT INTO budget_days (day, carry_in, allowance, created_at) VALUES (?, ?, ?, ?)',
    today, carryIn, dailyBudget, Date.now());
}

function Home() {
  const db = useSQLiteContext();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');

  const refresh = useCallback(async () => {
    const today = seoulDay();
    const setting = await db.getFirstAsync<{ daily_budget: number }>('SELECT daily_budget FROM settings WHERE id = 1');
    const dailyBudget = setting?.daily_budget ?? DEFAULT_DAILY_BUDGET;
    await ensureToday(db, today, dailyBudget);
    const day = await db.getFirstAsync<{ carry_in: number; allowance: number; spent: number }>(
      `SELECT d.carry_in, d.allowance,
        COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
       FROM budget_days d WHERE d.day = ?`, today,
    );
    const expenses = await db.getAllAsync<{ id: string; amount: number; purpose: string; created_at: number }>(
      'SELECT id, amount, purpose, created_at FROM expenses WHERE day = ? ORDER BY created_at DESC', today,
    );
    setLedger({ dailyBudget, carryIn: day?.carry_in ?? 0, allowance: day?.allowance ?? dailyBudget,
      spent: day?.spent ?? 0,
      expenses: expenses.map(({ id, amount: value, purpose: note, created_at }) =>
        ({ id, amount: value, purpose: note, createdAt: created_at })),
    });
  }, [db]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addExpense = async () => {
    const value = Number(amount.replaceAll(',', '').trim());
    const note = purpose.trim();
    if (!Number.isSafeInteger(value) || value <= 0 || !note) {
      Alert.alert('기록을 확인해 주세요', '금액과 사용처를 모두 입력해 주세요.');
      return;
    }
    const today = seoulDay();
    await db.runAsync('INSERT INTO expenses (id, day, amount, purpose, created_at) VALUES (?, ?, ?, ?, ?)',
      `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, today, value, note, Date.now());
    setAmount('');
    setPurpose('');
    await refresh();
  };

  const saveBudget = async () => {
    const value = Number(budgetDraft.replaceAll(',', '').trim());
    if (!Number.isSafeInteger(value) || value <= 0) {
      Alert.alert('예산을 확인해 주세요', '하루 예산은 1원 이상의 정수로 입력해 주세요.');
      return;
    }
    await db.runAsync('UPDATE settings SET daily_budget = ? WHERE id = 1', value);
    await db.runAsync('UPDATE budget_days SET allowance = ? WHERE day = ?', value, seoulDay());
    setBudgetEdit(false);
    await refresh();
  };

  const remaining = (ledger?.carryIn ?? 0) + (ledger?.allowance ?? 0) - (ledger?.spent ?? 0);
  const total = (ledger?.carryIn ?? 0) + (ledger?.allowance ?? 0);
  const progress = total > 0 ? Math.min(1, Math.max(0, (ledger?.spent ?? 0) / total)) : 0;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>오늘의 돈 흐름</Text>
          <Text style={styles.title}>오늘, 얼마까지 써도 될까?</Text>

          <View style={styles.balanceCard}>
            <Text style={styles.cardLabel}>오늘 남은 예산</Text>
            <Text style={[styles.balance, remaining < 0 && styles.overBudget]}>{WON.format(remaining)}원</Text>
            <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%` }]} /></View>
            <View style={styles.balanceMeta}>
              <Text style={styles.metaText}>오늘 {WON.format(ledger?.allowance ?? DEFAULT_DAILY_BUDGET)}원</Text>
              <Text style={styles.metaText}>이월 {WON.format(ledger?.carryIn ?? 0)}원</Text>
            </View>
            <Pressable onPress={() => { setBudgetDraft(String(ledger?.dailyBudget ?? DEFAULT_DAILY_BUDGET)); setBudgetEdit(!budgetEdit); }}>
              <Text style={styles.editLink}>{budgetEdit ? '닫기' : '하루 예산 바꾸기'}</Text>
            </Pressable>
            {budgetEdit && <View style={styles.budgetRow}>
              <TextInput accessibilityLabel="하루 예산" keyboardType="number-pad" value={budgetDraft}
                onChangeText={setBudgetDraft} placeholder="하루 예산 (원)" style={[styles.input, styles.budgetInput]} />
              <Pressable onPress={() => void saveBudget()} style={styles.smallButton}><Text style={styles.smallButtonText}>저장</Text></Pressable>
            </View>}
          </View>

          <Text style={styles.sectionTitle}>방금 쓴 돈 기록하기</Text>
          <View style={styles.formCard}>
            <TextInput accessibilityLabel="지출 금액" keyboardType="number-pad" value={amount}
              onChangeText={setAmount} placeholder="금액 (원)" style={styles.input} />
            <TextInput accessibilityLabel="사용처" value={purpose} onChangeText={setPurpose}
              placeholder="무엇에 썼나요? 예: 점심 김치찌개" style={styles.input} maxLength={60} returnKeyType="done" />
            <Pressable onPress={() => void addExpense()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>오늘 지출로 기록</Text>
            </Pressable>
          </View>

          <View style={styles.listHeader}>
            <Text style={styles.sectionTitle}>오늘 기록</Text>
            <Text style={styles.spentLabel}>사용 {WON.format(ledger?.spent ?? 0)}원</Text>
          </View>
          {ledger?.expenses.length ? ledger.expenses.map((expense) => (
            <View key={expense.id} style={styles.expenseRow}>
              <View style={styles.expenseCopy}>
                <Text style={styles.expensePurpose}>{expense.purpose}</Text>
                <Text style={styles.expenseTime}>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(expense.createdAt)}</Text>
              </View>
              <Text style={styles.expenseAmount}>−{WON.format(expense.amount)}원</Text>
            </View>
          )) : <Text style={styles.empty}>아직 기록이 없어요. 첫 지출을 남겨 보세요.</Text>}
          <Text style={styles.footer}>안 쓴 예산은 다음 날로 이어져요.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App() {
  return <SQLiteProvider databaseName="oneul-budget.db" onInit={initialize}><Home /></SQLiteProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F4EF' }, flex: { flex: 1 },
  content: { padding: 22, paddingTop: 30, paddingBottom: 44, gap: 16 },
  eyebrow: { color: '#54715C', fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  title: { color: '#18231B', fontSize: 26, lineHeight: 34, fontWeight: '800', marginBottom: 4 },
  balanceCard: { backgroundColor: '#203D2B', borderRadius: 24, padding: 22, gap: 10 },
  cardLabel: { color: '#D1E2D2', fontSize: 14, fontWeight: '600' },
  balance: { color: '#FFFFFF', fontSize: 38, fontWeight: '800', letterSpacing: -1 },
  overBudget: { color: '#FFB5A9' },
  progressTrack: { height: 7, borderRadius: 8, backgroundColor: '#46604E', overflow: 'hidden', marginTop: 2 },
  progressFill: { height: 7, borderRadius: 8, backgroundColor: '#D8E7A7' },
  balanceMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  metaText: { color: '#D1E2D2', fontSize: 12 },
  editLink: { color: '#D8E7A7', fontSize: 13, fontWeight: '700', alignSelf: 'flex-start', paddingTop: 2 },
  budgetRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  budgetInput: { flex: 1, marginTop: 0, backgroundColor: '#FFFFFF' },
  smallButton: { backgroundColor: '#D8E7A7', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12 },
  smallButtonText: { color: '#203D2B', fontWeight: '800' },
  sectionTitle: { color: '#18231B', fontWeight: '800', fontSize: 17 },
  formCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 14, gap: 10 },
  input: { backgroundColor: '#F4F5F2', borderRadius: 13, paddingHorizontal: 14, paddingVertical: 14,
    fontSize: 16, color: '#18231B' },
  primaryButton: { alignItems: 'center', backgroundColor: '#C7DA92', paddingVertical: 15, borderRadius: 14, marginTop: 2 },
  primaryButtonText: { color: '#203D2B', fontWeight: '800', fontSize: 15 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 },
  spentLabel: { color: '#68716A', fontSize: 13, fontWeight: '600' },
  expenseRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 15, padding: 15 },
  expenseCopy: { gap: 4, flex: 1 }, expensePurpose: { color: '#18231B', fontSize: 15, fontWeight: '700' },
  expenseTime: { color: '#8B938C', fontSize: 12 }, expenseAmount: { color: '#283A2E', fontSize: 15, fontWeight: '700' },
  empty: { padding: 18, textAlign: 'center', color: '#7B847D', backgroundColor: '#FFFFFF', borderRadius: 15, lineHeight: 21 },
  footer: { textAlign: 'center', color: '#748079', fontSize: 12, marginTop: 3 },
});
