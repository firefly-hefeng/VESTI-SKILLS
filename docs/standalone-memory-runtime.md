# VESTI 无 App 记忆运行时

> 本文记录 `main` 当前代码已经实现的独立运行行为。它是部署与维护说明，不把规划中的能力描述为现有能力。

## 1. 结论与适用范围

VESTI 现在可以在不安装、不开启桌面 App 的情况下完成以下闭环：

1. 后台守护进程读取本机已有的编程会话记录；
2. 首次启动时扫描历史记录，之后持续监听或轮询变化；
3. 将标准化后的会话、消息、轮次、工具调用和项目关系写入本地 SQLite；
4. MCP 以只读方式查询同一数据库，并把检索结果提供给已配置的宿主；
5. Skill 告诉宿主在什么场景、按什么顺序调用 MCP 工具。

桌面 App 在这套架构中是可选的展示和管理界面，不再是采集与查询链路的必要进程。

当前实现不等同于系统服务：安装命令不会创建 Windows 计划任务、LaunchAgent 或 systemd user service。安装时会为当前登录会话启动一次守护进程；以后宿主启动 MCP 时，MCP 也会按需检查并重新启动守护进程。

## 2. 组件职责

| 组件 | 当前职责 | 不负责的内容 |
| --- | --- | --- |
| `@vesti/capture-runtime` | 发现并解析本地会话源；初始化数据库；增量同步；文件监听；WSL 轮询；周期校准；单实例守护；本地 IPC | 不替宿主选择何时召回；默认守护进程不启动 HTTP/TCP 服务 |
| `@vesti/mcp` | 通过 stdio 暴露检索、时间线、项目上下文、交接上下文、文件定位和记忆空间查询工具 | 不采集源文件，不修改 SQLite，不启动网络服务 |
| `vesti-memory` Skill | 向宿主提供渐进式检索和披露规则 | 不运行进程，不读取源文件，不直接写数据库 |
| `@vesti/memory` | 安装 Skill、合并宿主 MCP 配置、启动和诊断运行时 | 不安装操作系统级开机自启任务 |
| VESTI App | 可选的桌面展示和管理界面 | 无 App 模式下不参与必需的数据链路 |

`Skill + MCP` 是使用层，`capture-runtime` 是采集与持久化层。只安装 Skill 而没有 MCP，宿主没有可调用的 VESTI 工具；只运行 MCP 而没有 Skill，工具仍可用，但宿主不会自动获得 VESTI 约定的调用时机与分层检索流程。

## 3. 进程与数据流

```text
Codex / Cursor / Kimi Code / Claude Code / Trae / Qoder / WorkBuddy
                              │
                              │ 本地会话文件或本地状态数据库
                              ▼
                  vesti-captured（每个规范化数据库路径一个）
                  ├─ AdapterManager：发现、解析、规范化
                  ├─ CaptureRuntime：初始同步、watch、轮询、校准
                  └─ 单写队列：串行执行数据库变更
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
     ~/.vesti/db/vesti.db  ~/.vesti/vault  ~/.vesti/logs
             │
             │ SQLite query_only
             ▼
     一个或多个 vesti-mcp stdio 进程
             │
             │ MCP 工具结果
             ▼
       Codex / Claude Code / Kimi Code / Cursor 等已配置宿主
             ▲
             └─ vesti-memory Skill 提供调用与披露规则
```

关键边界如下：

- 守护进程是 SQLite 的写入方；所有捕获写入通过同一条进程内串行队列执行。
- MCP 进程可以有多个，但每个 MCP 数据库连接在打开后立即执行 SQLite `query_only = ON`。
- MCP 与守护进程之间只传递 `ping`、状态、同步和关闭控制消息；检索查询由 MCP 直接读取 SQLite，不经过守护进程转发。
- Skill 是文本指令，不在后台采集，也不保存数据。

## 4. 启动与就绪顺序

通常由 MCP 或 `@vesti/memory` 调用轻量客户端 `ensureCaptureDaemon()`。完整顺序是：

