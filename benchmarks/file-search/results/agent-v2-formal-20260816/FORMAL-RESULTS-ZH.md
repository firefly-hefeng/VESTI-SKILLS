# VESTI 历史文件定位 V2 正式实验结果

## 结论

本次正式实验在预注册协议下机械有效，但唯一主假设失败。

- `modern-vesti`（D）成功率：246/360，68.33%。
- `modern-none`（B）成功率：276/360，76.67%。
- 主效应 D−B：-8.33 个百分点。
- 20 个 `conceptId` 聚类 Bootstrap 95% CI：[-14.44, -2.77] 个百分点。
- 预注册要求效应为正且置信区间下界大于 0；实际方向显著为负，因此主终点判定为 **FAIL**。
- 主终点失败后，retrieval D−B、D−C 和 D−A 的层级确认性检验均未开启；相关数值只能作为描述性结果。

不能宣称“MCP 与当前 Skill 的组合显著提高了总体历史文件定位成功率”。可以宣称的是：当前 Skill 显著增强了负例拒答安全性，并降低了调用次数和 Token，但付出了较大的正例准确率代价。

## 实验有效性

- 冻结提交：`d01cc284654edc667e1efe370c3c1176e197ee2a`。
- 冻结标签：`eval/formal-v2-locked-20260816`。
- 模型：`gpt-5.6-luna`；Codex CLI `0.144.6`。
- 120 个 case、20 个概念簇、4 个实验臂、每题每臂 3 次，共 1,440 次运行。
- `runs.ndjson` 含 1,440 条合法记录和 1,440 个唯一 `runId`。
- 360/360 个 case/repeat 区组均包含 A、B、C、D 四臂。
- 1,437 次 completed，3 次 Agent failure；总完成率 99.79%。
- 各臂完成数：A 358/360、B 360/360、C 359/360、D 360/360，均达到预注册的每臂至少 357 次门槛。
- 首轮存在 1 条 infrastructure failure；严格 `--resume` 校验全部冻结哈希后只重跑该条，最终无遗留 infrastructure failure。
- 所有语料、runner、schema、Skill、placebo、MCP、fixture、experiment、schedule 和四臂哈希均与锁定 ledger 一致。
- 独立逐条重评分与原结果 0 差异；独立重算 10,000 次概念簇 Bootstrap 与 `summary.json` 0 差异。

因此，`manifest.json` 的 `completed-with-errors` 表示保留了 3 个按 ITT 计零的 Agent failure，不表示实验整体无效。

## 四臂结果

| 实验臂 | 成功数 | 总数 | 成功率 |
| --- | ---: | ---: | ---: |
| A：legacy-none | 279 | 360 | 77.50% |
| B：modern-none | 276 | 360 | 76.67% |
| C：modern-placebo | 271 | 360 | 75.28% |
| D：modern-vesti | 246 | 360 | 68.33% |

`taskSuccess` 与 `retrievalTaskSuccess` 在全部 1,440 条记录中完全相同；所有臂都正确使用了 `historical_only=true`，所以历史状态字段没有制造 D 组优势。两个端点在本实验中是冗余的，retrieval 端点没有提供独立确认性证据。

## 正例与负例的权衡

| 范围 | B：modern-none | D：modern-vesti | D−B |
| --- | ---: | ---: | ---: |
| 300 个正例 | 262/300，87.33% | 187/300，62.33% | -25.00pp |
| 60 个负例 | 14/60，23.33% | 59/60，98.33% | +75.00pp |
| 全部任务 | 276/360，76.67% | 246/360，68.33% | -8.33pp |

配对比较中，D 相对 B 在正例上 12 胜、87 负、201 平；在负例上 45 胜、0 负、15 平。负例收益抵消了部分正例损失，但没有完全抵消。

## 负例安全性

预注册 hard-negative 安全 Gate 通过：

- D：0/30 ITT false positive，0%。
- B：29/30 ITT false positive，96.67%。
- D−B：-96.67pp；两侧 95% CI [-100, -90]pp；单侧 95% 上界 -90pp。
- Gate 条件为 D 不高于 20%，且 D−B 单侧上界低于 +10pp；两项均满足。

但必须同时披露 schema 语义影响：B 的 29 个 hard-negative 注册误报中，20 个实际上输出 `files=[]` 且自然语言明确表示没有证据，只是把 `answerable` 填成了 `true`。若只计算真正返回错误文件：

- Hard negative：B 9/30（30%），D 0/30（0%）。
- Clean negative：B 1/30（3.33%），D 0/30（0%）。

因此，安全改善仍然真实，但“96.67pp”同时包含输出合同遵从性的差异，不能全部解释成文件幻觉下降。

