---
name: visiki-daw
description: "通过 Visiki DAW MCP 编辑音频工程、处理和试听混音、分析音频及导出 WAV。用户指定 Visiki 音频工作区或 .visiki-daw.json 工程时使用。"
---

# Visiki DAW

使用当前打开的 Visiki 音频工作区完成用户要求，以实际工具 schema 和 `visiki_daw_catalog` 为准。用户的描述可以是“人声清楚一点”之类的听感目标，先转化为适度可试听的调整，保留素材、对齐关系和原有创作意图。只修改与任务相关的内容。

1. 发现当前已连接的 Visiki stdio MCP 工具，名称可能带客户端前缀。先调用 `visiki_daw_status`，需要时调用 `visiki_daw_activate` 激活并等待恢复。用 `visiki_daw_get_session` 读取工程、`revision`、`missingAssetIds` 和历史状态。MCP 需要 Visiki 正在运行。
2. 调用 `visiki_daw_catalog` 查操作字段、限制和内置效果类型。指定 `effectType` 再查该效果的参数与预设 ID。效果、音轨和片段使用实际返回的 ID。使用第三方插件时，按 [VST3 参数编辑](references/editing.md#vst3-参数编辑) 查找和写入公开参数。
3. 导入和编辑前核对时间与素材，按 [editing.md](references/editing.md) 操作。使用最新 revision 提交原子编辑，尊重共享撤销历史和现有工程。
4. 混音和自动分析按 [mixing.md](references/mixing.md) 选择方案并试听。保留用户指定的处理、风格、响度和动态。根据任务要求保存工程或导出成果。
5. 后台任务、试听、导出和恢复参见 [jobs.md](references/jobs.md)。完成后说明实际工程或 WAV 路径、关键处理、测量结果及未完成事项，不能把任务启动或预览当作成品。

缺少连接时复用 Visiki 的 stdio 配置。便携版可运行「生成MCP配置.cmd」，将生成的 Visiki 项加入客户端并保留 `ELECTRON_RUN_AS_NODE=1`。开发版可用 Node.js 22 或更新版本运行实际安装目录的 `mcp/server.cjs`，以 `--endpoint-file` 指向当前数据目录里的 `agent-endpoint.json`。连接后刷新工具列表。

