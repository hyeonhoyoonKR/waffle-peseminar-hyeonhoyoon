import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type TextProps,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFonts } from 'expo-font';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { calculateSettlement, replaySettlements, statusForDay, type SettlementStatus } from './settlement';

type Expense = { id: string; day: string; amount: number; purpose: string; createdAt: number };
type PiggyTransaction = { id: string; day: string; kind: 'deposit' | 'withdrawal'; amount: number; source_day?: string | null };
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
type AppTab = 'home' | 'growth' | 'piggy' | 'profile';

const PUPPY = require('./assets/nalmoa-puppy.png');
const NAV_IMAGES = {
  home: require('./assets/nav-home.png'),
  growth: require('./assets/nav-growth.png'),
  piggy: require('./assets/nav-piggy.png'),
  profile: require('./assets/nav-profile.png'),
};
const ROOM_THEMES = [
  {
    name: '기본 방', image: require('./assets/nalmoa-room-square.png'), fadeStart: '#FACBA3', fadeMid: '#F9E6CF',
    accent: '#EFA16D', accentDeep: '#D77F46', button: '#EFA16D', buttonEdge: '#E18F5A', buttonText: '#302A26',
    nav: '#F5EEE4', card: '#FFFEFC', cardEdge: '#E5DDAF', cardBottomEdge: '#F2C18C', track: '#F6E4D1', progressStart: '#F8D5A8', progressEnd: '#E99A5A',
  },
  {
    name: '잔디광장', image: require('./assets/nalmoa-room-grass.png'), fadeStart: '#8B9C2C', fadeMid: '#E8EBC9',
    accent: '#78973B', accentDeep: '#5E792D', button: '#A8C94B', buttonEdge: '#94B83E', buttonText: '#34451E',
    nav: '#EFF3D9', card: '#FCFDF3', cardEdge: '#C8D79B', cardBottomEdge: '#C8D79B', track: '#E7EDC8', progressStart: '#D6E879', progressEnd: '#7EAA3E',
  },
  {
    name: '크리스마스 눈밭', image: require('./assets/nalmoa-room-snow.png'), fadeStart: '#E4D6DC', fadeMid: '#F4EFF1',
    accent: '#6B91A8', accentDeep: '#537A92', button: '#A7C7D8', buttonEdge: '#91B5C9', buttonText: '#324A57',
    nav: '#EFF5F8', card: '#FCFEFF', cardEdge: '#CADDE7', cardBottomEdge: '#CADDE7', track: '#E5EEF3', progressStart: '#B8DDEB', progressEnd: '#709DB9',
  },
  {
    name: '핑크 방', image: require('./assets/nalmoa-room-pink.png'), fadeStart: '#F7C3B7', fadeMid: '#F9E8E4',
    accent: '#C96D83', accentDeep: '#B2566E', button: '#E59AAA', buttonEdge: '#D98597', buttonText: '#4E3038',
    nav: '#F8ECEF', card: '#FFFAFB', cardEdge: '#E7C4CD', cardBottomEdge: '#E7C4CD', track: '#F3E0E5', progressStart: '#F4B5C3', progressEnd: '#D97591',
  },
];
const DESIGN = {
  color: {
    background: '#FCF9F5',
    paper: '#FFFEFC',
    primary: '#302A26',
    secondary: '#897B71',
    muted: '#B0A49A',
    apricot: '#EFA16D',
    apricotDeep: '#D77F46',
    apricotSoft: '#F7E7DA',
    success: '#64806A',
    warning: '#B95C4D',
    divider: '#EAE3DC',
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
  type: { caption: 12, body: 15, subtitle: 18, title: 23, display: 46 },
  radius: { small: 6, control: 12, sheet: 20, round: 999 },
};

const DEFAULT_DAILY_BUDGET = 30000;
const BUDGET_KEPT_MILESTONES = [3, 7, 14, 30];
const WON = new Intl.NumberFormat('ko-KR');
function progressGradient(from: string, to: string) {
  const start = Number.parseInt(from.slice(1), 16);
  const end = Number.parseInt(to.slice(1), 16);
  return Array.from({ length: 24 }, (_, index) => {
    const t = index / 23;
    const channels = [16, 8, 0].map((shift) => {
      const a = (start >> shift) & 255;
      const b = (end >> shift) & 255;
      return Math.round(a + (b - a) * t);
    });
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
  });
}

function Text({ style, ...props }: TextProps) {
  return <NativeText {...props} style={[{ fontFamily: 'Cafe24Surround' }, style]} />;
}

function EmptyRoom({ source, onLoad }: { source: number; onLoad?: () => void }) {
  return <Image source={source} style={styles.homeRoomBackground} resizeMode="contain" onLoad={onLoad} />;
}

function PuppyMascot({ size }: { size: number }) {
  return <Image source={PUPPY} accessibilityLabel="보리" style={{ width: size, height: size }} resizeMode="contain" />;
}

function growthForBalance(balance: number) {
  const saved = Math.max(0, balance);
  return { level: Math.floor(saved / 10_000) + 1, progress: saved % 10_000 };
}

function seoulDay(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function koreanDayLabel(day: string) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' })
    .format(new Date(`${day}T12:00:00+09:00`));
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
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      settled_at INTEGER
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
  const budgetColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(budget_days)');
  if (!budgetColumns.some(({ name }) => name === 'status')) {
    await db.execAsync("ALTER TABLE budget_days ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN'");
  }
  if (!budgetColumns.some(({ name }) => name === 'settled_at')) {
    await db.execAsync('ALTER TABLE budget_days ADD COLUMN settled_at INTEGER');
  }
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
  const migration = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?', 'daily_settlement_v1',
  );
  if (!migration) {
    const today = seoulDay();
    await db.withTransactionAsync(async () => {
      const days = await db.getAllAsync<{ day: string }>('SELECT day FROM budget_days ORDER BY day');
      for (const row of days) {
        const existing = await db.getFirstAsync<{ id: string }>(
          'SELECT id FROM piggy_transactions WHERE source_day = ?', row.day,
        );
        const status = statusForDay(row.day, today, Boolean(existing));
        await db.runAsync(
          'UPDATE budget_days SET status = ?, settled_at = CASE WHEN ? = \'SETTLED\' THEN COALESCE(settled_at, ?) ELSE NULL END WHERE day = ?',
          status, status, Date.now(), row.day,
        );
      }
      await rebuildPiggySettlements(db);
      await db.runAsync('INSERT INTO app_meta (key, value) VALUES (?, ?)', 'daily_settlement_v1', '1');
    });
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
      "INSERT OR IGNORE INTO budget_days (day, carry_in, allowance, created_at, status) VALUES (?, 0, ?, ?, 'OPEN')",
      today, dailyBudget, Date.now(),
    );
  } else {
    for (let dayIndex = dayNumber(latest.day) + 1; dayIndex <= dayNumber(today); dayIndex += 1) {
      const day = new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);
      await db.runAsync(
        "INSERT OR IGNORE INTO budget_days (day, carry_in, allowance, created_at, status) VALUES (?, 0, ?, ?, ?)",
        day, dailyBudget, Date.now(), day === today ? 'OPEN' : 'AWAITING_SETTLEMENT',
      );
    }
  }

  await db.runAsync('UPDATE budget_days SET allowance = ? WHERE day = ?', dailyBudget, today);

  if (!start?.value) return;
  await db.runAsync(
    "UPDATE budget_days SET status = 'AWAITING_SETTLEMENT' WHERE day >= ? AND day < ? AND status = 'OPEN'",
    start.value, today,
  );
  await db.runAsync("UPDATE budget_days SET status = 'OPEN' WHERE day = ?", today);
}

