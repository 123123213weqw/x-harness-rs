# 上游兼容目录

该目录记录冻结 DeepSeek Harness 上游的机器可读目录和中文兼容矩阵。重新生成：

```bash
python3 scripts/sync_upstream_catalog.py \
  --upstream /path/to/deepseek-harness
```

生成过程只读取上游 Git 工作树，不执行 Node 代码，不修改上游，也不会自动移动
`xharness-api::UPSTREAM_CONTRACT_REVISION`。工具和 Prompt 的动态名称会保留为表达式，必须人工审计，
不能因为正则没有解析成 Literal 就当作上游不存在。

候选上游不会直接覆盖冻结目录：以 `candidate-<sha>.json` 保存，并配套
`DELTA-<base>-<candidate>.md`。只有升级门槛全部通过后，候选才能成为新的
`upstream-<sha>.json` 冻结基线。
