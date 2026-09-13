# Windows 原生执行离线审计（2026-09-13）

## 范围与证据边界

- 仅静态审计：没有运行 Windows 程序，没有执行 Rust 编译或测试，没有修改生产实现。
- 基础快照：本地 `12a5ca78d0a792e0a455b94ab21449efdb41eeb3`。
- 通过此前缓存的 `93617a09c91c07be5546d3052cb906f9786ea790` Git tree 核对：process、terminal、sandbox、jobs 的文件以及旧 Win32 实现文件与该版本一致；Win32 新增 crash/diagnostics/lib 使用此前下载的该提交源码单独审查。
- platform 与 coding-tools 的主源码也核对为相同 blob。不是对 2026-09-13 在线最新主分支的完整审计。
- 没有 #74 的 dump 或故障线程栈。下述缺陷不能认定为该访问冲突的根因。

## 首要纠正：PTY 并不是已核对的普通命令执行路径

`coding-tools -> platform.spawn -> ProcessRuntime::spawn -> tokio::process::Command + piped stdout/stderr`。
后台进程 Job 也由 platform.spawn 启动。旧 TerminalRegistry 只在 terminal crate 与其测试内发现调用；在本地被审生产链路中没有注册调用。
不能因为仓库包含 ConPTY 就把 #74 归因于它。库存在、被链接与代码实际执行是不同证据。

## 发现 1：进程监督器错误返回时没有取消输出采集任务（P2，生产路径）

位置：`crates/xharness-process/src/lib.rs:790-845`，尤其 828、832、836、845 的 `?`。

stdout/stderr 通过 tokio::spawn 启动，JoinHandle 是普通局部变量。监督器在 wait、terminate、Job 排空等错误分支提前返回时，掉落 JoinHandle 仅分离任务，不会取消任务。显式 abort/await 只存在后面的 capture drain 超时分支。

后果：错误返回不等于采集已经停止；如果仍有写端存活或 EOF 没有到达，采集任务可继续持有输出缓冲、管道、LiveOutputState 和 DebugRecorder。若写端正常关闭则会自行结束，不能称为每次必现的永久泄漏。跨平台通用，Windows Job 失败路径值得覆盖。不属于已证实的指针越界。

修复：让两个采集任务有 RAII 取消保护，所有退出路径先发取消再尽可能 await；drop 时至少 abort。保持正常完成的尾部输出排空。

回归：注入 terminate/accounting 错误并保持模拟 reader pending，验证返回后采集任务计数归零、Drop 探针释放；测试监督器 abort 与正常尾部输出完整性。

## 发现 2：无效句柄判定仍构造 RAII 对象并 CloseHandle（P2，生产底层）

位置：`crates/xharness-win32/src/handle.rs:15-16`。

`condition.then_some(Self(handle))` 会先计算 Self(handle)，即使 condition=false。返回 None 时临时对象掉落，Drop 仍执行 CloseHandle(0/-1)。因此错误分支也会调用 CloseHandle，可能把原始 API 错误覆盖为 invalid handle，使随后的 Win32Error::last 记录错误原因。

这不是“双重释放已拥有的合法句柄”的证据；不能由此认定 #74。主要是错误清理和错误诊断缺陷。

修复：显式 if/else，只对有效句柄构造所有者；Win32 调用失败时尽早保存错误码。

回归：设置可识别的 LastError 后分别传入 0、INVALID_HANDLE_VALUE，验证返回 None 且未改变错误码；有效句柄 Drop 恰好一次。需要 Windows 测试。

## 发现 3：受限进程加入 Job 失败时终止了错误的对象（P2，runner 底层）

位置：`crates/xharness-win32/src/restricted_process.rs:119-121`。

CreateProcessAsUserW 已创建挂起进程。AssignProcessToJobObject 失败后，仅 job.terminate(1) 然后返回。该 child 未加入该 Job，终止这个 Job 不能保证终止 child；关闭进程/线程句柄也不等于终止进程。

后果：独立调用此底层 API 时可遗留挂起进程。当前生产 runner 还有 ProcessRuntime 外层 Job，所以通常有额外回收保护，不能声称生产环境每次必然泄漏。ConPTY 的相应失败分支已有 TerminateProcess，对比可确认实现不一致。

修复：失败时使用仍持有的 process handle 直接 TerminateProcess 并有界等待，保留原始分配失败原因；不要依赖尚未建立成功的 Job。

回归：故障注入强制 Job assignment 失败，在不依赖外层 Job 的隔离子进程中确认挂起 child 被清理。

## 发现 4：旧 Windows Terminal 同步写入阻塞 Tokio，close 超时无法覆盖（P1 条件性，非当前已核对生产路径）

位置：`crates/xharness-terminal/src/lib.rs:518-525,600-605`。