async function rebuildPiggySettlements(db: SQLiteDatabase) {
  const days = await db.getAllAsync<{ day: string; allowance: number; spent: number }>(
    `SELECT d.day, d.allowance,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
     FROM budget_days d WHERE d.status = 'SETTLED' ORDER BY d.day ASC`,
  );
  const manual = await db.getAllAsync<{ id: string; day: string; amount: number; created_at: number }>(
    "SELECT id, day, amount, created_at FROM piggy_transactions WHERE kind = 'withdrawal' AND source_day IS NULL ORDER BY day, created_at, id",
  );
  const replay = replaySettlements(days, manual.map(({ id, day, amount }) => ({ id, day, amount })));
  await db.runAsync('DELETE FROM piggy_transactions WHERE source_day IS NOT NULL');
  for (const withdrawal of replay.adjustedWithdrawals) {
    await db.runAsync('UPDATE piggy_transactions SET amount = ? WHERE id = ?', withdrawal.amount, withdrawal.id);
  }
  for (const settlement of replay.settlements) {
    await db.runAsync(
      'INSERT INTO piggy_transactions (id, day, kind, amount, source_day, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      `${settlement.kind === 'deposit' ? 'save' : 'over'}-${settlement.day}`,
      settlement.day, settlement.kind, settlement.amount, settlement.day, Date.now(),
    );
  }
}


type PiggyBankPageProps = {
  balance: number;
  transactions: PiggyTransaction[];
};

