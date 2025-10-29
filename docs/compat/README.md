# 上游兼容目录

该目录记录冻结 DeepSeek Harness 上游的机器可读目录和中文兼容矩阵。重新生成：

```bash
python3 scripts/sync_upstream_catalog.py \
  --upstream /path/to/deepseek-harness
```

生成过程只读取上游 Git 工作树，不执行 Node 代码，不修改上游，也不会自动移动
`xharness-api::UPSTREAM_CONTRACT_REVISION`。Catalog Schema v2 记录：

- 52 个固定 RPC 与 `Service Namespace/Remote Method` 组成的动态 Typert RPC；
- Mux/Host Frame 判别目录和允许转发的 Host Event；
- Session Event、Tool 注册点；
- System Prompt 的 Section、Runtime Context、Tool Provider、Variable 四类组件；
- Settings 注册、Cordis Service Definition、`ctx.provide` 组合点；
- Agent Preset 和 Package 目录。

动态名称会保留表达式、文件和行号，必须人工审计，不能因为正则没有解析成 Literal 就当作上游
不存在。动态 Remote 端点、固定 RPC、Frame 和 Session Event 必须无重复；Remote 无法解析时生成器
直接失败，防止兼容目录静默漏项。

候选上游不会直接覆盖冻结目录：以 `candidate-<sha>.json` 保存，并配套
`DELTA-<base>-<candidate>.md`。只有升级门槛全部通过后，候选才能成为新的
`upstream-<sha>.json` 冻结基线。
