
## CKG 上下文图谱

本项目接入了 Context Knowledge Graph（CKG），提供设计决策上下文。

### 自动查询
修改代码前，用 `get_context_for_code` 查询相关设计决策：
- 输入文件名或函数名
- 默认返回摘要列表，传 `detail=true` 获取完整内容
- 传 `decision_id` 展开单条决策的关系链

`get_context_for_code` 内部融合了锚点、关键词、关系链、向量四通道检索，是唯一需要的工具。
