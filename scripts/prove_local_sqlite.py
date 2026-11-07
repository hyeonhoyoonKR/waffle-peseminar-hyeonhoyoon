#!/usr/bin/env python3
"""Run a real local SQLite write/read for the MVP's primary data path."""

import json
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "samples" / "local-sqlite-response.json"

with tempfile.NamedTemporaryFile(suffix=".db") as temp:
    connection = sqlite3.connect(temp.name)
    connection.executescript("""
        CREATE TABLE settings (id INTEGER PRIMARY KEY, daily_budget INTEGER NOT NULL);
        CREATE TABLE budget_days (day TEXT PRIMARY KEY, carry_in INTEGER NOT NULL,
                                 allowance INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE expenses (id TEXT PRIMARY KEY, day TEXT NOT NULL REFERENCES budget_days(day),
                               amount INTEGER NOT NULL, purpose TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO settings VALUES (1, 30000);
        INSERT INTO budget_days VALUES ('2026-10-29', 0, 30000, 1793271600000);
        INSERT INTO expenses VALUES ('demo-1', '2026-10-29', 12000, '저녁 식사', 1793275200000);
    """)
    carry_in = connection.execute(
        "SELECT allowance - COALESCE((SELECT SUM(amount) FROM expenses WHERE day = budget_days.day), 0) "
        "FROM budget_days WHERE day = '2026-10-29'"
    ).fetchone()[0]
    connection.execute("INSERT INTO budget_days VALUES (?, ?, ?, ?)",
                       ('2026-10-30', carry_in, 30000, 1793358000000))
    connection.execute("INSERT INTO expenses VALUES (?, ?, ?, ?, ?)",
                        ('demo-2', '2026-10-30', 4500, '커피', 1793361600000))
    connection.execute("INSERT INTO expenses VALUES (?, ?, ?, ?, ?)",
                        ('demo-3', '2026-10-30', 11000, '점심 식사', 1793365200000))
    rows = connection.execute(
        "SELECT id, amount, purpose, created_at FROM expenses WHERE day = ? ORDER BY created_at DESC",
        ('2026-10-30',),
    ).fetchall()
    day = connection.execute(
        "SELECT carry_in, allowance FROM budget_days WHERE day = ?", ('2026-10-30',)
    ).fetchone()
    spent = connection.execute("SELECT SUM(amount) FROM expenses WHERE day = ?", ('2026-10-30',)).fetchone()[0]
    response = {
        "source": "SQLite local write/read proof; example values, not personal spending data",
        "day": "2026-10-30",
        "carryInWon": day[0],
        "allowanceWon": day[1],
        "spentWon": spent,
        "remainingWon": day[0] + day[1] - spent,
        "expenses": [
            {"id": row[0], "amountWon": row[1], "purpose": row[2], "createdAtEpochMs": row[3]}
            for row in rows
        ],
    }
    connection.close()

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(response, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(response, ensure_ascii=False, indent=2))
