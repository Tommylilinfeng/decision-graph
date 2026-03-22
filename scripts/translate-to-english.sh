#!/bin/bash
# translate-to-english.sh
#
# Converts all Chinese text in the codebase to English.
# Run from: ~/dev/context-chain

set -e
cd ~/dev/context-chain

echo "=== Translating codebase to English ==="

# ─────────────────────────────────────────────────────────
# 1. connect-decisions.ts
# ─────────────────────────────────────────────────────────
echo "1. connect-decisions.ts"
sed -i '' \
  -e 's/独立积木块：决策关系连接。/Building block: decision relationship connection./' \
  -e 's/核心思路：用 PENDING_COMPARISON 边追踪"哪些决策对还没比较过"。/Core idea: use PENDING_COMPARISON edges to track which decision pairs have not been compared yet./' \
  -e 's/新决策写入后 → createPendingEdges() 建 PENDING 边/After new decisions are written → createPendingEdges() creates PENDING edges/' \
  -e 's/决策内容更新 → invalidateDecisionEdges() 失效旧边 + 重建 PENDING 边/Decision content updated → invalidateDecisionEdges() invalidates old edges + rebuilds PENDING edges/' \
  -e 's/connectDecisions() 消化 PENDING 边 → 有关系的建关系边，没关系的删 PENDING/connectDecisions() processes PENDING edges → creates relationship edges where found, deletes PENDING where not/' \
  -e 's/图谱的终态是干净的：只剩有意义的关系边，没有垃圾。/The graph converges to a clean state: only meaningful relationship edges remain./' \
  -e 's/用法：/Usage:/' \
  -e 's/Pipeline 写完决策后：/After pipeline writes decisions:/' \
  -e 's/一个 batch 最多放多少个 decision summary（默认 50）/Max decision summaries per batch (default 50)/' \
  -e 's/LLM 并发数（默认 2）/LLM concurrency (default 2)/' \
  -e 's/消化了多少条 PENDING_COMPARISON 边/Number of PENDING_COMPARISON edges processed/' \
  -e 's/建了多少条关系边/Number of relationship edges created/' \
  -e 's/跑了多少个 batch/Number of batches run/' \
  -e 's/新决策写入后调用。/Called after new decisions are written./' \
  -e 's/为每个新决策，跟所有已有 active 决策之间建 PENDING_COMPARISON 边/Creates PENDING_COMPARISON edges between each new decision and all existing active decisions/' \
  -e 's/（如果它们之间还没有任何边的话）。/(if no edge exists between them yet)./' \
  -e 's/@returns 建了多少条 PENDING_COMPARISON 边/@returns number of PENDING_COMPARISON edges created/' \
  -e 's/找所有跟 newId 之间没有任何边的 active 决策/Find all active decisions with no edge to newId/' \
  -e "s/createPendingEdges 失败/createPendingEdges failed/" \
  -e 's/条 PENDING_COMPARISON 边已创建/ PENDING_COMPARISON edges created/' \
  -e 's/决策内容被更新后调用。/Called after decision content is updated./' \
  -e 's/删除该决策的所有关系边和 PENDING 边，然后重建 PENDING 边。/Deletes all relationship and PENDING edges, then rebuilds PENDING edges./' \
  -e 's/让它回到"跟所有人都没比较过"的状态。/Resets to "not compared with anyone" state./' \
  -e 's/@returns 删了多少条旧边/@returns number of old edges deleted/' \
  -e 's/删除所有关系边和 PENDING 边/Delete all relationship and PENDING edges/' \
  -e 's/重建 PENDING 边（跟所有 active 决策）/Rebuild PENDING edges (with all active decisions)/' \
  -e 's/条旧边已失效，PENDING 已重建/ old edges invalidated, PENDING rebuilt/' \
  -e 's/消化所有 PENDING_COMPARISON 边。/Process all PENDING_COMPARISON edges./' \
  -e 's/查所有 PENDING_COMPARISON 边涉及的决策/Find all decisions involved in PENDING edges/' \
  -e 's/按 batchCapacity 分 batch/Split into batches by batchCapacity/' \
  -e 's/每个 batch：LLM grouping → 每组 LLM relationship → 写关系边/Each batch: LLM grouping → per-group LLM relationship → write edges/' \
  -e 's/删除 batch 内所有 PENDING_COMPARISON 边（有没有关系都删）/Delete all PENDING edges in batch (regardless of result)/' \
  -e 's/迭代直到没有 PENDING 边或预算耗尽/Iterate until no PENDING edges remain or budget exhausted/' \
  -e 's/决策关系连接\.\.\./Connecting decisions.../' \
  -e 's/迭代消化 PENDING 边/Iterate through PENDING edges/' \
  -e 's/检查预算/Check budget/' \
  -e 's/预算已用完，停止/Budget exhausted, stopping/' \
  -e 's/查涉及 PENDING 边的决策 ID/Find decision IDs with PENDING edges/' \
  -e 's/没有待处理的 PENDING 边/No PENDING edges to process/' \
  -e 's/个决策/ decisions/' \
  -e 's/条 PENDING 边剩余/ PENDING edges remaining/' \
  -e 's/读决策详情/Load decision details/' \
  -e 's/获取 CPG hints/Get CPG hints/' \
  -e 's/条 CPG 调用关系提示/ CPG call hints loaded/' \
  -e 's/组关联决策/ related decision groups/' \
  -e "s/个\] /] /" \
  -e 's/Grouping 失败/Grouping failed/' \
  -e 's/每组 LLM deep analysis/Per-group LLM deep analysis/' \
  -e 's/组装完整内容/Build full content/' \
  -e 's/组分析失败/Group analysis failed/' \
  -e 's/写入关系边/Write relationship edges/' \
  -e 's/不管有没有关系都删——有关系的已经建了关系边，没关系的删了就代表"比较过了"/Delete all — relationships have own edges, deleted PENDING means "already compared"/' \
  -e 's/条关系边, / relationship edges, /' \
  -e 's/条 PENDING 边已消化/ PENDING edges processed/' \
  -e 's/关系连接完成/Connection complete/' \
  -e 's/批次, / batches, /' \
  -e 's/条 PENDING 已消化/ PENDING processed/' \
  -e 's/拿涉及 PENDING 边的决策 ID，数量不超过 limit。/Get decision IDs with PENDING edges, up to limit./' \
  -e 's/优先选 PENDING 边最多的决策（最需要处理的）。/Prioritize decisions with the most PENDING edges./' \
  -e 's/总 PENDING 边数（用于日志）/Total PENDING edge count (for logging)/' \
  -e 's/读决策的完整信息/Load full decision records/' \
  -e 's/查 batch 内决策锚定函数之间的 CALLS 边（CPG 提示）/Query CALLS edges between anchored functions in batch (CPG hints)/' \
  -e 's/删除一组决策之间的所有 PENDING_COMPARISON 边/Delete all PENDING_COMPARISON edges among a set of decisions/' \
  -e 's/查询当前 PENDING 边状态。供 Dashboard 使用。/Query current PENDING edge status. Used by Dashboard./' \
  src/ingestion/connect-decisions.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 2. normalize-keywords.ts