## 正例失败原因

D 的 113 个正例失败不是过度拒答：正例中 `answerable=false` 为 0。失败集中在候选选择和验证：

- 113/113 均返回了额外、不受完整证据支持的文件。
- 74 次已经找全 Gold，但又附带额外文件。
- 39 次既漏 Gold，又返回额外文件。
- 共漏 63 个 Gold，并加入 430 个非 Gold 文件。
- 已匹配 Gold 的 project、evidence session 和 `historical_only` 没有错误。
- 113 个失败中，Gold 全都已经出现在第一次 `vesti_search_files` 的候选列表；问题不是 MCP 候选召回不足，而是 Agent 没有选出唯一受完整锚点支持的集合。

按类别看：

| 类别 | B 成功率 | D 成功率 | D−B |
| --- | ---: | ---: | ---: |
| cross-project | 78.33% | 36.67% | -41.67pp |
| multi-file | 86.67% | 58.33% | -28.33pp |
| filename-only | 80.00% | 56.67% | -23.33pp |
| semantic-single | 98.33% | 75.00% | -23.33pp |
| stale-path | 93.33% | 85.00% | -8.33pp |

根因是当前 Skill 与 MCP 的观察面不匹配：Skill 强调先使用文件级搜索、减少调用、尽早停止，并且位置问题通常不展开历史消息；但本正式集刻意包含同 basename、相近项目和宽主题干扰项。`vesti_search_files` 返回候选路径、分数和 backing session，却不直接证明候选是命中了完整锚点还是只命中了宽主题。D 组因而把软排序当作严格合取证据，并经常合并多个候选；B 组虽然更慢，却更常使用 timeline/turns 核对完整锚点。

## 效率

D 相对 B 的描述性中位数变化：

- MCP 调用：6 → 3，下降 50%。
- 输入 Token：130,728 → 74,593，下降约 42.9%。
- 端到端时延：30,726ms → 27,964ms，下降约 9.0%。

这些是探索性结果，而且伴随成功率下降，不能表述为“同等质量下提效”。

## 三个保留的 Agent failure

- A / `formal-cross-20`：1 个 MCP 调用失败。
- C / `formal-multi-02`：4 个 MCP 调用失败。
- A / clean-negative `formal-negative-10`：2 个 MCP resource 调用失败，并按 ITT 计为 false positive。

B 和 D 均为 360/360 completed，因此 D−B 主结果与 hard-negative Gate 不受这三个 Agent failure 的不平衡影响。

## 可宣称与不可宣称

可以宣称：

- 在冻结的合成历史文件定位 benchmark 上，当前 Skill 通过了预注册 hard-negative 安全 Gate。
- 真正的 hard-negative 错误文件返回从 B 的 30% 降为 D 的 0%。
- 中位 MCP 调用和输入 Token 明显下降，但存在准确率代价。

不可宣称：

- MCP 与当前 Skill 的组合提高了总体文件定位成功率。
- 当前 Skill 优于无 Skill、placebo 或 legacy 方案。
- 该结果直接代表真实用户、生产项目或当前文件系统准确率。
- 主终点失败后，任何次级比较构成确认性成功。

## 下一步

本正式集已经解封，不能在其上调参后重新宣称确认性成功。下一版应在开发集上：

1. 将负例的 exact-token absence Gate 与正例定位流程分开。
2. 同 basename、多 backing session、多文件和跨项目任务必须做 session 级完整锚点验证。
3. basename 单独查询只能用于求交集或过滤，不能与上下文查询结果做并集。
4. 正例用完整锚点检索 session，再按 `evidence_session_ids` 与文件候选求交集。
5. MCP 增加 exact-phrase/all-token、matched snippet、token coverage 和 session filter。
6. schema 明确规定 `files=[]` 时 `answerable=false`，并同时报告合同 FPR 与实际文件返回 FPR。
7. 完成开发集消融后，生成全新、未查看、未用于调参的正式集进行下一次确认性实验。

## 原始产物哈希

- `manifest.json`: `bcc6a546cbda84c1eaa8adecc2c3dd43f61d4cf07925f1775934891df8f106bd`
- `runs.ndjson`: `369ad7391cd38a3b536aef483abee97c20508b39303309091098c166166f2625`
- `summary.json`: `53c178d17d85520b8eb75a1f2392fd534e4a98b5777353db984c1c2195e4d364`
- `report.md`: `573a951bfda9186ee1c167edaf739e885076f65e1c8bef7dd7ebeb5fd6658cc2`

以上哈希对应严格 resume 完成后的 canonical 正式结果。
