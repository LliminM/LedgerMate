# LedgerMate

**本地优先的 AI 记账 Agent。** 用自然语言记录收支、导入账单与票据、查询账本，无需手写复式记账分录。

LedgerMate 基于 [accountant24](https://github.com/machulav/accountant24) 开发，保留其纯文本账本和桌面端记账流程，并增加报销制度 RAG、分层记忆、本地运行 Trace 等能力。

## 功能

- **自然语言记账**：描述消费、转账、退款或账户余额，由 Agent 生成结构化分录，并使用 hledger 校验和查询账本。
- **账单与票据导入**：解析 PDF 账单、发票及票据图片，将原始文件保存在工作区，便于回溯。
- **财务查询**：询问支出、交易记录、账户余额与净资产；账本是金额和交易信息的依据。
- **报销制度问答**：检索项目内置的报销制度，结合条款和页码回答政策问题。
- **可扩展 Skills**：使用内置或自定义 Agent Skills，复用周期性财务分析等流程。
- **Git 留痕**：账本以纯文本保存，可使用 Git 查看与追踪变更。

## Agent 设计

### 报销制度 RAG

系统解析内置报销制度 PDF，按条款切分文本并设置重叠区，将 Embedding 写入本地 Chroma 索引。Agent 通过 `search_reimbursement_guideline` 工具检索相关内容，获得条款、PDF 页码和印刷页码；回答政策问题时需引用检索证据，证据不足时明确说明。

当前使用 `text-embedding-v4` 与余弦相似度进行向量检索。制度文件、文档版本、切分版本或 Embedding 配置变化时会重建索引。**目前尚未实现 BM25 与 RRF 混合检索。**

### 分层记忆

| 层级 | 作用 | 实现 |
| --- | --- | --- |
| L0：会话上下文 | 保持当前对话连贯 | pi 会话历史与自动上下文压缩 |
| L1：长期记忆 | 保存用户偏好、长期规则等稳定信息 | `memory.md`，每轮读取并注入上下文 |
| L2：情景记忆 | 跨会话回忆相关事件和经历 | `memories/` 中的 Markdown 文件；回答前通过轻量查询选取最多 3 条相关记忆 |

每轮 Agent 运行结束后，后台任务会抽取或更新情景记忆。记忆写入经过串行调度和原子落盘；**已抽取内容的写盘失败**会进入重试队列。工具调用拦截器阻止 Agent 直接改写情景记忆文件，也限制对已有长期记忆的整体覆写。

### 多会话运行时与异常恢复

Electron `utilityProcess` 为每个聊天维护独立的 pi Runtime。应用按会话路由命令和流式事件，对同一会话的命令串行处理，并回收空闲 Runtime；会话历史由 pi 持久化，回收 Runtime 不会删除聊天记录。

对于上下文溢出后的压缩与重试，UI 会暂存可能恢复的瞬时错误：恢复成功则消除误报，恢复失败则显示错误。同时同步压缩状态，避免切换聊天后状态失真或消息列表跳动。

### 本地 Trace

Agent 运行过程以 JSONL 记录在本地，包含 LLM 调用、工具执行、自动重试和上下文压缩等 Span。Trace 记录耗时、首 Token 延迟、Token 用量、成本和工具错误数，便于定位运行瓶颈。默认不保存 Prompt、思考内容、工具参数和结果原文；Trace 写入失败也不会中断 Agent，`traces/` 默认不纳入工作区 Git 仓库。

## RAG 检索评测

在一份报销制度文档、**44 条带条款和页码证据标注的问题**上，索引包含 **274 个文本块**。一次已有实验的 Top-5 检索结果如下：

| 指标 | 结果 |
| --- | ---: |
| Hit@5 | 100%（44/44） |
| 宏平均 Recall@5 | 96.97% |
| MRR@5 | 0.8485 |

这些是**证据检索指标**，不代表 Agent 最终回答的准确率。仓库包含[评测题集](packages/pi-extension/src/rag/evals/guideline-cases.json)和[指标计算代码](packages/pi-extension/src/rag/evals/metrics.ts)。设置 `DASHSCOPE_API_KEY` 和对应地域的 HTTPS OpenAI 兼容接口地址 `DASHSCOPE_BASE_URL` 后，可重新运行：

```sh
npm run eval:rag
```

脚本会启动临时 Chroma 索引，并将 JSON、Markdown 报告写入 `rag-eval-results/`。该目录是本地生成结果，不提交到仓库。

## 从源码运行

桌面端目前面向 macOS 开发。安装 Node.js 22 或更新版本，以及记账和文档解析所需的本地工具：

```sh
brew install hledger poppler tesseract
npm ci
npm start
```

首次启动后，在应用中连接云端模型，或选择 Ollama 本地模型。普通记账功能不依赖 `DASHSCOPE_*` 配置；使用报销制度检索时，还需在启动应用前配置上述两个环境变量。使用云端模型或 Embedding 服务时，发送给服务的内容会离开本机；账本、记忆、会话和 Trace 保存在本地工作区。

当前源码包名、应用打包名称及默认工作区路径仍沿用原项目的 `Accountant24` 标识，默认工作区为 `~/.accountant24`。LedgerMate 是此分支的项目名称，应用内部标识尚未全部更改。

## 技术栈

TypeScript、Electron、React、pi Agent SDK、TypeBox、hledger、ChromaDB、阿里云 Embedding、Git、Vitest、Playwright。

## 许可证

项目沿用 [Apache 2.0 许可证](LICENSE)。原作者版权声明见 [NOTICE](NOTICE)，打包的第三方工具另附许可证信息。

## 致谢

LedgerMate 基于 [**machulav**](https://github.com/machulav) 开源的 [**accountant24**](https://github.com/machulav/accountant24) 开发。原项目提供了本地优先的桌面应用、记账流程，以及 pi 与 hledger 的基础架构；LedgerMate 在此基础上增加 RAG、分层记忆、可观测性等能力。感谢 machulav 创建并开源 accountant24。