# ─────────────────────────────────────────────────────────
echo "2. normalize-keywords.ts"
sed -i '' \
  -e 's/独立积木块：全局关键词归一化。/Building block: global keyword normalization./' \
  -e 's/从图谱拉所有 active 决策的唯一 keywords，一次 LLM 调用找同义词，/Loads all unique keywords from active decisions, one LLM call to find synonyms,/' \
  -e 's/然后把 alias 都补上 canonical 形式。/then adds canonical forms to decisions containing aliases./' \
  -e 's/应在 connect-decisions 之前调用——归一化后的关键词让分组更精准。/Should be called before connect-decisions — normalized keywords improve grouping accuracy./' \
  -e 's/应用了多少条归一化（每个 alias→canonical 算一条）/Normalizations applied (one per alias→canonical)/' \
  -e 's/canonical 词列表/List of canonical terms/' \
  -e 's/图谱中唯一关键词总数/Total unique keywords in graph/' \
  -e 's/全局关键词归一化。/Global keyword normalization./' \
  -e 's/从图谱拉全量 active 决策的唯一 keywords/Load all unique keywords from active decisions/' \
  -e 's/如果少于 5 个，跳过（不值得跑 LLM）/Skip if fewer than 5 (not worth an LLM call)/' \
  -e 's/一次 LLM 调用/One LLM call/' \
  -e 's/对包含 alias 的决策，补上 canonical/Add canonical form to decisions containing aliases/' \
  -e 's/拉全量唯一关键词/Load all unique keywords/' \
  -e 's/应用归一化/Apply normalizations/' \
  -e 's/关键词归一化\.\.\./Keyword normalization.../' \
  -e 's/关键词太少/Too few keywords/' \
  -e 's/，跳过/, skipping/' \
  -e 's/个唯一关键词/ unique keywords/' \
  -e 's/无需归一化/No normalization needed/' \
  -e 's/条归一化应用/ normalizations applied/' \
  src/ingestion/normalize-keywords.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 3. runners/connect.ts
