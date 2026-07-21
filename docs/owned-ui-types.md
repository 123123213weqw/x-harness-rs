# 自有前端类型边界

## 约束

自有 TS/TSX 的字段通过精确接口、Schema 或真实类型守卫确定，而非声明成任意类型后强制转换。
构建必须开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；不能开启
`allowJs` 或 `skipLibCheck` 规避边界。TypeScript 仅为开发／CI 依赖。

同一 AST／TypeChecker 门禁用于业务模块和 Plugin API：

- 禁止显式 `any`、直接推断的 `any` 绑定／返回及 `Promise<any>`、`any[]` 等容器泄漏。
- 禁止普通 `as T`、`as unknown as T`、`<T>value`。
- 禁止非空断言 `value!`；缺失值必须明确判断、报错或采用已有业务默认值。
- 禁止 `@ts-ignore`、`@ts-nocheck`、`@ts-expect-error`；负例在测试的虚拟编译单元中直接检查诊断，不压掉错误。
- 允许 `as const` 保持字面量、`import/export ... as ...` 重命名、`satisfies` 检查赋值。
- JSON／Host／Tauri 返回值先接为 `unknown`，验证后才读取字段。未知的新字段不能被偷偷当作已知 DTO。
- 不以 `!`、虚构 ambient declaration、把业务逻辑移到 JS／vendor 代替验证。

固定版本、许可和原始 Hash 的真正第三方库保留原有实现。它们内部的 `ReactElement`、
`ComponentClass` 等库类型不被误报为业务使用 `any`；显式写在自有代码里的 `any` 仍然拒绝。
该例外不是允许未验证的 RPC 字段，也不是证明所有第三方依赖完全类型安全。
新增第三方源码必须审查来源与许可，不能只换目录名就获得豁免。

## 回归

```sh
npm ci --prefix ui --ignore-scripts
node --test scripts/test-owned-ui-type-policy.mjs scripts/test-source-module-builder.mjs \
  scripts/test-plugin-api-types.mjs scripts/test-plugin-api.mjs
```

覆盖普通／非空断言及抑制指令拒绝、模板与正则中的文本避免误报、真实未知值验证、隐式／异步
`any`、第三方 React 类型、无法降低严格配置，以及端点到响应 DTO 的编译期关联。
Plugin API 运行时同时验证异常 envelope、错误字段、端点串用、原型键、错误消息隐私、
并发独立性和非幂等操作不自动重试。

## 完整迁移验收

当前重构基于合并后的 `a613970c78a36a024de56100078323df25b96004`。
`ui/reference/master-a613970` 是独立冻结的行为测试基线，禁止作为生产构建输入；
`ui/dist` 和 npm 缓存同样不能充当自有业务源码。

单项类型门禁通过不等于完整迁移完成。全部业务和平台模块还必须严格编译、从干净检出
构建，并在冻结原版与源码版之间验证 Host 协议、注册／清理、流式内容、历史恢复和
浏览器交互；桌面原生实机验收及发布仍是独立门禁。

## 不能用另一种写法掩盖断言

`unknown` 不自动证明字段正确。类型守卫必须检查其承诺的字段；只检查对象外壳，
再返回完整 DTO 的谓词，与 `as T` 一样不能证明数据。
泛型 JSON 持久化需要真实 `unknown → State` decoder；没有 decoder 的旧 JS ABI
只能诚实地返回 `unknown`，不能声称任意数据符合调用者选定的 `T`。
同理，函数的存在不证明参数和返回值签名，动态方法要在调用及返回边界验证。
类型约束不能以清空历史、忽略旧事件或丢掉合法已注册视图的方式实现。
