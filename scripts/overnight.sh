#!/bin/bash
# overnight.sh
#
# Nightly pipeline — 用 50% 剩余额度跑完整分析 + Refine
# Designed for crontab or manual launch
#
# 用法:
#   bash scripts/overnight.sh                          # Default budget
#   bash scripts/overnight.sh --budget 500000          # Absolute budget
#
# crontab 示例（Run daily at 1 AM）:
#   0 1 * * * cd /path/to/context-chain && bash scripts/overnight.sh >> data/logs/overnight.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$CKG_DIR"

# ── 参数 ──────────────────────────────────────────────
BUDGET="${1:-500000}"            # 默认 50 万 token
CONCURRENCY="${CONCURRENCY:-2}"
LOG_DIR="data/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/overnight-$TIMESTAMP.log"

echo "============================================" | tee "$LOG_FILE"
echo "🌙 Context Chain Nightly Pipeline — $(date)" | tee -a "$LOG_FILE"
echo "  Budget: $BUDGET tokens" | tee -a "$LOG_FILE"
echo "  Concurrency: $CONCURRENCY" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "============================================" | tee -a "$LOG_FILE"

# ── Phase 1: 查余额 ──────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "📊 Phase 1: Check quota" | tee -a "$LOG_FILE"
npx ts-node --transpile-only scripts/check-quota.ts 2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 2: Full-scan 分析 ──────────────────────────
ANALYZE_BUDGET=$((BUDGET * 60 / 100))  # 60% 给 full-scan

echo "" | tee -a "$LOG_FILE"
echo "🔬 Phase 2: Full-scan analyze (budget: $ANALYZE_BUDGET tokens)" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/runners/analyze.ts \
  --continue \
  --concurrency "$CONCURRENCY" \
  --budget "$ANALYZE_BUDGET" \
  2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 3: Refine管线 ────────────────────────────────
REFINE_BUDGET=$((BUDGET * 20 / 100))  # 20% 给Refine

echo "" | tee -a "$LOG_FILE"
echo "🔧 Phase 3: Refine (budget: $REFINE_BUDGET tokens)" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/ingestion/refine.ts \
  --budget "$REFINE_BUDGET" \
  2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 4: Embedding 更新 ──────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "🧠 Phase 4: Update embeddings" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/ingestion/embed-decisions.ts \
  2>&1 | tee -a "$LOG_FILE" || true

# ── Phase 5: Session 摄入 ────────────────────────────
SESSIONS_BUDGET=$((BUDGET * 20 / 100))  # 20% 给 session

echo "" | tee -a "$LOG_FILE"
echo "💬 Phase 5: Session 摄入" | tee -a "$LOG_FILE"
npx ts-node --transpile-only src/ingestion/ingest-sessions-v2.ts \
  --concurrency "$CONCURRENCY" \
  2>&1 | tee -a "$LOG_FILE" || true

# ── 完成 ─────────────────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "============================================" | tee -a "$LOG_FILE"
echo "✅ Nightly pipeline complete — $(date)" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "============================================" | tee -a "$LOG_FILE"