# ─────────────────────────────────────────────────────────
echo "3. runners/connect.ts"
sed -i '' \
  -e 's/独立运行器：关键词归一化 + 决策关系连接。/Standalone runner: keyword normalization + decision relationship connection./' \
  -e 's/消化图谱中所有 PENDING_COMPARISON 边。/Processes all PENDING_COMPARISON edges in the graph./' \
  -e 's/可独立跑，也可被 cold-start、session ingestion 等 pipeline 在最后一步调用。/Can run standalone or as a final step of any pipeline./' \
  -e 's/归一化 + 连接/normalize + connect/' \
  -e 's/只连接/connect only/' \
  -e 's/带预算限制/with budget limit/' \
  -e 's/当前状态/Current status/' \
  -e 's/条 PENDING 边/ PENDING edges/' \
  -e 's/个决策待连接/ decisions pending connection/' \
  -e 's/没有 PENDING 边。/No PENDING edges found./' \
  -e 's/仍然运行关键词归一化\.\.\./Still running keyword normalization.../' \
  -e 's/关键词归一化（在连接之前）/Keyword normalization (before connecting)/' \
  -e 's/消化 PENDING 边/Process PENDING edges/' \
  -e 's/最终状态/Final status/' \
  -e 's/完成/Done/' \
  -e 's/个批次/ batches/' \
  -e 's/条关系边/ relationship edges/' \
  -e 's/条 PENDING 已消化/ PENDING processed/' \
  -e 's/还剩/Remaining:/' \
  -e 's/条 PENDING 边待处理/ PENDING edges to process/' \
  -e 's/失败/Failed/' \
  src/runners/connect.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 4. cold-start-v2.ts
# ─────────────────────────────────────────────────────────
echo "4. cold-start-v2.ts"
sed -i '' \
  -e 's/用法:/Usage:/' \
  -e 's/关键词归一化（在连接之前，让分组更精准）/Keyword normalization (before connecting, improves grouping)/' \
  -e 's/关键词归一化失败/Keyword normalization failed/' \
  -e 's/建 PENDING 边（新决策 vs 所有已有决策）/Build PENDING edges (new decisions vs all existing)/' \
  -e 's/消化 PENDING 边（分组 + 关系分析）/Process PENDING edges (grouping + relationship analysis)/' \
  -e 's/关系连接失败/Relationship connection failed/' \
  -e 's/预算已用完/Budget exhausted/' \
  -e 's/停止管线/stopping pipeline/' \
  -e 's/初始化可插拔组件/Initialize pluggable components/' \
  src/ingestion/cold-start-v2.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 5. refine.ts