1. 分别解析数据根目录和数据库文件，并根据规范化数据库路径的哈希确定唯一的锁与 IPC 地址；
2. 通过本地 IPC 探测是否已有协议兼容的守护进程；
3. 若没有，则以 detached 子进程启动 `vesti-captured`；首次安装时会先创建数据根目录；
4. 守护进程原子获取单实例锁并建立本地 IPC；
5. 创建数据目录，打开 SQLite，执行数据库初始化与迁移，并初始化 Vault；
6. 检测可用的 WSL 分发版和会话根目录；
7. 先为已启用的原生平台建立文件监听，再执行初始全量发现与增量导入，避免“扫描结束、监听尚未开始”之间遗漏写入；
8. 解析子任务关系、刷新分支关系，等待该轮同步结束；
9. 标记 `initialSyncComplete=true` 和 `state=running`，随后启动 WSL 轮询与周期校准定时器；
10. `ensureCaptureDaemon()` 只有在协议版本匹配、运行状态为 `running` 且初始同步结束后才返回。

因此，MCP 第一次启动可能需要等待历史记录导入。默认等待上限为 120 秒；它不是“子进程创建成功即就绪”。某个平台解析失败会记录在同步结果中，不会自动阻断其他平台完成同步；数据库初始化等基础步骤失败则会导致守护进程启动失败。

## 5. 实时采集与一致性

### 5.1 原生文件监听

- 默认使用 `chokidar` 监听已启用且已检测到的平台。
- 未启用的平台不会建立 watcher；默认列表之外的 Aider 适配器虽然仍存在于源码中，但当前 standalone CLI 不把它列为可启用平台。
- 写入稳定窗口为 500 ms，检查间隔为 100 ms。这里的作用是减少写文件过程中读取半成品的概率，不构成固定延迟承诺。
- 文件变化进入同一个串行写队列，避免 watcher、手动同步、WSL 轮询和周期校准并发修改 SQLite。
- watcher 自身报错不会造成未处理异常；各平台的探测和 watcher 相互隔离，后续周期校准会重试补建 watcher 并重新扫描源文件。

Trae 使用 SQLite WAL 时，新提交的数据可能只位于 `state.vscdb-wal`。当前监听同时覆盖：

- `state.vscdb`
- `state.vscdb-wal`
- `state.vscdb-shm`

收到 `-wal` 或 `-shm` 事件时，运行时会把路径规范化为主 `state.vscdb` 并强制重新读取主数据库，不会把 WAL/SHM 文件当作会话文件解析。完整校准和 WSL 轮询也会强制重新检查 Trae 主数据库。

### 5.2 WSL 轮询

Node 文件监听不可靠地覆盖 WSL UNC 路径，因此 UNC 路径不会交给 `chokidar`。Windows 环境会检测 WSL 分发版和用户目录，并默认每 60 秒扫描一次检测到的 WSL 会话源。

当前 WSL 探测规则包含 Codex、Kimi Code、Claude Code、Trae、Qoder（内部标识 `coder`）和 WorkBuddy。Cursor 适配器目前只解析本机路径，没有接入 WSL home roots，因此不能把“默认支持 Cursor”理解为“已经支持 WSL 内的 Cursor 记录”。

WSL 来源身份同时包含发行版和 Linux 用户：`wsl:<规范化发行版>:<逐字节用户标识>`。发行版按 Windows UNC 语义统一大小写，用户部分保留大小写、Unicode 与边界字符差异；会话 ID 使用不可与编码内容混淆的分隔符，因此同一发行版不同用户、或名称中含连字符时不会互相覆盖。

### 5.3 周期校准与手动同步

- 默认每 5 分钟刷新一次 WSL 检测并对所有已启用平台执行完整增量校准。
- 校准会弥补守护进程停止期间或 watcher 异常期间漏掉的文件事件。
- IPC 的 `sync` 命令以及 `vesti sync` 会立即触发一次完整增量同步。
- 同步使用文件检查点和数据库 upsert；“完整扫描”不表示每次无条件重建整库。

典型新鲜度是：原生会话在文件稳定并解析完成后可查询，WSL 会话通常在下一次默认 60 秒轮询中被发现，漏失的原生事件通常由下一次默认 5 分钟校准补齐。实际时间仍受源文件落盘方式、文件锁、历史数据规模和解析错误影响，不应作为严格 SLA。

### 5.4 当前不会自动生成的层

当前无 App 守护进程负责会话、消息、轮次、工具执行、项目注册、子任务关系、分支关系和全文检索所需的基础数据。数据库迁移会创建 `session_digests`、`project_state`、`project_briefs`、`memory_entries` 等表，但 `CaptureRuntime.start()` 与其定时器目前没有运行单独的摘要、向量嵌入、项目 brief 或“梦境”生成服务。

