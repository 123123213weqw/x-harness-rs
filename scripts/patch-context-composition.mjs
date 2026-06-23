// Replace the upstream composer meter with a request-scoped composition view.
// The rest of the upstream conversation UI remains untouched.
export function patchContextComposition(bytes) {
  let source = bytes.toString()
  if (source.includes('xharness-context-composition/v1')) {
    return Buffer.from(source.replace(
      'const weight = composition ? rows.reduce(',
      'const weight = available && composition ? rows.reduce(',
    ))
  }
  const start = source.indexOf('function ContextMeter({ useProjection, t }) {')
  const end = source.indexOf('\n\t\t//#endregion', start)
  if (start < 0 || end < 0) throw Error('ContextMeter anchor changed')
  source = source.slice(0, start) + METER + source.slice(end)
  const replace = (oldText, newText) => {
    if (source.split(oldText).length !== 2) throw Error(`ContextMeter locale anchor changed: ${oldText}`)
    source = source.replace(oldText, newText)
  }
  replace('"context.messages": "对话消息",',
    '"context.messages": "对话消息", "context.user": "用户", "context.assistant": "助手", "context.toolResults": "工具结果", "context.mcp": "MCP 工具", "context.protocol": "协议开销", "context.distributionEstimate": "颜色分布为估算",')
  replace('"context.messages": "Messages",',
    '"context.messages": "Messages", "context.user": "User", "context.assistant": "Assistant", "context.toolResults": "Tool results", "context.mcp": "MCP tools", "context.protocol": "Protocol overhead", "context.distributionEstimate": "Category shares are estimated",')
  return Buffer.from(source)
}

export function patchContextCompositionConnection(bytes) {
  let source = bytes.toString()
  if (source.includes('xharness-context-composition-replay/v1')) return bytes
  const start = source.indexOf('function contextPressureOf(log) {')
  const end = source.indexOf('\n\t\tfunction projectionValuesOf', start)
  if (start < 0 || end < 0) throw Error('context pressure replay anchor changed')
  let block = source.slice(start, end)
  const oldText = "measurement:d.header?.options?.measurement ?? {turn:active?.[0] ?? null,step:active?.[1] ?? null,source:'legacy_request'}};"
  if (block.split(oldText).length !== 2) throw Error('context pressure request anchor changed')
  block = block.replace(oldText,
    "measurement:d.header?.options?.measurement ?? {turn:active?.[0] ?? null,step:active?.[1] ?? null,source:'legacy_request'}, composition:d.header?.options?.contextComposition}; // xharness-context-composition-replay/v1")
  return Buffer.from(source.slice(0, start) + block + source.slice(end))
}

const METER = `function ContextMeter({ useProjection, t }) {
            // xharness-context-composition/v1; xharness-context-meter-stable/v1
            const h = react.createElement;
            const pressure = useProjection("contextPressure");
            const composition = pressure?.composition;
            const [open, setOpen] = react.useState(false);
            const rootRef = react.useRef(null);
            const context = contextOccupancy(pressure);
            const available = context !== null;
            react.useEffect(() => { if (!available && open) setOpen(false); }, [available, open]);
            react.useEffect(() => {
                if (!open || !available) return;
                const pointer = event => {
                    if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
                    setOpen(false);
                };
                const escape = event => { if (event.key === "Escape") setOpen(false); };
                document.addEventListener("pointerdown", pointer);
                document.addEventListener("keydown", escape);
                return () => {
                    document.removeEventListener("pointerdown", pointer);
                    document.removeEventListener("keydown", escape);
                };
            }, [available, open]);
            const rows = [
                {key:"systemTokens",label:"context.system",tint:"#8290a5"},
                {key:"userTokens",label:"context.user",tint:"#3b82f6"},
                {key:"assistantTokens",label:"context.assistant",tint:"#20a887"},
                {key:"toolResultTokens",label:"context.toolResults",tint:"#e1a63b"},
                {key:"toolDefinitionTokens",label:"context.tools",tint:"#a78bfa"},
                {key:"mcpToolDefinitionTokens",label:"context.mcp",tint:"#c770ca"},
                {key:"protocolTokens",label:"context.protocol",tint:"#9b9b9b"}
            ];
            const weight = available && composition ? rows.reduce((n, row) => n + (Number.isSafeInteger(composition[row.key]) && composition[row.key] > 0 ? composition[row.key] : 0), 0) : 0;
            const percent = context?.percent ?? 0;
            const reading = available ? (context.exact ? "" : "≈") + percent + "%" : null;
            const label = available ? t("context.aria", {percent:reading}) : t(["preparing","in_flight","model_changed"].includes(pressure?.phase) ? "context.pending" : "context.unavailable");
            const segments = weight > 0 ? rows.filter(row => composition[row.key] > 0).map(row => ({...row, ratio:composition[row.key] / weight})) : [{key:"total",tint:"currentColor",ratio:1}];
            let offset = 0;
            const ring = segments.map(segment => {
                const length = CIRCUMFERENCE * percent / 100 * segment.ratio;
                const circle = h("circle", {key:segment.key,className:ContextMeter_module_css_default.fill,
                    cx:"7",cy:"7",r:RADIUS,stroke:segment.tint,
                    strokeDasharray:length + " " + CIRCUMFERENCE,
                    strokeDashoffset:-offset,transform:"rotate(-90 7 7)"});
                offset += length;
                return circle;
            });
            const swatch = row => h("span", {className:ContextMeter_module_css_default.swatch,
                style:{"--meter-tint":row.tint},"aria-hidden":true});
            const legend = weight > 0 ? h("dl", {className:ContextMeter_module_css_default.rows},
                h("div", {className:ContextMeter_module_css_default.headline}, t("context.distributionEstimate")),
                ...segments.map(row => h("div", {key:row.key,className:ContextMeter_module_css_default.row},
                    h("dt", null, swatch(row), t(row.label)),
                    h("dd", null, "≈" + formatTokens(Math.round(context.usedTokens * row.ratio)))
                ))) : null;
            return h("span", {ref:rootRef,className:ContextMeter_module_css_default.root},
                h(_xharness_dsh_client_ui_primitives.Tooltip, {label,side:"top",delayMs:200,disabled:open},
                    h("button", {type:"button",className:ContextMeter_module_css_default.trigger,
                        "aria-label":label,"aria-haspopup":available ? "dialog" : void 0,
                        "aria-expanded":available ? open : void 0,disabled:!available,
                        onClick:() => setOpen(!open)},
                        h("svg", {viewBox:"0 0 14 14",width:"14",height:"14","aria-hidden":true},
                            h("circle", {className:ContextMeter_module_css_default.track,cx:"7",cy:"7",r:RADIUS}),
                            ...ring
                        )
                    )
                ),
                open && available && h("div", {className:ContextMeter_module_css_default.panel,
                    role:"dialog","aria-label":t("context.used")},
                    h("div", {className:ContextMeter_module_css_default.header},
                        h("span", {className:ContextMeter_module_css_default.headline}, context.label),
                        h("span", {className:ContextMeter_module_css_default.percent}, reading),
                        h("span", {className:ContextMeter_module_css_default.figures},
                            (context.exact ? "" : "≈") + formatTokens(context.usedTokens) + " / " + formatTokens(context.contextWindow))
                    ),
                    h("div", {className:ContextMeter_module_css_default.bar}, ...segments.map(row =>
                        h("div", {key:row.key,className:ContextMeter_module_css_default.segment,
                            style:{width:(percent * row.ratio) + "%","--meter-tint":row.tint}}))),
                    legend
                )
            );
        }`