# ─────────────────────────────────────────────────────────
echo "5. refine.ts"
sed -i '' \
  -e 's/后台精炼管线：提升图谱质量。/Background refinement pipeline: improve graph quality./' \
  -e 's/子任务：/Subtasks:/' \
  -e 's/检测代码已变化的决策，标记 stale/Detect decisions where code changed, mark stale/' \
  -e 's/全量关键词归一化/Global keyword normalization/' \
  -e 's/同文件决策对关系边补全/Decision edge completion/' \
  -e 's/空洞检测：有函数无决策的区域/Gap detection: functions without decisions/' \
  -e 's/关键词归一化（委托给独立积木块）/Keyword normalization (delegated to building block)/' \
  -e 's/决策边补全（委托给独立积木块）/Edge completion (delegated to building block)/' \
  -e 's/无法读取 git HEAD，跳过/Cannot read git HEAD, skipping/' \
  -e 's/无变化文件/No changed files/' \
  -e 's/条决策标记为 stale/ decisions marked stale/' \
  -e 's/条孤儿决策（无锚点）标记为 stale/ orphan decisions (no anchor) marked stale/' \
  -e 's/共 /Total: /' \
  -e 's/保守策略：查不到就当变了/Conservative: treat as changed if lookup fails/' \
  -e 's/锚点精度提升/Anchor precision upgrade/' \
  -e 's/条锚点升级/ anchors upgraded/' \
  -e 's/精炼管线启动 — 任务/Refinement started — tasks/' \
  -e 's/预算已用完，跳过边补全/Budget exhausted, skipping edge completion/' \
  -e 's/精炼管线完成/Refinement complete/' \
  -e 's/精炼管线失败/Refinement failed/' \
  -e 's/覆盖率/Coverage/' \
  -e 's/个高调用量函数缺少决策/ high-call functions missing decisions/' \
  -e 's/详见/See/' \
  -e 's/报告写入/Report written to/' \
  -e 's/条关系边补全/ relationship edges completed/' \
  -e 's/connectDecisions 会消化所有 PENDING_COMPARISON 边/connectDecisions processes all PENDING_COMPARISON edges/' \
  -e 's/如果图谱里还没有 PENDING 边（比如老决策从未跑过 createPendingEdges），/If no PENDING edges yet (old decisions never ran createPendingEdges),/' \
  -e 's/先给所有 active 决策之间建 PENDING 边/first create PENDING edges between all active decisions/' \
  -e 's/只给还没有任何边的决策对建 PENDING 边/Only create PENDING edges for uncovered pairs/' \
  src/ingestion/refine.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 6. shared.ts
# ─────────────────────────────────────────────────────────
echo "6. shared.ts"
sed -i '' \
  -e 's/被多条 pipeline 复用的工具函数。/Shared utility functions used by multiple pipelines./' \
  -e 's/从 cold-start-v2.ts 抽出，zero logic change。/Extracted from cold-start-v2.ts, zero logic change./' \
  src/ingestion/shared.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 7. prompts/cold-start.ts
# ─────────────────────────────────────────────────────────
echo "7. prompts/cold-start.ts"
sed -i '' \
  -e 's/可插拔 prompt 模板集合/Pluggable prompt template collection/' \
  -e 's/"退款", "部分退款", "风控规则", "Redis", "缓存穿透", "TTL策略"/"refund", "partial_refund", "risk_control", "Redis", "cache_penetration", "TTL_strategy"/' \
  -e 's/"退款超时"/"refund_timeout"/' \
  -e 's/"退款"/"refund"/' \
  -e 's/"会员等级"/"membership_tier"/' \
  -e 's/"风控"/"risk_control"/' \
  -e 's/"鉴权"/"auth"/' \
  -e 's/"认证"/"authentication"/' \
  -e 's/"验证token"/"verify_token"/' \
  -e 's/"怎么防止重复扣款"/"how to prevent duplicate charges"/' \
  -e 's/"幂等性设计"/"idempotency design"/' \
  -e 's/createOrder 把所有下单逻辑（库存扣减、订单创建、coupon核销）放在 PostgreSQL RPC 而非应用层，用数据库事务保证原子性，代价是业务逻辑分散在前端和数据库两个 repo/createOrder puts all order logic (inventory deduction, order creation, coupon redemption) in a PostgreSQL RPC instead of the application layer, using DB transactions for atomicity, at the cost of splitting business logic across frontend and database repos/' \
  -e 's/createOrder 没有直接操作数据库表，而是调 Supabase RPC（place_order）把所有下单逻辑放在 PostgreSQL 函数里。这个决策让原子性由数据库层保证——库存扣减、订单创建、coupon 核销在同一个事务内完成，不需要应用层实现分布式事务。代价是业务逻辑分散在前端 repo 和数据库 repo 两个地方，调试需要切换上下文。/createOrder does not directly operate on tables but calls Supabase RPC (place_order) to put all order logic in a PostgreSQL function. This lets the database guarantee atomicity — inventory deduction, order creation, and coupon redemption complete in a single transaction without application-layer distributed transactions. The trade-off is business logic split across frontend and database repos, requiring context switching when debugging./' \
  -e 's/"原子性"/"atomicity"/' \
  -e 's/"事务"/"transaction"/' \
  src/prompts/cold-start.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 8. db/schema.ts