async write_input 持有异步 Mutex 后，直接对标准 File 调用同步 write_all/flush。目标不读输入、管道满时会卡住执行它的 Tokio worker。close 在建立 grace deadline 之前先 await Interrupt；Interrupt 又调用同一写入路径。若之前的 send 卡住或 Ctrl-C 写入卡住，close 永远走不到超时/Kill 分支。

后果：终端卡死、shutdown 无法完成、资源长期存活。不能解释没有调用该模块的 Host 崩溃。

修复：独立可取消 I/O 机制；终止通道不得依赖被阻塞的 stdin；关闭总 deadline 覆盖整个过程。仅套 async timeout 或把阻塞调用移入 spawn_blocking 不足以保证底层 I/O 停止。

回归：不读 stdin 的测试子进程 + 超过管道容量的输入；并发 send/close/cancel，验证计时器继续推进、关闭有界、reader/writer 最终释放。

## 发现 5：旧 Terminal 丢失高位 Windows 退出码（P2，非当前已核对生产路径）

位置：`crates/xharness-terminal/src/lib.rs:877-879`。

`i32::try_from(u32).ok()` 会把 0xC0000005、0xC000013A 等高位状态丢成 None。现有 ProcessRuntime 使用标准 ExitStatus.code，并不走这里；#74 的 host_exit 正确记录了负数，因此该缺陷不是那条 Host 日志的来源。

修复：统一使用 u32 原始码加十六进制，或按现有 i32 协议进行明确的位模式转换，不能把正常存在的码当作缺失。

回归：0、1、0x7fffffff、0x80000000、0xc0000005、0xc000013a、0xffffffff 的编码往返。

## 暂不升级为缺陷的项目

- ConPTY AttributeList 使用 Vec<usize> 保证相应对齐，缓冲区随对象保留；暂未发现栈指针逃逸。
- File::from_raw_handle 使用 into_raw 转移所有权；暂未发现该路径的重复拥有。
- 常规输出捕获与 terminal scrollback 有界，不支持“所有输出无限增长”的说法。
- crash 采集在桌面观察者内，故障 Host 只发送上下文并等待；已有日志不能推出采集造成 Host 崩溃。
- 线程快照恢复进程、PTY 输出任务缺少显式 join 等值得继续做竞态/排空测试，本轮不把未经证明的风险写成访问冲突根因。

## 建议顺序

先修复生产底层的无效句柄构造和监督器错误路径任务清理，然后修复 runner 失败清理。旧 Terminal 若不再计划启用，应明确标注或移出生产候选，而不是围绕它重写主执行链路。

#74 仍需匹配 EXE/PDB 的异常线程栈；这轮静态审计没有确认 use-after-free、double-free 或导致 0xC0000005 的具体指令。

## 本轮修复与验证

已修复发现 1—3；发现 4—5（未接入生产的旧 Terminal）不在本次用户选定范围内，仍待处理。

- 采集任务：增加 AbortHandle 生命周期守卫，覆盖监督器提前报错、取消和展开退出；正常完成仍等待 stdout/stderr 排空。abort 是取消请求，资源释放需要 Tokio 继续调度，不能宣称 Drop 内同步等待完成。
- 句柄：无效值不再构造 OwnedWin32Handle，避免 Drop 调用 CloseHandle 污染 LastError。
- 受限进程：Job 分配失败后直接终止已持有句柄的挂起子进程，成功发出终止后最多等待 5 秒；保留原始分配错误。终止本身属于 best-effort，未声称所有 OS 故障下都能强制成功。
- 新增 7 个回归用例：3 个跨平台采集生命周期测试，2 个 Windows 句柄测试，2 个 Windows Job 分配清理测试（失败注入及成功分配）。

验证全部在 WZU_Server 执行，未在 Mac 编译 Rust：

1. `cargo test -p xharness-process -p xharness-win32`：Linux 实际运行 15 个测试，通过；Windows 条件测试在 Linux 上不会执行。
2. `cargo test -p xharness-tools -p xharness-coding-tools --lib --tests`：39 个通过，4 个真实模型集成测试按既有配置忽略。
3. `cargo check -p xharness-win32 -p xharness-process --tests --target x86_64-pc-windows-gnu`：Windows 源码与测试交叉类型检查通过；不等于 Windows 真机测试通过。
4. 本地 `cargo fmt --all`、`git diff --check` 通过。

Windows 真实执行仍需 Windows CI/真机；本轮未推送、未发布、未替换运行中的软件，也未确认 #74 根因。

### 主分支集成复验

按用户后续要求，将修复无冲突应用于远端主分支 `81147a1`（仓库主分支名为 master）。在 WZU_Server 上重新同步完整源码并验证：上述四个 crate 的 54 个测试通过，4 个真实模型测试忽略；Windows 目标源码和测试交叉检查通过。Windows 真机运行结果仍待 CI 验证。仅提交源码修复，不发布安装包。
