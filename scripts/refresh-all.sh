#!/bin/bash
# refresh-all.sh
#
# EXAMPLE SCRIPT for multi-repo setups.
# This script is specific to the "bite" project and serves as a reference
# for how to refresh multiple repos. Adapt it to your own project structure.
#
# Refresh all repo code structure data:
#   - Joern CPG → JSON → Memgraph for each repo
#   - Cross-service connections: link:repos + link:services + link:tables
#
# Usage: bash scripts/refresh-all.sh [--skip-joern] [--skip-ingest] [--skip-link]
#
# Prerequisites: Joern installed, Memgraph running
# Set BITE_DIR to override the default sibling directory lookup.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BITE_DIR="${BITE_DIR:-$(cd "$CKG_DIR/.." && pwd)/bite}"

# ── Parse arguments ──────────────────────────────────────────
SKIP_JOERN=false
SKIP_INGEST=false
SKIP_LINK=false

for arg in "$@"; do
  case $arg in
    --skip-joern)  SKIP_JOERN=true ;;
    --skip-ingest) SKIP_INGEST=true ;;
    --skip-link)   SKIP_LINK=true ;;
  esac
done

cd "$CKG_DIR"

# ── Step 1: Joern CPG 生成 ───────────────────────────
if [ "$SKIP_JOERN" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 1: 生成 Joern CPG"
  echo "═══════════════════════════════════════════════════"

  echo ""
  echo "📦 bite-me-website..."
  joern-parse "$BITE_DIR/bite-me-website/src" \
    --output "$BITE_DIR/bite-me-website.cpg.bin" \
    --language javascript
  echo "  ✅ CPG 生成完成"

  echo ""
  echo "📦 biteme-shared..."
  joern-parse "$BITE_DIR/biteme-shared/src" \
    --output "$BITE_DIR/biteme-shared/biteme-shared.cpg.bin" \
    --language javascript
  echo "  ✅ CPG 生成完成"

  # 从 CPG 提取 JSON
  echo ""
  echo "📤 提取 bite-me-website JSON..."
  joern --script "$CKG_DIR/joern/extract-code-entities.sc" \
    --param "cpgFile=$BITE_DIR/bite-me-website.cpg.bin" \
    --param "outFile=$CKG_DIR/data/bite-me-website.json" \
    --param "repoName=bite-me-website"

  echo ""
  echo "📤 提取 biteme-shared JSON..."
  joern --script "$CKG_DIR/joern/extract-code-entities.sc" \
    --param "cpgFile=$BITE_DIR/biteme-shared/biteme-shared.cpg.bin" \
    --param "outFile=$CKG_DIR/data/biteme-shared.json" \
    --param "repoName=biteme-shared"

else
  echo ""
  echo "⏭️  跳过 Joern CPG 生成 (--skip-joern)"
fi

# ── Step 2: parse-sql (biteme-infra) ─────────────────
if [ "$SKIP_JOERN" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 2: 解析 SQL migrations"
  echo "═══════════════════════════════════════════════════"
  echo ""
  npm run parse:sql -- \
    --repo biteme-infra \
    --sql-dir "$BITE_DIR/biteme-infra/supabase/migrations" \
    --out data/biteme-infra-sql.json
fi

# ── Step 3: 导入 Memgraph ────────────────────────────
if [ "$SKIP_INGEST" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 3: 导入 Memgraph"
  echo "═══════════════════════════════════════════════════"

  echo ""
  echo "📥 bite-me-website..."
  npm run ingest:cpg -- --file data/bite-me-website.json

  echo ""
  echo "📥 biteme-shared..."
  npm run ingest:cpg -- --file data/biteme-shared.json

  echo ""
  echo "📥 biteme-infra (SQL)..."
  npm run ingest:cpg -- --file data/biteme-infra-sql.json

else
  echo ""
  echo "⏭️  跳过 Memgraph 导入 (--skip-ingest)"
fi

# ── Step 4: 建Cross-service connections ─────────────────────────────
if [ "$SKIP_LINK" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Step 4: 建Cross-service connections"
  echo "═══════════════════════════════════════════════════"

  echo ""
  echo "🔗 link:repos (跨 repo 函数调用)..."
  npm run link:repos

  echo ""
  echo "🌐 link:services (跨服务 API 依赖)..."
  npm run link:services

  echo ""
  echo "🗂️  link:tables (supabase.from 表访问)..."
  npm run link:tables

else
  echo ""
  echo "⏭️  跳过Cross-service connections (--skip-link)"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ All complete"
echo "═══════════════════════════════════════════════════"
echo ""