# ─────────────────────────────────────────────────────────
echo "8. db/schema.ts"
sed -i '' \
  -e 's/节点约束（保证 id 唯一）/Node constraints (ensure unique id)/' \
  -e 's/属性索引/Property indexes/' \
  -e 's/全文索引/Full-text indexes/' \
  -e 's/查询方式/Query examples/' \
  -e 's/创建节点约束/Creating node constraints/' \
  -e 's/创建索引/Creating indexes/' \
  -e 's/创建全文索引/Creating full-text indexes/' \
  -e 's/Schema 初始化完成/Schema initialization complete/' \
  -e 's/已存在，跳过/Already exists, skipping/' \
  -e 's/当前 Schema 状态/Current schema status/' \
  -e 's/索引数量/Index count/' \
  -e 's/无法读取索引详情，不影响功能/Cannot read index details, does not affect functionality/' \
  -e 's/Schema 初始化脚本/Schema initialization script/' \
  -e 's/对应 PRD/Corresponds to PRD/' \
  -e 's/运行：/Run:/' \
  -e 's/这个脚本是幂等的——重复运行不会出错/This script is idempotent — safe to re-run/' \
  -e 's/执行/Execute/' \
  src/db/schema.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 9. ai/budget.ts + types.ts + index.ts
# ─────────────────────────────────────────────────────────
echo "9. ai/*.ts"
sed -i '' \
  -e 's/Token 预算管理。管线在每次 LLM 调用后检查是否超预算。/Token budget management. Pipeline checks after each LLM call./' \
  -e 's/绝对值：最多用 50 万 token/Absolute: max 500K tokens/' \
  -e 's/百分比：用 API 剩余额度的 50%（需配合 check-quota）/Percentage: 50% of remaining API quota (requires check-quota)/' \
  -e 's/记录一次调用的消耗/Record usage from one call/' \
  -e 's/是否超预算/Whether budget is exceeded/' \
  -e 's/剩余可用 token/Remaining tokens/' \
  -e 's/已用百分比/Percent used/' \
  -e 's/已消耗 token/Tokens consumed/' \
  -e 's/格式化用量摘要/Format usage summary/' \
  -e 's/无效的预算百分比/Invalid budget percentage/' \
  -e 's/，忽略/, ignoring/' \
  -e 's/无法获取剩余额度，百分比预算不可用。请使用绝对值（如 --budget 500000）/Cannot get remaining quota, percentage budget unavailable. Use absolute value (e.g. --budget 500000)/' \
  -e 's/无效的预算值/Invalid budget value/' \
  src/ai/budget.ts

sed -i '' \
  -e 's/AIProvider 接口定义。/AIProvider interface definition./' \
  -e 's/所有 AI 调用方式（claude -p、Anthropic API、OpenAI 等）都实现这个接口。/All AI providers (claude -p, Anthropic API, etc.) implement this interface./' \
  -e 's/标识名，用于日志/Display name for logging/' \
  -e 's/发送 prompt，返回 raw string。/Send prompt, return raw string./' \
  -e 's/调用方负责 JSON 解析——provider 只管传输。/Caller handles JSON parsing — provider handles transport./' \
  -e 's/最近一次调用的 token 用量/Token usage from last call/' \
  -e 's/累计 token 用量/Cumulative token usage/' \
  -e 's/最新 rate limit 信息（仅 Anthropic API 可用）/Latest rate limit info (Anthropic API only)/' \
  src/ai/types.ts