function PiggyBankPage({ balance, transactions }: PiggyBankPageProps) {
  const { level, progress } = growthForBalance(balance);
  return (
    <View style={styles.tabPage}>
      <Text style={styles.pageTitleWarm}>저금통</Text>
      <ScrollView style={styles.piggyPageScroll} contentContainerStyle={styles.piggyPageContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.piggyPageEyebrow}>모아둔 돈</Text>
        <Text style={styles.piggyPageBalance} adjustsFontSizeToFit numberOfLines={1}>{WON.format(balance)}원</Text>
        <View style={styles.piggyGrowthRow}>
          <Image source={PUPPY} style={styles.piggyMascot} resizeMode="contain" />
          <View style={styles.piggyGrowthCopy}>
            <Text style={styles.piggyGrowthName}>보리</Text>
            <Text style={styles.piggyGrowthLevel}>레벨 {level}</Text>
            <View style={styles.levelTrack}><View style={[styles.levelFill, { width: `${progress / 100}%` }]} /></View>
            <Text style={styles.levelAmount}>{WON.format(progress)} / 10,000원</Text>
          </View>
        </View>

        <Text style={styles.piggyHistoryTitle}>저금 내역</Text>
        {transactions.length ? transactions.map((transaction) => (
          <View key={transaction.id} style={styles.piggyTransactionRow}>
            <View style={styles.piggyTransactionCopy}>
              <Text style={styles.piggyTransactionTitle}>
                {transaction.kind === 'withdrawal' ? transaction.source_day ? '예산 초과 반영' : '저금통 출금' : '하루 예산 저금'}
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

function GrowthPage({ balance, weekDays, budgetKeptDays, transactions, onOpenPiggy }: {
  balance: number; weekDays: WeekDayRecord[]; budgetKeptDays: number; transactions: PiggyTransaction[]; onOpenPiggy: () => void;
}) {
  const { level, progress: levelProgress } = growthForBalance(balance);
  const weekStart = weekDays[0]?.day ?? seoulDay();
  const weekEnd = weekDays[6]?.day ?? seoulDay();
  const thisWeekNet = transactions.filter(({ day }) => day >= weekStart && day <= weekEnd)
    .reduce((sum, item) => sum + (item.kind === 'deposit' ? item.amount : -item.amount), 0);
  const keptThisWeek = weekDays.filter(({ status }) => status === 'kept').length;
  return (
    <View style={styles.tabPage}>
      <Text style={styles.pageTitleWarm}>성장 기록</Text>
      <ScrollView style={styles.piggyPageScroll} contentContainerStyle={styles.growthPageContent} showsVerticalScrollIndicator={false}>
        <View style={styles.growthCharacter}>
          <Image source={PUPPY} style={styles.growthMascot} resizeMode="contain" />
          <Text style={styles.growthTitle}>보리가 자라고 있어요</Text>
          <Text style={styles.growthLevelText}>레벨 {level}</Text>
          <Text style={styles.levelAmount}>다음 성장까지 {WON.format(10_000 - levelProgress)}원</Text>
          <View style={styles.growthProgressTrack}><View style={[styles.levelFill, { width: `${Math.min(levelProgress / 100, 100)}%` }]} /></View>
        </View>
        <View style={styles.growthWeekSection}>
          <Text style={styles.growthSectionTitle}>이번 주</Text>
          <View style={styles.growthWeekBars}>
            {weekDays.map(({ day, label, status }) => {
              const amount = transactions.filter((item) => item.day === day)
                .reduce((sum, item) => sum + (item.kind === 'deposit' ? item.amount : -item.amount), 0);
              const barHeight = amount > 0 ? Math.max(14, Math.min(64, 14 + (amount / Math.max(thisWeekNet, 1)) * 42)) : 14;
              return <View key={day} style={styles.growthBarColumn}>
                <View style={[styles.growthBar, { height: barHeight }, status === 'over' && styles.growthBarOver]} />
                <Text style={styles.weeklyDayLabel}>{label}</Text>
              </View>;
            })}
          </View>
        </View>
        <View style={styles.growthStatRow}><Text style={styles.growthStatName}>이번 주 저금</Text><Text style={styles.growthStatValue}>{WON.format(thisWeekNet)}원</Text></View>
        <View style={styles.growthStatRow}><Text style={styles.growthStatName}>예산 지킨 날</Text><Text style={styles.growthStatValue}>{budgetKeptDays}일</Text></View>
        <View style={styles.growthStatRow}><Text style={styles.growthStatName}>이번 주 기록</Text><Text style={styles.growthStatValue}>{keptThisWeek}일</Text></View>
        <Pressable accessibilityRole="button" onPress={onOpenPiggy} style={styles.growthHistoryLink}><Text style={styles.growthHistoryLinkText}>저금통 내역 보기  ›</Text></Pressable>
      </ScrollView>
    </View>
  );
}

function ProfilePage({ dailyBudget, onEditBudget, onOpenHistory }: { dailyBudget: number; onEditBudget: () => void; onOpenHistory: () => void }) {
  return (
    <View style={styles.tabPage}>
      <Text style={styles.pageTitleWarm}>설정</Text>
      <ScrollView style={styles.piggyPageScroll} contentContainerStyle={styles.profilePageContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.profileSectionTitle}>하루 예산</Text>
        <Pressable accessibilityRole="button" onPress={onEditBudget} style={styles.profileRow}>
          <Text style={styles.profileRowTitle}>오늘 기준 예산</Text><Text style={styles.profileRowValue}>{WON.format(dailyBudget)}원  ›</Text>
        </Pressable>
        <Text style={styles.profileSectionTitle}>기록</Text>
        <Pressable accessibilityRole="button" onPress={onOpenHistory} style={styles.profileRow}>
          <Text style={styles.profileRowTitle}>전체 지출 내역</Text><Text style={styles.profileRowValue}>보기  ›</Text>
        </Pressable>
        <Text style={styles.profileSectionTitle}>앱 정보</Text>
        <View style={styles.profileInfoRow}><Text style={styles.profileRowTitle}>날모아</Text><Text style={styles.profileRowDetail}>매일의 작은 선택을 모아요</Text></View>
      </ScrollView>
    </View>
  );
}

function Home() {
  const db = useSQLiteContext();
  const { width, height } = useWindowDimensions();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');
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
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [activeRoomThemeIndex, setActiveRoomThemeIndex] = useState(0);
  const [uiThemeIndex, setUiThemeIndex] = useState(0);
  const [incomingRoomThemeIndex, setIncomingRoomThemeIndex] = useState<number | null>(null);
  const roomThemeOpacity = useRef(new Animated.Value(0)).current;
  const roomThemeTransitionLock = useRef(false);
  const roomThemeTransitionStarted = useRef(false);
  const loadedRoomThemes = useRef(new Set<number>());
  const incomingRoomThemeRef = useRef<number | null>(null);
  const [showingHistory, setShowingHistory] = useState(false);
  const [pendingSettlementDay, setPendingSettlementDay] = useState<string | null>(null);
  const [settlementData, setSettlementData] = useState<{ allowance: number; spent: number; piggyBalance: number; expenses: Expense[] } | null>(null);
  const [historyRows, setHistoryRows] = useState<Array<{ day: string; allowance: number; spent: number; status: SettlementStatus; expenses: Expense[] }>>([]);
  const [historyExpandedDay, setHistoryExpandedDay] = useState<string | null>(null);
  const [expenseEntryDay, setExpenseEntryDay] = useState<string | null>(null);
  const [historySelectedDay, setHistorySelectedDay] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const [pendingResult, setPendingResult] = useState<ResultSummary | null>(null);
  const currentDay = useRef(seoulDay());
  const animatedProgress = useRef(new Animated.Value(1)).current;
  const rewardScale = useRef(new Animated.Value(0.88)).current;

  const refresh = useCallback(async () => {
    const today = seoulDay();
    currentDay.current = today;
    const setting = await db.getFirstAsync<{ daily_budget: number }>('SELECT daily_budget FROM settings WHERE id = 1');
    const dailyBudget = setting?.daily_budget ?? DEFAULT_DAILY_BUDGET;
    await ensureDaysAndSavePastRemainders(db, today, dailyBudget);
    await db.runAsync('INSERT OR IGNORE INTO activity_days (day) VALUES (?)', today);

    const nextSettlement = await db.getFirstAsync<{ day: string }>(
      "SELECT day FROM budget_days WHERE day < ? AND status = 'AWAITING_SETTLEMENT' ORDER BY day ASC LIMIT 1", today,
    );
    setPendingSettlementDay(nextSettlement?.day ?? null);
    if (nextSettlement) {
      const pending = await db.getFirstAsync<{ allowance: number; spent: number }>(
        `SELECT d.allowance, COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
         FROM budget_days d WHERE d.day = ?`, nextSettlement.day,
      );
      const balance = await db.getFirstAsync<{ value: number }>(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE -amount END), 0) AS value
         FROM piggy_transactions`,
      );
      const pendingExpenses = await db.getAllAsync<{ id: string; day: string; amount: number; purpose: string; created_at: number }>(
        'SELECT id, day, amount, purpose, created_at FROM expenses WHERE day = ? ORDER BY created_at DESC', nextSettlement.day,
      );
      setSettlementData({ allowance: pending?.allowance ?? dailyBudget, spent: pending?.spent ?? 0, piggyBalance: Math.max(0, balance?.value ?? 0),
        expenses: pendingExpenses.map(({ id, day, amount: value, purpose: note, created_at }) => ({ id, day, amount: value, purpose: note, createdAt: created_at })) });
    } else {
      setSettlementData(null);
    }

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
    const expenses = await db.getAllAsync<{ id: string; day: string; amount: number; purpose: string; created_at: number }>(
      'SELECT id, day, amount, purpose, created_at FROM expenses WHERE day = ? ORDER BY created_at DESC', today,
    );
    if (showingHistory) {
      const rows = await db.getAllAsync<{ day: string; allowance: number; spent: number; status: SettlementStatus }>(
        `SELECT d.day, d.allowance, d.status,
          COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.day = d.day), 0) AS spent
         FROM budget_days d WHERE d.day <= ? ORDER BY d.day DESC`, today,
      );
      const history: typeof historyRows = [];
      for (const row of rows) {
        const dayExpenses = await db.getAllAsync<{ id: string; day: string; amount: number; purpose: string; created_at: number }>(
          'SELECT id, day, amount, purpose, created_at FROM expenses WHERE day = ? ORDER BY created_at DESC', row.day,
        );
        history.push({ ...row, expenses: dayExpenses.map(({ id, day, amount: value, purpose: note, created_at }) => ({ id, day, amount: value, purpose: note, createdAt: created_at })) });
      }
      setHistoryRows(history);
    }
    const piggyTransactions = await db.getAllAsync<PiggyTransaction>(
      `SELECT id, day, kind, amount, source_day FROM piggy_transactions
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
         COALESCE(SUM(CASE WHEN p.kind = 'deposit' THEN p.amount WHEN p.kind = 'withdrawal' THEN -p.amount ELSE 0 END), 0) AS saved_amount,
         COALESCE(SUM(CASE WHEN a.day IS NOT NULL THEN 1 ELSE 0 END), 0) AS active_days,
         COALESCE(SUM(CASE WHEN a.day IS NOT NULL AND t.spent <= t.allowance THEN 1 ELSE 0 END), 0) AS kept_days
       FROM day_totals t
         JOIN budget_days settled ON settled.day = t.day AND settled.status = 'SETTLED'
         LEFT JOIN piggy_transactions p ON p.source_day = t.day
       LEFT JOIN activity_days a ON a.day = t.day`,
      progressStartDay, resultCursor?.value ?? '0000-00-00', today,
    );
    if (!nextSettlement && pending?.completed_days && pending.through_day) {
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
    } else if (nextSettlement) {
      setPendingResult(null);
    }
    setLedger({ dailyBudget, allowance: day?.allowance ?? dailyBudget, spent: day?.spent ?? 0,
      piggyBalance: piggy?.balance ?? 0,
      budgetKeptDays: progress?.budget_kept_days ?? 0,
      weekDays,
      expenses: expenses.map(({ id, day, amount: value, purpose: note, created_at }) =>
        ({ id, day, amount: value, purpose: note, createdAt: created_at })),
      piggyTransactions,
    });
    setInitialized(true);
  }, [db, showingHistory]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (activeTab === 'home') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setActiveTab('home');
      return true;
    });
    return () => subscription.remove();
  }, [activeTab]);

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

  const openExpenseSheet = () => {
    expenseSheetMotion.setValue(0);
    setExpenseSheetMounted(true);
    setAddingExpense(true);
  };

  const dismissExpenseSheet = () => {
    setAddingExpense(false);
    setExpenseEntryDay(null);
  };

  const openBudgetEditor = () => {
    setBudgetDraft(String(ledger?.dailyBudget ?? DEFAULT_DAILY_BUDGET));
    setBudgetEdit(true);
  };

  const openExpenseHistory = (day = seoulDay()) => {
    expenseHistoryMotion.setValue(0);
    setHistorySelectedDay(day);
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
    const today = expenseEntryDay ?? seoulDay();
    if (today > seoulDay()) {
      Alert.alert('미래 날짜는 기록할 수 없어요');
      return;
    }
    await db.runAsync('INSERT OR IGNORE INTO budget_days (day, carry_in, allowance, created_at, status) VALUES (?, 0, ?, ?, ?)',
      today, ledger?.dailyBudget ?? DEFAULT_DAILY_BUDGET, Date.now(), today === seoulDay() ? 'OPEN' : 'AWAITING_SETTLEMENT');
    await db.runAsync('INSERT INTO expenses (id, day, amount, purpose, created_at) VALUES (?, ?, ?, ?, ?)',
      `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, today, value, note, Date.now());
    setAmount('');
    setPurpose('');
    dismissExpenseSheet();
    setExpenseEntryDay(null);
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
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE expenses SET amount = ?, purpose = ? WHERE id = ?', value, note, editingExpenseId);
      await rebuildPiggySettlements(db);
    });
    cancelExpenseEdit();
    await refresh();
  };

  const deleteExpense = async (expense: Expense) => {
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM expenses WHERE id = ?', expense.id);
      await rebuildPiggySettlements(db);
    });
    await refresh();
  };

  const openExpenseEntry = (day = seoulDay()) => {
    setExpenseEntryDay(day);
    openExpenseSheet();
  };

  const settlePendingDay = async () => {
    if (!pendingSettlementDay || !settlementData || settling) return;
    setSettling(true);
    try {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          "UPDATE budget_days SET status = 'SETTLED', settled_at = ? WHERE day = ? AND status = 'AWAITING_SETTLEMENT'",
          Date.now(), pendingSettlementDay,
        );
        await rebuildPiggySettlements(db);
      });
      await refresh();
    } finally {
      setSettling(false);
    }
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
  const settlementPreview = settlementData ? calculateSettlement({
    allowance: settlementData.allowance,
    spent: settlementData.spent,
    piggyBalance: settlementData.piggyBalance,
  }) : null;
  const selectedHistory = historyRows.find(({ day }) => day === historySelectedDay);
  const visibleExpenses = historySelectedDay === seoulDay() ? (ledger?.expenses ?? [])
    : selectedHistory?.expenses ?? [];
  const visibleSpent = historySelectedDay === seoulDay() ? (ledger?.spent ?? 0) : selectedHistory?.spent ?? 0;
  const total = ledger?.allowance ?? 0;
  const progress = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  useEffect(() => {
    if (!ledger) return;
    const animation = Animated.timing(animatedProgress, {
      toValue: progress,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [animatedProgress, ledger, progress]);

  useEffect(() => {
    if (!pendingResult) return;
    rewardScale.setValue(0.84);
    const animation = Animated.spring(rewardScale, { toValue: 1, friction: 4, tension: 80, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [pendingResult, rewardScale]);

  const homeProgressWidth = Math.max(0, width - 84);
  const homePuppySize = Math.min(width * 0.44, 172);
  const roomTheme = ROOM_THEMES[uiThemeIndex];
  const themeProgressColors = useMemo(
    () => progressGradient(roomTheme.progressStart, roomTheme.progressEnd),
    [roomTheme.progressStart, roomTheme.progressEnd],
  );
  const beginRoomThemeTransition = (nextIndex: number) => {
    if (!roomThemeTransitionLock.current || roomThemeTransitionStarted.current || incomingRoomThemeRef.current !== nextIndex) return;
    roomThemeTransitionStarted.current = true;
    setUiThemeIndex(nextIndex);
    Animated.timing(roomThemeOpacity, {
      toValue: 1,
      duration: 420,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setActiveRoomThemeIndex(nextIndex);
      incomingRoomThemeRef.current = null;
      setIncomingRoomThemeIndex(null);
      roomThemeTransitionStarted.current = false;
      roomThemeTransitionLock.current = false;
    });
  };
  const requestRoomTheme = (direction: number) => {
    if (roomThemeTransitionLock.current) return;
    const nextIndex = (activeRoomThemeIndex + direction + ROOM_THEMES.length) % ROOM_THEMES.length;
    roomThemeTransitionLock.current = true;
    roomThemeTransitionStarted.current = false;
    roomThemeOpacity.setValue(0);
    incomingRoomThemeRef.current = nextIndex;
    setIncomingRoomThemeIndex(nextIndex);
    if (loadedRoomThemes.current.has(nextIndex)) beginRoomThemeTransition(nextIndex);
  };
  const currentGrowth = growthForBalance(ledger?.piggyBalance ?? 0);
  return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.screen, activeTab === 'home' && !pendingSettlementDay && !showingHistory && styles.homeScreen]}>
            <View pointerEvents="none" style={[styles.roomThemePreloader, { width, height: width }]}>
              {ROOM_THEMES.map((theme, themeIndex) => <Image key={`preload-room-${themeIndex}`} source={theme.image}
                resizeMode="contain" onLoad={() => loadedRoomThemes.current.add(themeIndex)}
                style={[StyleSheet.absoluteFill, { width, height: width }]} />)}
            </View>
            {!initialized ? (
              <View style={styles.fullPage}><Text style={styles.pageHeading}>불러오는 중…</Text></View>
            ) : pendingSettlementDay ? (
              <View style={styles.settlementPage}>
                <Text style={styles.pageDate}>{koreanDayLabel(pendingSettlementDay)} 정산</Text>
                {settlementData ? <>
                  <ScrollView style={styles.settlementScroll} contentContainerStyle={styles.settlementContent} showsVerticalScrollIndicator={false}>
                    <Text style={styles.settlementHeadline}>
                      {settlementPreview && settlementPreview.saved > 0
                        ? `${WON.format(settlementPreview.saved)}원을 남겼어요.`
                        : settlementPreview && settlementPreview.deducted > 0
                          ? `예산보다 ${WON.format(settlementData.spent - settlementData.allowance)}원 더 썼어요.`
                          : '어제 예산을 모두 사용했어요.'}
                    </Text>
                    <Image source={PUPPY} style={styles.settlementPuppy} resizeMode="contain" />
                    <Text style={styles.settlementPrompt}>
                      {settlementPreview && settlementPreview.saved > 0 ? '보리에게 줄까요?' : '보리와 함께 다시 시작해요.'}
                    </Text>
                    <View style={styles.settlementDetails}>
                      <View style={styles.settlementDetailRow}><Text style={styles.settlementLabel}>하루 예산</Text><Text style={styles.settlementDetailValue}>{WON.format(settlementData.allowance)}원</Text></View>
                      <View style={styles.settlementDetailRow}><Text style={styles.settlementLabel}>기록한 지출</Text><Text style={styles.settlementDetailValue}>{WON.format(settlementData.spent)}원</Text></View>
                      {settlementData.expenses.map((expense) => <View key={expense.id} style={styles.settlementExpenseRow}>
                        <Text style={styles.settlementExpenseName}>{expense.purpose || '사용처 미입력'}</Text>
                        <Text style={styles.settlementExpenseAmount}>−{WON.format(expense.amount)}원</Text>
                      </View>)}
                    </View>
                    {settlementPreview && settlementPreview.deducted > 0 && settlementData.spent - settlementData.allowance > settlementPreview.deducted &&
                      <Text style={styles.settlementFootnote}>저금통 잔액을 넘는 초과분은 다음 날 예산에 더하지 않아요.</Text>}
                  </ScrollView>
                  <Pressable accessibilityRole="button" onPress={() => openExpenseEntry(pendingSettlementDay)} style={styles.settlementTextAction}>
                    <Text style={styles.settlementTextActionLabel}>지출 추가</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={settling} onPress={() => void settlePendingDay()} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>{settling ? '정산 중…' : settlementPreview && settlementPreview.saved > 0 ? '저금하기' : '정산 완료'}</Text>
                  </Pressable>
                </> : <Text style={styles.pageDate}>정산 정보를 불러오고 있어요.</Text>}
              </View>
            ) : showingHistory ? (
              <View style={styles.recordsPage}>
                <View style={styles.recordsHeader}>
                  <Pressable accessibilityRole="button" accessibilityLabel="설정으로 돌아가기" onPress={() => setShowingHistory(false)} style={styles.recordsBack}><Text style={styles.recordsBackText}>‹</Text></Pressable>
                  <Text style={styles.pageTitleWarm}>지출 기록</Text>
                  <View style={styles.recordsBack} />
                </View>
                <ScrollView style={styles.piggyPageScroll} contentContainerStyle={styles.historyPageContent} showsVerticalScrollIndicator={false}>
                  {historyRows.map((row) => <View key={row.day} style={styles.recordDaySection}>
                    <Pressable accessibilityRole="button" onPress={() => setHistoryExpandedDay(historyExpandedDay === row.day ? null : row.day)} style={styles.historyDayHeader}>
                      <View>
                        <Text style={styles.historyDayTitle}>{koreanDayLabel(row.day)}</Text>
                        <Text style={styles.historyDayStatus}>{row.status === 'SETTLED' ? '정산 완료' : row.day === seoulDay() ? '오늘' : '정산 대기'}</Text>
                      </View>
                      <View style={styles.recordsDayTotal}>
                        <Text style={styles.historyDayMeta}>지출</Text>
                        <Text style={styles.historyDayAmount}>{WON.format(row.spent)}원</Text>
                      </View>
                    </Pressable>
                    {historyExpandedDay === row.day && <View style={styles.historyDayBody}>
                      {row.expenses.length ? row.expenses.map((expense) => <View key={expense.id} style={styles.historyExpenseRow}>
                        <View style={styles.historyExpenseCopy}><Text style={styles.historyExpenseName}>{expense.purpose || '사용처 미입력'}</Text><Text style={styles.expenseTime}>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(expense.createdAt)}</Text></View>
                        <Text style={styles.historyExpenseAmount}>−{WON.format(expense.amount)}원</Text>
                      </View>) : <Text style={styles.historyNoExpenses}>지출 기록 없음</Text>}
                      <Pressable accessibilityRole="button" onPress={() => openExpenseHistory(row.day)} style={styles.historyEditButton}><Text style={styles.historyEditText}>내역 열기</Text></Pressable>
                    </View>}
                  </View>)}
                </ScrollView>
              </View>
            ) : activeTab === 'growth' ? (
              <GrowthPage balance={ledger?.piggyBalance ?? 0} weekDays={ledger?.weekDays ?? []}
                budgetKeptDays={ledger?.budgetKeptDays ?? 0} transactions={ledger?.piggyTransactions ?? []}
                onOpenPiggy={() => setActiveTab('piggy')} />
            ) : activeTab === 'piggy' ? (
              <PiggyBankPage balance={ledger?.piggyBalance ?? 0}
                transactions={ledger?.piggyTransactions ?? []} />
            ) : activeTab === 'profile' ? (
              <ProfilePage dailyBudget={ledger?.dailyBudget ?? DEFAULT_DAILY_BUDGET}
                onEditBudget={() => { setActiveTab('home'); openBudgetEditor(); }}
                onOpenHistory={() => setShowingHistory(true)} />
            ) : <View style={styles.homePage}>
              {budgetEdit && <Pressable accessibilityRole="button" accessibilityLabel="예산 저장하고 닫기"
                onPress={() => void saveBudget()} style={styles.budgetSaveBackdrop} />}
              <ScrollView style={styles.homeScroll} contentContainerStyle={styles.homeScrollContent} showsVerticalScrollIndicator={false} bounces={false} alwaysBounceVertical={false}>
                <View style={[styles.homeRoomStage, { width, height: width }]}>
                  <View style={[styles.homeRoomComposition, { width, height: width }]}>
                    {ROOM_THEMES.map((theme, themeIndex) => {
                      const isIncoming = incomingRoomThemeIndex === themeIndex;
                      const isActive = activeRoomThemeIndex === themeIndex;
                      const opacity = isIncoming
                        ? roomThemeOpacity
                        : isActive && incomingRoomThemeIndex !== null
                          ? roomThemeOpacity.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })
                          : isActive ? 1 : 0;
                      const zIndex = isIncoming ? 2 : isActive ? 1 : 0;
                      return <Animated.View key={`room-scene-${themeIndex}`} pointerEvents="none"
                        style={[styles.homeRoomImageLayer, { width, height: width * 1.55, opacity, zIndex }]}>
                        <View style={[styles.homeRoomImageViewport, { width, height: width }]}>
                          <EmptyRoom source={theme.image} onLoad={() => {
                            loadedRoomThemes.current.add(themeIndex);
                            if (incomingRoomThemeRef.current === themeIndex) beginRoomThemeTransition(themeIndex);
                          }} />
                        </View>
                        <LinearGradient
                          colors={[theme.fadeStart, theme.fadeMid, DESIGN.color.background]}
                          locations={[0, 0.52, 1]}
                          start={{ x: 0.5, y: 0 }}
                          end={{ x: 0.5, y: 1 }}
                          style={[styles.homeRoomFade, { top: width, height: width * 0.55 }]}
                        />
                      </Animated.View>;
                    })}
                    <Pressable accessibilityRole="button" accessibilityLabel={`이전 테마: ${roomTheme.name}`}
                      onPress={() => requestRoomTheme(-1)}
                      style={[styles.roomThemeArrow, styles.roomThemeArrowLeft]}>
                      <NativeText style={styles.roomThemeArrowText}>‹</NativeText>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`다음 테마: ${roomTheme.name}`}
                      onPress={() => requestRoomTheme(1)}
                      style={[styles.roomThemeArrow, styles.roomThemeArrowRight]}>
                      <NativeText style={styles.roomThemeArrowText}>›</NativeText>
                    </Pressable>
                    <View pointerEvents="none" style={[styles.homeRoomPuppyPosition, { bottom: width * 0.1 }]}>
                      <PuppyMascot size={homePuppySize} />
                    </View>
                  </View>
                </View>
                <View style={styles.homeOverlayContent}>
                <Pressable accessibilityRole="button" accessibilityLabel="오늘 지출 내역 보기"
                  onPress={() => budgetEdit ? void saveBudget() : openExpenseHistory()}
                  style={({ pressed }) => [styles.homeBudgetPanel, {
                    backgroundColor: roomTheme.card,
                    borderColor: roomTheme.cardEdge,
                    borderBottomColor: pressed ? 'transparent' : roomTheme.cardBottomEdge,
                    transform: [{ translateY: pressed ? 6 : 0 }],
                  }]}>
                  <View style={styles.homeBudgetPanelContent}>
                    {budgetEdit ? <View style={[styles.homeBudgetEdit, { borderBottomColor: roomTheme.accent }]}>
                      <TextInput accessibilityLabel="하루 예산" autoFocus keyboardType="number-pad" value={budgetDraft}
                        onChangeText={setBudgetDraft} onEndEditing={() => void saveBudget()} style={styles.budgetEditorInput} />
                      <Text style={styles.budgetUnit}>원</Text>
                    </View> : <View style={styles.remainingAmountRow}>
                      <Text style={[styles.balance, remaining < 0 && styles.overBudget]} adjustsFontSizeToFit numberOfLines={1}>
                        {WON.format(remaining)}원
                      </Text>
                      <Text style={styles.allowanceText}>/ {WON.format(ledger?.allowance ?? DEFAULT_DAILY_BUDGET)}원</Text>
                    </View>}
                    <View style={styles.homeProgressRow}>
                      <View style={[styles.progressTrack, { width: homeProgressWidth, backgroundColor: roomTheme.track }]}>
                        <Animated.View style={[styles.progressFill, {
                          width: animatedProgress.interpolate({ inputRange: [0, 1], outputRange: [0, homeProgressWidth] }),
                        }]}>
                          {remaining < 0 ? <View style={styles.progressFillOver} /> : <>
                            <View style={styles.progressGradientRow}>
                              {themeProgressColors.map((color, index) => <View key={index} style={{ flex: 1, backgroundColor: color }} />)}
                            </View>
                            <View style={styles.progressSheen} />
                          </>}
                        </Animated.View>
                      </View>
                    </View>
                  </View>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="지출 기록하기"
                  onPress={addingExpense ? dismissExpenseSheet : openExpenseSheet}
                  style={({ pressed }) => [styles.homeExpenseButton, {
                    backgroundColor: roomTheme.button,
                    borderColor: roomTheme.cardEdge,
                    borderBottomColor: pressed ? 'transparent' : roomTheme.buttonEdge,
                    transform: [{ translateY: pressed ? 6 : 0 }],
                  }]}>
                  <Text style={[styles.homeExpenseButtonText, { color: roomTheme.buttonText }]}>지출 기록</Text>
                </Pressable>
                </View>
              </ScrollView>
            </View>}
          </View>
        </KeyboardAvoidingView>
        {initialized && !pendingSettlementDay && !showingHistory && <View style={[styles.bottomAction, { backgroundColor: roomTheme.nav }]}>
          {([
            { key: 'home' as const, label: '홈' },
            { key: 'growth' as const, label: '성장 기록' },
            { key: 'piggy' as const, label: '저금통' },
            { key: 'profile' as const, label: '프로필' },
          ]).map(({ key, label }) => <Pressable key={key} accessibilityRole="button"
            accessibilityLabel={`${label} 탭`} accessibilityState={{ selected: activeTab === key }}
            onPress={() => setActiveTab(key)} style={styles.navItem}>
              <View style={styles.navTabContent}>
                <Image source={NAV_IMAGES[key]} resizeMode="contain"
                  style={[styles.navIconImage, { tintColor: activeTab === key ? roomTheme.accentDeep : DESIGN.color.muted }]} />
                <Text style={[styles.navLabel, activeTab === key && styles.navLabelActive, activeTab === key && { color: roomTheme.accentDeep }]}>{label}</Text>
              </View>
            </Pressable>)}
        </View>}
        {expenseSheetMounted && <Animated.View style={[styles.expenseBackdropLayer, { opacity: expenseSheetMotion }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="지출 입력 닫기"
            onPress={dismissExpenseSheet}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>}
        {expenseSheetMounted && <KeyboardAvoidingView
          pointerEvents="box-none"
          style={styles.expenseSheetKeyboardAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Animated.View style={[
            styles.expenseSheet,
            {
              backgroundColor: roomTheme.card,
              opacity: expenseSheetMotion,
              transform: [{ translateY: expenseSheetMotion.interpolate({ inputRange: [0, 1], outputRange: [32, 0] }) }],
            },
          ]}>
          <View style={styles.expenseSheetHeader}>
            <Text style={styles.expenseSheetTitle}>지출 기록</Text>
            <Pressable onPress={dismissExpenseSheet}><Text style={[styles.editLink, { color: roomTheme.accentDeep }]}>닫기</Text></Pressable>
          </View>
          <TextInput accessibilityLabel="지출 금액" keyboardType="number-pad" value={amount} onChangeText={setAmount} placeholder="금액 (원)" selectionColor={roomTheme.accentDeep} style={[styles.input, styles.expenseInput, { borderBottomColor: roomTheme.cardEdge }]} />
          <TextInput accessibilityLabel="사용처" value={purpose} onChangeText={setPurpose} placeholder="사용처 (선택)" selectionColor={roomTheme.accentDeep} style={[styles.input, styles.expenseInput, { borderBottomColor: roomTheme.cardEdge }]} maxLength={60} returnKeyType="done" />
          <Pressable onPress={() => void addExpense()} style={[styles.primaryButton, styles.expenseSubmitButton, { backgroundColor: roomTheme.button }]}>
            <Text style={[styles.primaryButtonText, { color: roomTheme.buttonText }]}>기록</Text>
          </Pressable>
          </Animated.View>
        </KeyboardAvoidingView>}
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
                  <Text style={styles.sheetTitle}>{editingExpenseId ? '지출 수정' : historySelectedDay === seoulDay() ? '오늘 내역' : `${historySelectedDay?.replaceAll('-', '.')} 내역`}</Text>
                  {editingExpenseId && <Text style={styles.sheetSubtitle}>금액과 사용처를 수정해요</Text>}
                </View>
                <Pressable accessibilityRole="button" onPress={closeExpenseHistory} style={styles.closeButton}>
                  <Text style={styles.closeButtonText}>닫기</Text>
                </Pressable>
              </View>
              <View style={styles.sheetSummary}>
                <Text style={styles.sheetSummaryLabel}>{historySelectedDay === seoulDay() ? '오늘 사용' : '해당 날짜 사용'}</Text>
                <Text style={styles.sheetSummaryAmount}>{WON.format(visibleSpent)}원</Text>
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
              ) : visibleExpenses.length ? (
                <ScrollView style={styles.expenseList} contentContainerStyle={styles.expenseListContent} showsVerticalScrollIndicator={false}>
                  {visibleExpenses.map((expense) => (
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
                  <Text style={styles.emptyExpensesText}>이 날짜에 기록된 지출이 없어요.</Text>
                </View>
              )}
            </Animated.View>
          </KeyboardAvoidingView>
        </Modal>
        <Modal visible={pendingResult !== null} animationType="fade" onRequestClose={() => void acknowledgeResult()}>
          <View style={styles.resultModalRoot}>
            <View style={styles.resultCard}>
              <Animated.Image source={PUPPY} style={[styles.resultMascot, { transform: [{ scale: rewardScale }] }]} resizeMode="contain" />
              <Text style={styles.resultEyebrow}>하루 정산</Text>
              <Text style={styles.resultTitle}>
                {(pendingResult?.savedAmount ?? 0) > 0
                  ? `${WON.format(pendingResult?.savedAmount ?? 0)}원, 보리와 모았어요`
                  : (pendingResult?.savedAmount ?? 0) < 0
                    ? `예산보다 ${WON.format(Math.abs(pendingResult?.savedAmount ?? 0))}원 더 썼어요`
                    : '오늘 예산을 모두 사용했어요'}
              </Text>
              <Text style={styles.resultDescription}>{pendingResult?.completedDays ?? 0}일 정산을 마쳤어요.</Text>
              <View style={styles.resultGrowth}>
                <Text style={styles.resultProgressLabel}>다음 성장까지 {WON.format(10_000 - currentGrowth.progress)}원</Text>
                <View style={styles.resultLevelTrack}><View style={[styles.levelFill, { width: `${currentGrowth.progress / 100}%` }]} /></View>
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
  const [fontsLoaded] = useFonts({ Cafe24Surround: require('./assets/fonts/Cafe24Surround.ttf') });
  if (!fontsLoaded) return null;
  return <SQLiteProvider databaseName="oneul-budget.db" onInit={initialize}><Home /></SQLiteProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: DESIGN.color.background },
  flex: { flex: 1 },
  screen: { flex: 1, alignItems: 'stretch', paddingHorizontal: DESIGN.space.lg, backgroundColor: DESIGN.color.background },
  homeScreen: { paddingHorizontal: 0 },
  roomThemePreloader: { position: 'absolute', top: 0, left: 0, opacity: 0, zIndex: -1 },
  homePage: { flex: 1, width: '100%' },
  homeScroll: { flex: 1, width: '100%' },
  homeScrollContent: { alignItems: 'center', paddingHorizontal: DESIGN.space.lg, paddingTop: DESIGN.space.sm, paddingBottom: 84 },
  homeRoomStage: { alignSelf: 'center', position: 'relative', overflow: 'visible', marginBottom: DESIGN.space.lg },
  homeRoomComposition: { alignSelf: 'center', aspectRatio: 1, position: 'relative', overflow: 'visible' },
  homeRoomBackground: { width: '100%', height: '100%' },
  homeRoomImageLayer: { position: 'absolute', top: 0, left: 0 },
  homeRoomImageViewport: { position: 'absolute', top: 0, left: 0 },
  roomThemeArrow: { position: 'absolute', top: '50%', width: 32, height: 40, marginTop: -20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', zIndex: 4 },
  roomThemeArrowLeft: { left: 10 },
  roomThemeArrowRight: { right: 10 },
  roomThemeArrowText: { color: DESIGN.color.secondary, fontSize: 23, lineHeight: 28, fontWeight: '300', textAlign: 'center' },
  homeRoomFade: { position: 'absolute', left: 0, right: 0, width: '100%' },
  homeRoomPuppyPosition: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 3 },
  homeOverlayContent: { alignSelf: 'stretch', marginTop: -40, zIndex: 2 },
  homeBudgetPanel: { width: '100%', minHeight: 88, flexDirection: 'row', alignItems: 'center', paddingHorizontal: DESIGN.space.md, paddingVertical: DESIGN.space.sm, backgroundColor: DESIGN.color.paper, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: DESIGN.color.divider, borderBottomWidth: 6, borderBottomColor: '#E5DDAF', zIndex: 2 },
  homeBudgetPanelContent: { flex: 1, gap: DESIGN.space.xs },
  remainingAmountRow: { flexDirection: 'row', alignItems: 'baseline', gap: DESIGN.space.xs },
  balance: { color: DESIGN.color.primary, fontSize: 21, lineHeight: 26, fontWeight: '800', letterSpacing: -0.5 },
  allowanceText: { color: DESIGN.color.secondary, fontSize: 11, fontWeight: '500' },
  homeProgressRow: { flexDirection: 'row', alignItems: 'center' },
  overBudget: { color: DESIGN.color.warning },
  progressTrack: { alignSelf: 'stretch', height: 14, backgroundColor: '#F8EDC5', borderRadius: DESIGN.radius.round, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: DESIGN.radius.round, overflow: 'hidden' },
  progressGradientRow: { ...StyleSheet.absoluteFill, flexDirection: 'row' },
  progressSheen: { position: 'absolute', top: 2, left: 5, right: 5, height: 4, backgroundColor: 'rgba(255,255,255,0.48)', borderRadius: DESIGN.radius.round },
  progressFillOver: { ...StyleSheet.absoluteFill, backgroundColor: DESIGN.color.warning },
  homeExpenseButton: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', minHeight: 54, backgroundColor: DESIGN.color.apricot, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: DESIGN.color.divider, borderBottomWidth: 6, borderBottomColor: '#E5DDAF', marginTop: DESIGN.space.md, zIndex: 2 },
  homeExpenseButtonText: { color: DESIGN.color.primary, fontSize: DESIGN.type.subtitle, fontWeight: '800' },
  homeBudgetEdit: { width: '100%', maxWidth: 260, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: DESIGN.color.apricot, marginTop: DESIGN.space.xs },
  budgetEditorInput: { minWidth: 100, paddingVertical: DESIGN.space.xs, textAlign: 'center', color: DESIGN.color.primary, fontSize: DESIGN.type.subtitle, fontWeight: '700', fontFamily: 'Cafe24Surround' },
  budgetUnit: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, fontWeight: '600' },
  budgetSaveBackdrop: { ...StyleSheet.absoluteFill, zIndex: 1 },

  bottomAction: { position: 'absolute', zIndex: 1, left: 0, right: 0, bottom: Platform.OS === 'ios' ? 2 : 6, height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: '#F5EEE4' },
  navItem: { flex: 1, height: 56, alignItems: 'center', justifyContent: 'center' },
  navTabContent: { minWidth: 46, alignItems: 'center', justifyContent: 'center', gap: 2 },
  navIconImage: { width: 24, height: 24 },
  navLabel: { color: DESIGN.color.muted, fontSize: 10, fontWeight: '500' },
  navLabelActive: { color: DESIGN.color.apricotDeep, fontWeight: '700' },

  tabPage: { flex: 1, width: '100%' },
  pageTitleWarm: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, fontWeight: '700', textAlign: 'center', marginTop: DESIGN.space.sm, marginBottom: DESIGN.space.lg },
  piggyPageScroll: { flex: 1 },
  piggyPageContent: { paddingBottom: 80 },
  piggyPageEyebrow: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, fontWeight: '600', marginTop: DESIGN.space.sm },
  piggyPageBalance: { color: DESIGN.color.primary, fontSize: 48, lineHeight: 56, fontWeight: '800', letterSpacing: -1.4, marginTop: DESIGN.space.xs },
  piggyGrowthRow: { flexDirection: 'row', alignItems: 'center', gap: DESIGN.space.md, marginTop: DESIGN.space.lg, paddingBottom: DESIGN.space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  piggyMascot: { width: 148, height: 148 },
  piggyGrowthCopy: { flex: 1, gap: DESIGN.space.xs },
  piggyGrowthName: { color: DESIGN.color.primary, fontSize: DESIGN.type.subtitle, fontWeight: '700' },
  piggyGrowthLevel: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  levelTrack: { height: 3, backgroundColor: DESIGN.color.divider, overflow: 'hidden', marginTop: DESIGN.space.xs },
  levelFill: { height: '100%', backgroundColor: DESIGN.color.apricot },
  levelAmount: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, fontWeight: '500' },
  piggyHistoryTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.subtitle, fontWeight: '700', marginTop: DESIGN.space.xl, marginBottom: DESIGN.space.sm },
  piggyTransactionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58, paddingVertical: DESIGN.space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  piggyTransactionCopy: { flex: 1, gap: DESIGN.space.xs },
  piggyTransactionTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600' },
  piggyTransactionDate: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  piggyTransactionAmount: { color: DESIGN.color.apricotDeep, fontSize: DESIGN.type.body, fontWeight: '700' },
  piggyWithdrawalAmount: { color: DESIGN.color.warning },
  piggyEmptyState: { alignItems: 'center', paddingVertical: DESIGN.space.xl },
  piggyEmptyTitle: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body },

  growthPageContent: { paddingBottom: 80 },
  growthCharacter: { alignItems: 'center', paddingTop: DESIGN.space.xs, paddingBottom: DESIGN.space.lg },
  growthMascot: { width: 240, height: 240 },
  growthTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, fontWeight: '700', marginTop: DESIGN.space.sm },
  growthLevelText: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, marginTop: DESIGN.space.xs },
  growthProgressTrack: { alignSelf: 'stretch', height: 3, backgroundColor: DESIGN.color.divider, overflow: 'hidden', marginTop: DESIGN.space.md },
  growthWeekSection: { marginTop: DESIGN.space.lg, paddingBottom: DESIGN.space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  growthSectionTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '700' },
  growthWeekBars: { height: 120, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', paddingHorizontal: DESIGN.space.xs, paddingTop: DESIGN.space.md },
  growthBarColumn: { flex: 1, alignItems: 'center', gap: DESIGN.space.xs },
  growthBar: { width: 22, backgroundColor: DESIGN.color.apricot, opacity: 0.75 },
  growthBarOver: { backgroundColor: DESIGN.color.warning },
  weeklyDayLabel: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  growthStatRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  growthStatName: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body },
  growthStatValue: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '700' },
  growthHistoryLink: { alignItems: 'center', paddingVertical: DESIGN.space.lg },
  growthHistoryLinkText: { color: DESIGN.color.apricotDeep, fontSize: DESIGN.type.body, fontWeight: '600' },

  profilePageContent: { paddingBottom: 80 },
  profileSectionTitle: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, fontWeight: '700', marginTop: DESIGN.space.xl, marginBottom: DESIGN.space.sm },
  profileRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  profileRowTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600' },
  profileRowValue: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body },
  profileRowDetail: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, marginTop: DESIGN.space.xs },
  profileInfoRow: { gap: DESIGN.space.xs, paddingVertical: DESIGN.space.md },

  recordsPage: { flex: 1, width: '100%' },
  recordsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 46, marginTop: DESIGN.space.xs, marginBottom: DESIGN.space.md },
  recordsBack: { width: 36, height: 40, justifyContent: 'center' },
  recordsBackText: { color: DESIGN.color.primary, fontSize: 30, lineHeight: 36 },
  historyPageContent: { paddingBottom: 40 },
  recordDaySection: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  historyDayHeader: { minHeight: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: DESIGN.space.sm },
  historyDayTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.subtitle, fontWeight: '700' },
  historyDayStatus: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, marginTop: DESIGN.space.xs },
  recordsDayTotal: { alignItems: 'flex-end' },
  historyDayMeta: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  historyDayAmount: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '700', marginTop: DESIGN.space.xs },
  historyDayBody: { paddingBottom: DESIGN.space.sm },
  historyExpenseRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: DESIGN.space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  historyExpenseCopy: { flex: 1, gap: DESIGN.space.xs },
  historyExpenseName: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '500' },
  historyExpenseAmount: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600', marginLeft: DESIGN.space.md },
  historyNoExpenses: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, paddingVertical: DESIGN.space.md },
  historyEditButton: { alignSelf: 'flex-end', paddingVertical: DESIGN.space.sm },
  historyEditText: { color: DESIGN.color.apricotDeep, fontSize: DESIGN.type.caption, fontWeight: '600' },

  fullPage: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  pageHeading: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, fontWeight: '700' },
  pageDate: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, fontWeight: '500' },
  settlementPage: { flex: 1, width: '100%', paddingTop: DESIGN.space.md, paddingBottom: DESIGN.space.sm },
  settlementScroll: { flex: 1 },
  settlementContent: { alignItems: 'center', paddingTop: DESIGN.space.xl, paddingBottom: DESIGN.space.md },
  settlementHeadline: { color: DESIGN.color.primary, fontSize: 28, lineHeight: 36, fontWeight: '700', textAlign: 'center', marginBottom: DESIGN.space.md },
  settlementPuppy: { width: 250, height: 250 },
  settlementPrompt: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, fontWeight: '700', marginTop: DESIGN.space.sm, marginBottom: DESIGN.space.lg },
  settlementDetails: { alignSelf: 'stretch', marginTop: DESIGN.space.sm },
  settlementDetailRow: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  settlementLabel: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body },
  settlementDetailValue: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600' },
  settlementExpenseRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: DESIGN.space.md },
  settlementExpenseName: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  settlementExpenseAmount: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  settlementFootnote: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, textAlign: 'center', lineHeight: 18, marginTop: DESIGN.space.sm },
  settlementTextAction: { alignItems: 'center', paddingVertical: DESIGN.space.sm },
  settlementTextActionLabel: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, fontWeight: '600' },
  primaryButton: { alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', minHeight: 54, backgroundColor: DESIGN.color.apricot, borderRadius: DESIGN.radius.control },
  primaryButtonText: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '700' },

  expenseBackdropLayer: { ...StyleSheet.absoluteFill, zIndex: 1, backgroundColor: 'rgba(48, 42, 38, 0.22)' },
  expenseSheetKeyboardAvoider: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: DESIGN.space.lg, zIndex: 2 },
  expenseSheet: { alignSelf: 'stretch', backgroundColor: DESIGN.color.background, borderRadius: DESIGN.radius.sheet, paddingHorizontal: DESIGN.space.lg, paddingTop: DESIGN.space.lg, paddingBottom: DESIGN.space.lg, gap: DESIGN.space.md },
  expenseSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: DESIGN.space.xs },
  expenseSheetTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, fontWeight: '700' },
  editLink: { color: DESIGN.color.apricotDeep, fontSize: DESIGN.type.body, fontWeight: '600', padding: DESIGN.space.xs },
  input: { backgroundColor: 'transparent', borderBottomWidth: 1, borderBottomColor: DESIGN.color.divider, borderRadius: 0, paddingHorizontal: DESIGN.space.xs, paddingVertical: DESIGN.space.md, fontSize: DESIGN.type.subtitle, color: DESIGN.color.primary, fontFamily: 'Cafe24Surround' },
  expenseInput: { minHeight: 56, paddingVertical: DESIGN.space.md },
  expenseSubmitButton: { marginTop: DESIGN.space.xs },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(48, 42, 38, 0.22)' },
  recordsSheet: { flex: 1, backgroundColor: DESIGN.color.background, paddingHorizontal: DESIGN.space.lg, paddingTop: DESIGN.space.md, paddingBottom: Platform.OS === 'ios' ? 32 : DESIGN.space.lg },
  sheetHandle: { alignSelf: 'center', width: 32, height: 2, backgroundColor: DESIGN.color.divider, marginBottom: DESIGN.space.lg },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: DESIGN.space.md },
  sheetTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, fontWeight: '700' },
  sheetSubtitle: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, marginTop: DESIGN.space.xs },
  closeButton: { paddingVertical: DESIGN.space.xs, paddingHorizontal: DESIGN.space.sm },
  closeButtonText: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, fontWeight: '600' },
  sheetSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider, paddingVertical: DESIGN.space.md, marginBottom: DESIGN.space.sm },
  sheetSummaryLabel: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body },
  sheetSummaryAmount: { color: DESIGN.color.primary, fontSize: DESIGN.type.subtitle, fontWeight: '700' },
  expenseList: { flexShrink: 1 },
  expenseListContent: { paddingBottom: DESIGN.space.xs },
  expenseRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, paddingVertical: DESIGN.space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DESIGN.color.divider },
  expenseCopy: { flex: 1, gap: DESIGN.space.xs },
  expensePurpose: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600' },
  expenseTime: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  expenseActions: { flexDirection: 'row', alignItems: 'center', gap: DESIGN.space.sm, marginLeft: DESIGN.space.sm },
  expenseAmount: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600' },
  expenseActionButtons: { flexDirection: 'row', alignItems: 'center', gap: DESIGN.space.xs },
  expenseActionButton: { paddingVertical: DESIGN.space.xs, paddingHorizontal: DESIGN.space.xs },
  editActionIcon: { color: DESIGN.color.secondary, fontSize: 18, lineHeight: 20 },
  expenseDeleteButton: { paddingVertical: DESIGN.space.xs, paddingHorizontal: DESIGN.space.xs },
  trashIcon: { position: 'relative', width: 18, height: 19 },
  trashHandle: { position: 'absolute', top: 0, left: 6, width: 6, height: 2, backgroundColor: DESIGN.color.warning },
  trashLid: { position: 'absolute', top: 3, left: 2, width: 14, height: 2, backgroundColor: DESIGN.color.warning },
  trashBody: { position: 'absolute', top: 6, left: 4, width: 10, height: 12, borderWidth: 1.5, borderColor: DESIGN.color.warning, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center' },
  trashLine: { width: 1, height: 6, backgroundColor: DESIGN.color.warning },
  expenseEditScroll: { flexShrink: 1 },
  expenseEditForm: { gap: DESIGN.space.md, paddingBottom: DESIGN.space.sm },
  expenseEditActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: DESIGN.space.sm, marginTop: DESIGN.space.xs },
  expenseEditCancel: { paddingVertical: DESIGN.space.md, paddingHorizontal: DESIGN.space.md },
  expenseEditCancelText: { color: DESIGN.color.secondary, fontSize: DESIGN.type.body, fontWeight: '600' },
  expenseEditSave: { backgroundColor: DESIGN.color.apricot, borderRadius: DESIGN.radius.control, paddingVertical: DESIGN.space.md, paddingHorizontal: DESIGN.space.lg },
  expenseEditSaveText: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '700' },
  emptyExpenses: { alignItems: 'center', paddingVertical: DESIGN.space.xl },
  emptyExpensesTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '600' },
  emptyExpensesText: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, marginTop: DESIGN.space.xs },

  resultModalRoot: { flex: 1, backgroundColor: DESIGN.color.background, paddingHorizontal: DESIGN.space.lg, paddingTop: Platform.OS === 'ios' ? 34 : DESIGN.space.lg, paddingBottom: DESIGN.space.lg },
  resultCard: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  resultMascot: { width: 260, height: 260, marginBottom: DESIGN.space.md },
  resultEyebrow: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, fontWeight: '600' },
  resultTitle: { color: DESIGN.color.primary, fontSize: DESIGN.type.title, lineHeight: 31, fontWeight: '700', textAlign: 'center', marginTop: DESIGN.space.sm },
  resultDescription: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption, textAlign: 'center', lineHeight: 18, marginTop: DESIGN.space.sm },
  resultGrowth: { width: '100%', marginTop: DESIGN.space.xl },
  resultProgressLabel: { color: DESIGN.color.secondary, fontSize: DESIGN.type.caption },
  resultLevelTrack: { width: '100%', height: 2, backgroundColor: DESIGN.color.divider, overflow: 'hidden', marginTop: DESIGN.space.sm },
  resultConfirmButton: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', minHeight: 54, backgroundColor: DESIGN.color.apricot, borderRadius: DESIGN.radius.control, marginTop: DESIGN.space.xl },
  resultConfirmText: { color: DESIGN.color.primary, fontSize: DESIGN.type.body, fontWeight: '700' },
});