因此：

- 会话全文检索、时间线、指定轮次读取和基于已捕获工具记录的文件定位可由新捕获数据直接支持；
- 依赖摘要、项目状态卡、项目 brief、向量或长期记忆条目的字段，只有在数据库中已经存在相应记录时才会返回；
- MCP 对旧 schema 或缺少这些层的数据库采用空值、降级通道或明确错误，不会由只读查询进程补写数据。

## 6. 支持平台

### 6.1 默认采集源

| 产品 | 运行时标识 | 默认启用 | 原生监听 | WSL 检测/轮询 |
| --- | --- | --- | --- | --- |
| Codex | `codex` | 是 | 是 | 是 |
| Cursor | `cursor` | 是 | 是 | 当前没有 |
| Kimi Code | `kimi-code` | 是 | 是 | 是 |
| Claude Code | `claude-code` | 是 | 是 | 是 |
| Trae / Trae CN / TRAE SOLO CN（仅旧版可读 `state.vscdb`） | `trae` | 是 | 是，含 SQLite WAL/SHM | 是 |
| Qoder | `coder` | 是 | 是 | 是 |
| WorkBuddy | `workbuddy` | 是 | 是 | 是 |

“支持”指适配器能够在已知本地存储格式和默认路径下发现、解析记录，不代表厂商未来版本改变存储格式后仍无需更新。各源文件由对应产品写入；VESTI 不拦截键盘输入，也不注入这些产品的进程。

可通过守护进程参数 `--platforms` 传入上述标识的逗号分隔列表。运行时只为该集合扫描并建立监听。

### 6.2 一键配置宿主

`@vesti/memory setup` 当前能自动安装 Skill 并合并 MCP 配置的宿主是：

- Codex
- Claude Code
- Kimi Code
- Cursor
- Qoder 桌面版与 Qoder CLI
- WorkBuddy
- Trae、Trae CN 与 TRAE SOLO CN