sed -i '' \
  -e 's/工厂函数：根据 config 创建对应的 AIProvider。/Factory: create AIProvider from config./' \
  -e 's/未知的 AI provider/Unknown AI provider/' \
  src/ai/index.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 10. scripts/*.sh
# ─────────────────────────────────────────────────────────
echo "10. Shell scripts"

# overnight.sh
sed -i '' \
  -e 's/夜间自动管线/Nightly pipeline/' \
  -e 's/设计为 crontab 调度或手动启动/Designed for crontab or manual launch/' \
  -e 's/默认 50% 预算/Default budget/' \
  -e 's/指定绝对预算/Absolute budget/' \
  -e 's/指定分析目标/Analysis goals/' \
  -e 's/每天凌晨 1 点跑/Run daily at 1 AM/' \
  -e 's/Context Chain 夜间管线/Context Chain Nightly Pipeline/' \
  -e 's/CKG 夜间管线/Context Chain Nightly Pipeline/' \
  -e 's/预算/Budget/' \
  -e 's/目标/Goals/' \
  -e 's/并发/Concurrency/' \
  -e 's/日志/Log/' \
  -e 's/查询余额/Check quota/' \
  -e 's/核心业务逻辑/core business logic/' \
  -e 's/精炼/Refine/' \
  -e 's/更新 Embedding/Update embeddings/' \
  -e 's/夜间管线完成/Nightly pipeline complete/' \
  scripts/overnight.sh

# full-pipeline.sh
sed -i '' \
  -e 's/全量分析编排脚本 — 一键完成从 CPG 生成到决策提取的完整流水线/Full analysis script — end-to-end from CPG generation to decision extraction/' \
  -e 's/适合晚上跑，支持/Designed to run overnight, supports/' \
  -e 's/分析目标（用 | 分隔多个目标）/Analysis goals (use | to separate multiple goals)/' \
  -e 's/LLM 并发数（默认 2）/LLM concurrency (default 2)/' \
  -e 's/决策归属人（默认 me）/Decision owner (default me)/' \
  -e 's/只分析指定 repo（默认全部）/Only specified repo (default all)/' \
  -e 's/强制重新分析所有文件（忽略变更检测）/Force re-analyze all files (ignore change detection)/' \
  -e 's/依赖变更也触发重新分析/Re-analyze when deps change/' \
  -e 's/试运行，不写入数据库/Dry run, no DB writes/' \
  -e 's/跳过 Joern CPG 生成/Skip Joern CPG generation/' \
  -e 's/跳过 Memgraph 导入/Skip Memgraph import/' \
  -e 's/跳过跨服务连接/Skip cross-service linking/' \
  -e 's/跳过 cold-start 决策提取/Skip cold-start extraction/' \
  -e 's/跳过 session 摄入/Skip session ingestion/' \
  -e 's/只执行指定阶段/Only run specified phase/' \
  -e 's/执行前清空数据库（危险！）/Clear DB before running (dangerous!)/' \
  -e 's/跳过 schema 初始化/Skip schema init/' \
  -e 's/日志目录（默认 data\/logs）/Log directory (default data\/logs)/' \
  -e 's/全量跑（跳过 Joern，用已有 CPG）/Full run (skip Joern, use existing CPG)/' \
  -e 's/高并发 + 只跑决策提取/High concurrency + extraction only/' \
  -e 's/Context Chain 全量分析流水线/Context Chain Full Analysis Pipeline/' \
  -e 's/CKG 全量分析流水线/Context Chain Full Analysis Pipeline/' \
  -e 's/常量/Constants/' \
  -e 's/默认值/Defaults/' \
  -e 's/参数解析/Parse arguments/' \
  -e 's/未知参数/Unknown argument/' \
  -e 's/未知阶段/Unknown phase/' \
  -e 's/可选/options/' \
  -e 's/记录阶段耗时/Track phase timing/' \
  -e 's/预检\.\.\./Preflight checks.../' \
  -e 's/无法连接 Memgraph/Cannot connect to Memgraph/' \
  -e 's/请先运行/Please run first/' \
  -e 's/未安装，将跳过 Joern 阶段/not installed, skipping Joern phase/' \
  -e 's/目录不存在/Directory not found/' \
  -e 's/重置数据库/Reset database/' \
  -e 's/初始化 schema/Initialize schema/' \
  -e 's/生成 Joern CPG/Generate Joern CPG/' \
  -e 's/提取 JSON/Extract JSON/' \
  -e 's/解析 SQL/Parse SQL/' \
  -e 's/导入 Memgraph/Import to Memgraph/' \
  -e 's/不存在，跳过/not found, skipping/' \
  -e 's/建跨服务连接/Build cross-service connections/' \
  -e 's/跨 repo 函数调用/Cross-repo function calls/' \
  -e 's/跨服务 API 依赖/Cross-service API deps/' \
  -e 's/表访问/Table access/' \
  -e 's/Cold-start 决策提取/Cold-start decision extraction/' \
  -e 's/未指定 --goals/No --goals specified/' \
  -e 's/构建 cold-start 额外参数/Build cold-start extra args/' \
  -e 's/按 | 分隔多个 goal，依次执行/Split goals by |, execute sequentially/' \
  -e 's/Session 决策摄入/Session decision ingestion/' \
  -e 's/全量分析完成/Full analysis complete/' \
  -e 's/总耗时/Total time/' \
  -e 's/日志文件/Log file/' \
  -e 's/查看结果/View results/' \
  -e 's/完成/Done/' \
  -e 's/时间/Time/' \
  -e 's/开始/Start/' \
  scripts/full-pipeline.sh

# refresh-all.sh
sed -i '' \
  -e 's/一键刷新所有 repo 的代码结构数据：/Refresh all repo code structure data:/' \
  -e 's/跨服务连接/Cross-service connections/' \
  -e 's/前提: Joern 已安装，Memgraph 已启动/Prerequisites: Joern installed, Memgraph running/' \
  -e 's/参数解析/Parse arguments/' \
  -e 's/全部完成/All complete/' \
  scripts/refresh-all.sh

# setup.sh
sed -i '' \
  -e 's/Context Knowledge Graph — Setup/Context Chain — Setup/' \
  -e 's/Context Chain Setup/Context Chain — Setup/' \
  -e 's/CKG Setup/Context Chain — Setup/' \
  scripts/setup.sh
echo "  Done"

# ─────────────────────────────────────────────────────────
# 11. prompts/prompt-config.ts
# ─────────────────────────────────────────────────────────
echo "11. prompts/prompt-config.ts"
sed -i '' \
  -e 's/多 pipeline 可定制化 prompt 模板系统。/Multi-pipeline customizable prompt template system./' \
  -e 's/创建使用模板系统的 PromptBuilders。/Create PromptBuilders using the template system./' \
  src/prompts/prompt-config.ts
echo "  Done"

# ─────────────────────────────────────────────────────────
# 12. Final scan
# ─────────────────────────────────────────────────────────
echo ""
echo "=== Scanning for remaining Chinese in src/ and scripts/ ==="
echo ""
# Use perl for proper unicode matching
perl -nle 'print "$ARGV:$.: $_" if /[\x{4e00}-\x{9fff}]/' \
  src/ingestion/connect-decisions.ts \
  src/ingestion/normalize-keywords.ts \
  src/ingestion/refine.ts \
  src/ingestion/shared.ts \
  src/ingestion/cold-start-v2.ts \
  src/runners/connect.ts \
  src/prompts/cold-start.ts \
  src/prompts/prompt-config.ts \
  src/db/schema.ts \
  src/ai/budget.ts \
  src/ai/types.ts \
  src/ai/index.ts \
  scripts/overnight.sh \
  scripts/full-pipeline.sh \
  scripts/refresh-all.sh \
  scripts/setup.sh \
  2>/dev/null | head -30

echo ""
echo "=== Done! ==="
echo "Review with: git diff --stat"
echo "Commit: git add -A && git commit -m 'Convert codebase to English'"