七类工具统一使用 `setup`：发现现有用户配置、安装 Skill、合并 MCP 配置，并为目标数据库启动一个共享采集进程。`--host` 只控制写入哪个客户端的配置，不限制采集源。桌面版与 CLI 的路径差异由安装器处理，具体路径见 [安装器说明](../packages/vesti-memory/README.md#what-setup-changes)。

自动发现依赖已存在的用户配置目录；首次使用前可显式指定 `--host`。Qoder CLI 当前使用默认 `~/.qoder` 布局。采集支持依然受源格式约束，自动配置 Trae 不代表能够读取新版加密会话。

### 6.3 与 App 捕获实现的对齐范围

本次核对以 App `origin/main` 的 `7be11a9` 为基线。Qoder、WorkBuddy 的 adapter/parser 与独立运行时内容一致（忽略换行符）；Trae parser 一致，独立版额外处理 WAL/SHM 变化。两边默认启用的七类会话来源一致，Trae 新版加密存储也都不在当前解析范围内。

此次补齐的是客户端自动配置入口，不是重新实现一遍已有采集器。独立运行时与 App 仍有不同的进程生命周期和写入协调方式，不能据此认定两套进程可以同时写同一个数据库。新增客户端配置经过隔离测试；每款客户端实际加载 MCP/Skill 的端内验收需要在对应软件中完成。

## 7. 单实例守护与本地 IPC

### 7.1 单写者锁

每个规范化 SQLite 数据库路径对应一个协调身份。运行时对该路径计算哈希，并把 lock、runtime 目录和 IPC 地址绑定到这个身份；因此即使两个进程传入不同的 `VESTI_HOME`，只要目标 `dbPath` 相同，也只能有一个 standalone 写入者。锁文件使用独占创建，记录随机 token、PID、启动时间、IPC 地址和协议版本；默认每 10 秒通过文件 mtime 更新心跳，不会通过截断重写 JSON 来更新心跳。

锁恢复遵循以下规则：

- PID 仍存活时，即使机器休眠导致心跳时间较旧，也不会抢占该锁；
- PID 已死亡或锁内容持续无效时，可以进入恢复流程；
- 无效内容先短暂重读，避免把刚写到一半的锁误认为陈旧锁；
- 恢复者之间还有独占仲裁文件；删除前会再次比较此前看到的内容或 token，防止竞争者删除刚由另一进程建立的新锁；
- 释放锁时同样校验 token，只清理自己仍持有的锁。
- 心跳发现 token 或所有权已经变化时，当前 daemon 会立即进入安全关闭，不再继续写数据库，也不会删除新 owner 的 Unix socket。

这个锁只协调 `vesti-captured` 实例。旧版桌面 App 的捕获进程若没有遵守同一锁协议，不受该锁保护；在 App 尚未改成该守护进程的客户端之前，不应让旧 App 捕获器和 standalone 守护进程同时写同一个数据库。

### 7.2 IPC 协议

- Windows：按规范化数据库路径哈希生成本机 named pipe，例如 `\\.\pipe\vesti-capture-<db-hash>`。
- Unix：默认使用 `<数据库推导根>/runtime/capture-<db-hash>/capture-daemon.sock`；路径过长时回退到系统临时目录下的哈希 socket。Unix socket 创建后设置为 `0600`。
- 编码：每行一个 JSON 对象的 NDJSON，请求与响应用 `id` 关联。
- 当前协议版本：`1`。
- 当前命令：`ping`、`status`、`sync`、`shutdown`。

这是同机进程控制接口，不是跨机器同步协议。standalone 包不包含桌面端的 HTTP/WebSocket API server，默认守护启动路径不会监听 HTTP/TCP 端口。

### 7.3 轻量客户端 API

`@vesti/capture-runtime/client` 不加载 SQLite、适配器或 watcher，供 MCP 和安装 CLI 在启动阶段使用。当前导出包括：

```ts
resolveRuntimePaths(options?)
requestCaptureDaemon(request, options?)
getCaptureDaemonStatus(options?)
startCaptureDaemonDetached(options?)
ensureCaptureDaemon(options?)
```

`ensureCaptureDaemon()` 会处理多个 MCP 同时争抢启动的情况，并等待初始同步完成。检测到不同协议版本时会报 `PROTOCOL_MISMATCH`；若已连接进程报告的数据库与请求目标不同，则报 `RUNTIME_PATH_MISMATCH`。兼容性比较以规范化数据库路径为准。

## 8. MCP 的只读边界

`vesti-mcp` 是 stdio MCP server。启动时默认执行：

1. 解析目标数据库路径；
2. 调用 `ensureCaptureDaemon({ dbPath, env })`；
3. 等待守护进程完成 schema 初始化和初始同步；
4. 打开同一个 SQLite 文件并立即启用 `PRAGMA query_only = ON`；
5. 在 stdout 上运行 MCP stdio 协议，运行状态和错误仅写 stderr。

MCP 暴露的当前工具覆盖：

- 会话关键词召回：`vesti_search`
- 会话轮次概览与按轮次读取：`vesti_timeline`、`vesti_get_turns`
- 项目概览、项目上下文和交接上下文：`vesti_project_brief`、`vesti_get_project_context`、`vesti_get_handoff_context`
- 历史文件定位：`vesti_search_files`
- 已存在长期记忆条目的搜索与读取：`vesti_memory_search`、`vesti_memory_get`

`query_only` 是数据库层的写保护，不只是代码约定。MCP 工具只执行读取和 PRAGMA 查询，不会更新召回次数、生成摘要或补齐项目状态；这些写操作必须由兼容的写入管线承担。

多个宿主可分别启动自己的 MCP stdio 子进程并同时读取同一个数据库。它们共享捕获结果，但 MCP 返回给某一宿主的内容不会通过 VESTI 自动转发给其他宿主；跨宿主复用发生在“共同查询同一份本地记忆”这一层。

## 9. 数据目录与环境变量

默认布局：

```text
~/.vesti/
├─ config/                         # vesti.json 仅在配置组件写入后出现
├─ db/vesti.db
├─ vault/
├─ logs/
│  ├─ capture-daemon.log
│  └─ capture-daemon.log.1        # 日志达到上限后可能存在
├─ runtime/
│  └─ capture-<db-hash>/
│     ├─ capture-daemon.lock
│     └─ capture-daemon.sock      # Unix；Windows 使用 named pipe
└─ exports/
```

守护日志为 NDJSON，默认单文件达到 5 MiB 时轮换到 `.1`。`--foreground` 会额外把结构化日志镜像到 stderr。Unix 上日志目录和日志文件分别收紧为 `0700` 与 `0600`。

| 变量 | 当前含义与优先级 |
| --- | --- |
| `VESTI_DB_PATH` | 显式指定 SQLite 文件，始终覆盖由 `VESTI_HOME` 或 `VESTI_DATA_DIR` 推导的默认数据库。MCP 会把解析后的路径传给运行时。 |
| `VESTI_HOME` | 控制 Vault、日志、配置等基础布局；未设置 `VESTI_DB_PATH` 时数据库为 `<VESTI_HOME>/db/vesti.db`。 |
| `VESTI_DATA_DIR` | `VESTI_HOME` 的兼容别名，优先级低于 `VESTI_HOME`。 |
| `VESTI_CAPTURE_DISABLED` | 值为 `1`、`true` 或 `yes`（忽略大小写）时，MCP 不确保守护进程，只读取已经存在的数据库。 |
| `VESTI_CAPTURE_STARTUP_TIMEOUT_MS` | MCP 等待守护进程完成初始化的上限；仅接受不小于 1000 ms 的有限数值，否则使用 120000 ms。 |
| `VESTI_MCP_SERVER_PATH` | `@vesti/memory setup` 使用的 MCP CLI 入口覆盖值，适用于源码构建或非标准安装位置。 |
| `KIMI_CODE_HOME` | Kimi Code 的配置、Skill 和原生会话根目录覆盖值。 |
| `APPDATA` / `XDG_CONFIG_HOME` | Cursor、Trae、Qoder 等适配器在相应系统上解析产品数据目录时使用的系统约定。 |

精确规则分成两条：基础目录优先使用显式 `--data-dir`/`basePath`，其次是 `VESTI_HOME`、`VESTI_DATA_DIR`，再其次从数据库覆盖值反推，最后才是 `~/.vesti`；数据库则始终优先使用显式 `--db-path`/`dbPath`，其次是 `VESTI_DB_PATH`，否则为 `<基础目录>/db/vesti.db`。若数据库位于常规 `<root>/db/vesti.db`，协调目录从 `<root>` 推导；否则从数据库父目录推导。

路径选择需要保持一致。推荐只选择一种部署方式：

- 使用默认 `~/.vesti`；或
- 为所有相关宿主统一设置 `VESTI_HOME`；或
- 为所有相关宿主统一设置 `VESTI_DB_PATH`。

若只给部分宿主设置变量，它们可能读写不同数据库，这是隔离机制的正常结果，不会自动跨库合并。反过来，如果不同宿主的基础目录不同但数据库相同，它们仍会连接同一个 daemon；最先取得锁的进程所用基础目录决定该进程的 Vault 和日志位置。因此仍应让所有宿主持有一致配置。`vesti setup` 会把当时显式设置的 `VESTI_HOME`、`VESTI_DB_PATH`、`VESTI_DATA_DIR` 和 `KIMI_CODE_HOME` 绝对化并写入 MCP 条目的环境变量，避免宿主重启后退回默认路径。

## 10. 故障与降级行为

| 情况 | 当前行为 | 影响 |
| --- | --- | --- |
| 守护进程不可用，但数据库已经存在 | MCP 在 stderr 明确告警，以 `capture=stale` 继续只读服务 | 历史召回可用，新记录暂不进入数据库 |
| 设置 `VESTI_CAPTURE_DISABLED`，且数据库存在 | MCP 以 `capture=disabled` 查询静态数据库 | 不启动或检查实时采集 |
| 守护进程不可用，数据库也不存在 | MCP 启动失败并给出运行时/setup 指引 | 不返回伪造的空记忆 |
| WSL 检测失败 | 记录警告，原生平台继续工作 | WSL 内记录等下次检测恢复 |
| 单个平台发现或解析失败 | 错误写入同步摘要/来源状态，其余平台继续 | 该平台本轮数据可能滞后 |
| watcher 报错或漏事件 | watcher 错误不向上抛；5 分钟校准重新扫描 | 最终补齐依赖源文件仍存在且可读 |
| 源数据库暂时被产品锁定 | 本轮检测或解析可能失败，后续 watcher、轮询或校准重试 | 短期数据延迟 |
| Vault 备份失败 | 备份任务不阻塞主捕获写入 | SQLite 中的规范化数据可能已存在，但对应源备份缺失 |
| 协议版本不一致 | 客户端拒绝把旧守护进程视为兼容 | 有旧数据库时 MCP 可进入 stale 模式；否则启动失败 |
| 锁心跳失去所有权 | daemon 停止采集并安全关闭自身资源 | 防止失权进程继续写入；下一次 ensure 可连接或启动当前 owner |
| 进程异常退出 | 下次启动通过 PID、token 和恢复仲裁处理陈旧锁 | 恢复依赖下次 ensure、手动启动或系统服务管理器 |

当 `initial sync` 中个别平台有错误时，守护进程仍可能进入 `running`，具体错误应通过 `vesti status`、IPC `status` 和 `capture-daemon.log` 检查。`ready` 表示基础数据库已初始化且初始同步流程已经结束，不表示每一个来源都无错误。

## 11. 隐私与安全边界

### 11.1 保存在本机的内容

运行时会读取受支持产品已经落盘的本地会话记录，并可能保存：

- 用户输入、助手回复、进度/思考字段（取决于源格式）；
- 工具名称、输入/输出摘要、错误状态；
- 会话时间、产品标识、模型与 token 信息（源格式提供时）；
- 项目路径、文件路径、子任务和分支关系；
- 同步检查点和解析告警。

SQLite 位于配置的数据根目录。对允许源备份的适配器，Vault 还会保存压缩后的源文件副本；Cursor 和 Trae 的 SQLite 源明确关闭了 Vault 源备份。运行日志通常记录运行状态、路径和错误，不以保存完整对话正文为目的，但错误对象仍可能包含源路径或底层异常信息。

### 11.2 本地与外部边界

- 当前守护进程默认只读本地源、写本地目录，并通过本地 named pipe/Unix socket 通信；它不会在默认路径启动 HTTP/TCP 监听。
- Unix socket 设置为 `0600`。Windows 使用本地 named pipe，但当前代码没有为该 pipe 配置一套额外的自定义 ACL，因此不应宣称实现了独立于系统账户权限的访问控制。
- MCP 把查询结果交给宿主。宿主随后如何把内容发送给模型或远程服务，取决于该宿主及模型提供方的配置，这已超出 VESTI 本地守护进程的边界。
- 会话源产品自身的云同步行为不由 VESTI 控制。

当前实现没有提供或承诺：云端同步、遥测上报、数据库静态加密、字段级脱敏、密钥扫描、自动保留期限、合规删除工作流或多用户权限系统。部署者应按敏感工作记录保护 `VESTI_HOME`，设置合适的系统账户权限，并把数据库、Vault 和日志纳入自己的备份与删除策略。

## 12. 部署说明

### 12.1 运行要求

- Node.js `>=22.12.0`；
- `@vesti/capture-runtime`、`@vesti/mcp` 和 `@vesti/memory` 的已构建产物；
- `better-sqlite3` 等依赖正确安装。它是原生模块，目标 Node ABI 和操作系统必须有可用预构建包或本机编译环境；
- 宿主允许配置 stdio MCP，并能启动 Node 子进程；
- 当前用户对各会话源目录和 `VESTI_HOME` 有读写权限。

### 12.2 推荐安装入口

发布后的一体化入口是：

```bash
npm install -g @vesti/memory
vesti setup
vesti status
vesti sync
vesti doctor
```

也可以明确指定自动配置宿主：

```bash
vesti setup --host codex
vesti setup --host claude
vesti setup --host kimi-code
vesti setup --host cursor
vesti setup --host all --dry-run
```

`setup` 会把 Skill 安装到宿主的用户 Skill 目录，并把 `vesti` stdio MCP 条目合并到宿主配置。写入前会备份原配置；不相关配置保留；无法可靠解析的 TOML/JSON 不会被覆盖，而是输出手工配置步骤。重复执行是幂等的。显式数据路径会被绝对化并持久化；配置完成后应重启或重新加载宿主。

持久化 setup 应从全局安装或固定源码目录运行。一次性 `npx` 缓存中的绝对入口会随缓存清理失效，因此安装器拒绝把这类路径写入长期宿主配置。

### 12.3 守护进程直接运行

`vesti-captured` 只有在直接全局安装 `@vesti/capture-runtime` 时才保证位于 PATH；普通用户应使用 `vesti setup`，由 MCP 自动管理其依赖内的 daemon。直接安装运行时包后的高级用法是：

```bash
vesti-captured --foreground
vesti-captured --data-dir /path/to/vesti
vesti-captured --db-path /path/to/vesti.db
vesti-captured --platforms codex,cursor,claude-code
vesti-captured --wsl-poll-ms 60000 --reconcile-ms 300000
vesti-captured --no-watch
```

间隔参数允许 `0`，表示停用对应定时器。`--no-watch` 只停用原生 watcher；初始同步仍会执行，未另外设为 `0` 的 WSL 轮询和周期校准仍会运行。前台模式的日志写 stderr，不占用 MCP stdio 的 stdout。

### 12.4 生命周期与开机自启

当前 `setup` 只为当前登录会话启动 detached 守护进程，不创建操作系统启动项。实际恢复路径是：

- 用户启动已配置宿主；
- 宿主启动 `vesti-mcp`；
- MCP 调用 `ensureCaptureDaemon()`；
- 守护进程重新启动，并通过初始增量扫描补录停止期间仍保存在源产品目录中的记录。

如果业务要求“登录后即开始采集，即使一直没有打开任何 MCP 宿主”，部署层还需要显式配置 Windows 计划任务、LaunchAgent 或 systemd user service，并负责进程重启、环境变量和日志生命周期。该服务注册目前不属于仓库内 setup 的已实现能力。

### 12.5 与桌面 App 共存

无 App 模式使用的默认数据结构与桌面 App 的 `~/.vesti` 布局兼容，便于已有数据继续被查询。但“路径兼容”不等于“两个捕获器可安全并发写入”。在桌面 App 的捕获机制完全改为复用 `vesti-captured` 或同一锁协议以前，部署时应二选一：

- 使用 standalone 守护进程采集，App 不启动旧捕获写入；或
- 暂时由 App 捕获，MCP 仅只读既有数据库。

### 12.6 发布顺序与包级验证

workspace 依赖必须通过 pnpm 的 pack/publish 流程改写为发布版本。发布顺序为：

1. `@vesti/search-files-core`
2. `@vesti/capture-runtime`
3. `@vesti/mcp`
4. `@vesti/memory`

发布前不仅要在源码工作区测试，还要对四个 tarball 执行安装验证，确认 `@vesti/memory` 能从打包后的目录解析 `@vesti/mcp/cli`，随后在隔离 HOME 中完成 setup dry-run 和 standalone smoke。CI 同时在 Linux 和 Windows 执行类型检查、单测、构建与 smoke；tarball 安装仍应作为发布检查项保留。

旧 capture-core 写入的 WSL 行可能仍使用不含用户的 `wsl:<distro>` 身份。standalone 运行时不会在缺少可靠用户信息时猜测迁移这些旧行；对应源以后重新同步时，旧、新身份可能暂时并存。正式迁移既有数据库前应先备份，并另行提供基于源路径核验的一次性迁移工具。

## 13. 当前验收边界

可以据当前实现验证的目标：

- 不安装/不开启 App 时，守护进程能创建 `~/.vesti`、数据库 schema 和日志；
- 初始同步完成前 client 不把服务报告为 query-ready；
- 默认仅监听 7 个启用平台，Trae WAL/SHM 事件映射回主数据库；
- 多个客户端并发 ensure 最终只保留一个守护进程写者；
- MCP 在 SQLite `query_only` 下完成检索，并在实时采集失败时按是否存在数据库选择 stale 降级或明确失败；
- 守护进程关闭时先标记取消并等待初始化、定时器、watchers、写队列与 Vault 备份队列结束，再关闭数据库、IPC，并只释放自己仍持有的锁与 socket。

不应据当前实现宣称的目标：

- 安装后操作系统开机自启；
- 对 7 个采集源都已自动写入 MCP/Skill 宿主配置；
- 任意厂商版本和任意自定义存储路径都能自动解析；
- standalone 守护进程会自动生成摘要、向量、项目 brief 或长期记忆条目；
- 多台设备或多个系统账户之间自动同步；
- 数据已自动加密、脱敏或执行保留期限；
- 旧 App 捕获器与 standalone 守护进程可无条件同时写同一个 SQLite 文件。
