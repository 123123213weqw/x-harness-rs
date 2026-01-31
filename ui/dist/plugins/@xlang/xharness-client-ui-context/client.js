window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-context',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useEffect, useMemo, useState } = React
    const h = React.createElement

    const TARGET = 'xharness-context'
    const EMPTY = Object.freeze({ requests: Object.freeze([]), compactions: Object.freeze([]) })
    const STYLE_ID = 'xharness-context-inspector-style'

    function locationFields(location) {
      if (location?.kind === 'step') {
        return { turn: location.turn.turn, step: location.step.step }
      }
      if (location?.kind === 'turn') return { turn: location.turn.turn }
      return {}
    }

    function contextNode(context, anchorSeq, data) {
      return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: TARGET,
        anchorSeq,
        data,
      }
    }

    const requestDefinition = {
      kind: 'xharness-context-request',
      target: TARGET,
      match: event => event.type === 'request/header'
        ? { id: String(event.seq), role: 'start' }
        : null,
      start: (_context, match) => ({
        kind: 'request',
        seq: match.event.seq,
        time: match.event.time,
        reason: match.event.data?.reason,
        header: match.event.data?.header ?? {},
        ...locationFields(match.location),
      }),
      update: context => context.state,
      buildViewNode: context => context.state === undefined
        ? null
        : contextNode(context, context.state.seq, context.state),
    }

    const compactionDefinition = {
      kind: 'xharness-context-compaction',
      target: TARGET,
      match: event => event.type === 'compaction/summary'
        ? { id: String(event.seq), role: 'start' }
        : null,
      start: (_context, match) => ({
        kind: 'compaction',
        seq: match.event.seq,
        time: match.event.time,
        ...match.event.data,
        ...locationFields(match.location),
      }),
      update: context => context.state,
      buildViewNode: context => context.state === undefined
        ? null
        : contextNode(context, context.state.seq, context.state),
    }

    class ContextSnapshotBuilder {
      constructor() {
        this.empty = EMPTY
        this.nodes = new Map()
      }

      replace({ nodes }) {
        this.nodes.clear()
        for (const node of nodes) this.nodes.set(node.key, node)
        return this.snapshot()
      }

      apply({ upserts }) {
        for (const node of upserts) this.nodes.set(node.key, node)
        return this.snapshot()
      }

      snapshot() {
        const ordered = [...this.nodes.values()]
          .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
        return {
          requests: ordered.filter(node => node.data.kind === 'request').map(node => node.data),
          compactions: ordered.filter(node => node.data.kind === 'compaction').map(node => node.data),
        }
      }
    }

    const viewDefinition = {
      target: TARGET,
      create: () => new ContextSnapshotBuilder(),
    }

    function asObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function normalizedRequest(request) {
      const header = asObject(request?.header)
      const options = asObject(header.options)
      const config = Object.keys(asObject(header.config)).length > 0
        ? asObject(header.config)
        : {
            provider: header.provider ?? 'unknown',
            model: header.model ?? 'unknown',
            ...(header.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: header.reasoning_effort }),
          }
      const input = asArray(header.input)
      const system = typeof header.system === 'string' ? header.system : ''
      const hasSystem = input.some(message => message?.role === 'system')
      return {
        request,
        header,
        config,
        options,
        tools: asArray(header.tools),
        messages: hasSystem || system.length === 0
          ? input
          : [{ role: 'system', content: system, synthetic: true }, ...input],
      }
    }

    function tokenBudget(view) {
      const report = asObject(view.options.tokenBudget)
      const estimate = asObject(report.estimate)
      return {
        used: numberOrUndefined(estimate.totalInputTokens ?? estimate.total_input_tokens),
        window: numberOrUndefined(report.contextWindowTokens ?? report.context_window_tokens),
        available: numberOrUndefined(report.availableInputTokens ?? report.available_input_tokens),
        reserved: numberOrUndefined(report.reservedOutputTokens ?? report.reserved_output_tokens),
        meter: typeof report.meter === 'string' ? report.meter : undefined,
        accuracy: typeof report.accuracy === 'string' ? report.accuracy : undefined,
      }
    }

    function numberOrUndefined(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    function fmtTokens(value) {
      if (value === undefined) return '—'
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
      if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`
      return String(value)
    }

    function estimateTokens(value) {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (!text) return 0
      return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3.5))
    }

    function requestLabel(request, index) {
      const view = normalizedRequest(request)
      const step = numberOrUndefined(view.options.step) ?? request.step
      const model = view.config.model ?? 'unknown'
      return `${step === undefined ? `Request ${index + 1}` : `Step ${step}`} · ${model}`
    }

    function compactId(message) {
      const id = typeof message?.id === 'string' ? message.id : ''
      return id.startsWith('compaction-checkpoint-')
        ? id.slice('compaction-checkpoint-'.length)
        : undefined
    }

    function card(kind, title, content, meta, key, raw) {
      return h('article', { className: `xhctx-card xhctx-${kind}`, key }, [
        h('div', { className: 'xhctx-card-head', key: 'head' }, [
          h('span', { className: 'xhctx-kind', key: 'kind' }, title),
          h('span', { className: 'xhctx-card-meta', key: 'meta' }, meta),
        ]),
        h('pre', { className: 'xhctx-content', key: 'content' }, content || '（空）'),
        raw === undefined ? null : h('details', { className: 'xhctx-raw', key: 'raw' }, [
          h('summary', { key: 'summary' }, 'Raw JSON'),
          h('pre', { key: 'json' }, JSON.stringify(raw, null, 2)),
        ]),
      ])
    }

    function detailRow(label, value, key) {
      return h('div', { className: 'xhctx-detail-row', key }, [
        h('dt', { key: 'label' }, label),
        h('dd', { key: 'value' }, value ?? '—'),
      ])
    }

    function RequestDetails({ request, view }) {
      const budget = tokenBudget(view)
      const context = asObject(view.options.context)
      const policy = asObject(context.policy)
      return h('details', { className: 'xhctx-request-details' }, [
        h('summary', { key: 'summary' }, [
          h('span', { key: 'title' }, '请求详情'),
          h('span', { className: 'xhctx-request-count', key: 'count' }, `${view.messages.length} 条消息`),
        ]),
        h('dl', { className: 'xhctx-detail-grid', key: 'grid' }, [
          detailRow('Provider', view.config.provider ?? 'unknown', 'provider'),
          detailRow('Model', view.config.model ?? 'unknown', 'model'),
          detailRow('Sequence', String(request.seq), 'sequence'),
          detailRow('Context Policy', `${policy.name ?? 'identity'} v${policy.version ?? 1}`, 'policy'),
          detailRow('Token Meter', budget.meter ?? '未记录', 'meter'),
          detailRow('Accuracy', budget.accuracy ?? 'estimated', 'accuracy'),
        ]),
      ])
    }

    function messageCards(message, index, hiddenKinds = new Set()) {
      const role = message?.role ?? 'unknown'
      const content = typeof message?.content === 'string'
        ? message.content
        : JSON.stringify(message?.content ?? '', null, 2)
      const reasoning = typeof message?.reasoning === 'string' ? message.reasoning : ''
      const toolCalls = asArray(message?.tool_calls ?? message?.toolCalls)
      const providerItems = asArray(message?.provider_items ?? message?.providerItems)
      const result = []
      const base = `message-${index}`
      const tokenText = `≈ ${fmtTokens(estimateTokens(message))} tok`
      const visible = kind => !hiddenKinds.has(kind)

      if (role === 'assistant') {
        const hasAssistantPart = reasoning.length > 0 || content.length > 0 || toolCalls.length > 0 || providerItems.length > 0
        if (reasoning.length > 0 && visible('reasoning')) {
          result.push(card('reasoning', 'THINK', reasoning, tokenText, `${base}-reasoning`, message))
        }
        if (content.length > 0 && visible('assistant')) {
          result.push(card('assistant', 'ASSISTANT', content, tokenText, `${base}-answer`, message))
        }
        for (const [callIndex, call] of toolCalls.entries()) {
          if (!visible('tool-call')) continue
          const args = call?.arguments_json ?? call?.argumentsJson ?? call?.arguments ?? ''
          const callId = call?.id ?? call?.provider_call_id ?? call?.providerCallId ?? 'unknown'
          result.push(card(
            'tool-call',
            `TOOL CALL · ${call?.name ?? 'unknown'}`,
            typeof args === 'string' ? args : JSON.stringify(args, null, 2),
            `${callId} · ≈ ${fmtTokens(estimateTokens(call))} tok`,
            `${base}-call-${callIndex}`,
            call,
          ))
        }
        for (const [itemIndex, item] of providerItems.entries()) {
          result.push(card(
            'provider',
            'PROVIDER ITEM',
            JSON.stringify(item, null, 2),
            `opaque · ≈ ${fmtTokens(estimateTokens(item))} tok`,
            `${base}-provider-${itemIndex}`,
            item,
          ))
        }
        if (!hasAssistantPart && visible('assistant')) {
          result.push(card('assistant', 'ASSISTANT', '', tokenText, `${base}-empty`, message))
        }
        return result
      }

      if (role === 'tool') {
        const callId = message?.tool_call_id ?? message?.toolCallId ?? 'unknown'
        return visible('tool-result')
          ? [card('tool-result', 'TOOL RESULT', content, `${callId} · ${tokenText}`, base, message)]
          : []
      }

      if (role === 'system') {
        return visible('system') ? [card('system', 'SYSTEM', content, tokenText, base, message)] : []
      }

      if (compactId(message) !== undefined) {
        return visible('compaction')
          ? [card('compaction', 'COMPACTION CHECKPOINT', content, tokenText, base, message)]
          : []
      }

      if (role === 'user') {
        return visible('user') ? [card('user', 'USER', content, tokenText, base, message)] : []
      }

      if (role === 'error' || message?.error !== undefined) {
        return visible('error') ? [card('error', 'ERROR', content, tokenText, base, message)] : []
      }

      return [card('provider', String(role).toUpperCase(), content, tokenText, base, message)]
    }

    function ContextRequestView({ request, heading, dimmed, hiddenKinds }) {
      if (request === undefined) {
        return h('div', { className: 'xhctx-empty' }, '没有可显示的请求快照。')
      }
      const view = normalizedRequest(request)
      const cards = view.messages.flatMap((message, index) => messageCards(message, index, hiddenKinds))
      return h('section', { className: `xhctx-request${dimmed ? ' xhctx-dimmed' : ''}` }, [
        heading === undefined ? null : h('h3', { className: 'xhctx-column-title', key: 'heading' }, heading),
        h(RequestDetails, { request, view, key: 'details' }),
        h('div', { className: 'xhctx-cards', key: 'cards' }, cards.length > 0
          ? cards
          : h('div', { className: 'xhctx-empty' }, view.messages.length > 0
            ? '当前筛选隐藏了所有上下文内容。点击上方筛选项恢复显示。'
            : '这个请求没有记录 input；请使用包含 RequestHeader.input 的 XHarness 后端。')),
      ])
    }

    function HarnessView({ useSession }) {
      const snapshot = useSession(state => state.views.get(TARGET) ?? EMPTY)
      const [selectedSeq, setSelectedSeq] = useState(null)
      const [toolQuery, setToolQuery] = useState('')
      const requests = snapshot.requests
      const latest = requests.at(-1)
      const selected = requests.find(request => request.seq === selectedSeq) ?? latest

      useEffect(() => {
        if (selectedSeq !== null && !requests.some(request => request.seq === selectedSeq)) {
          setSelectedSeq(null)
        }
      }, [requests, selectedSeq])

      if (selected === undefined) {
        return h('div', { className: 'xhctx-root', 'data-conversation-composer-overlay': '' }, h('div', { className: 'xhctx-empty' }, '还没有可用的 Harness 请求快照。'))
      }

      const view = normalizedRequest(selected)
      const prompt = asObject(view.options.prompt)
      const sections = asArray(prompt.sections)
      const context = asObject(view.options.context)
      const policy = asObject(context.policy)
      const budget = tokenBudget(view)
      const systemPrompt = typeof view.header.system === 'string'
        ? view.header.system
        : view.messages.find(message => message?.role === 'system')?.content ?? ''
      const needle = toolQuery.trim().toLocaleLowerCase()
      const tools = needle === '' ? view.tools : view.tools.filter(tool =>
        `${tool?.name ?? ''}\n${tool?.description ?? ''}`.toLocaleLowerCase().includes(needle))
      const reasoningEffort = view.config.reasoningEffort ?? view.config.reasoning_effort ?? '未设置'

      return h('div', { className: 'xhctx-root xhctx-harness-root', 'data-conversation-composer-overlay': '' }, [
        h('div', { className: 'xhctx-toolbar xhctx-harness-toolbar', key: 'toolbar' }, [
          h('select', {
            className: 'xhctx-select',
            value: selected.seq,
            onChange: event => setSelectedSeq(Number(event.target.value)),
            'aria-label': '选择 Harness 请求',
            key: 'select',
          }, requests.map((request, index) =>
            h('option', { value: request.seq, key: request.seq }, requestLabel(request, index)))),
          h('span', { className: 'xhctx-harness-hint', key: 'hint' }, '解释这一步的请求是如何被组装的'),
        ]),

        h('section', { className: 'xhctx-panel', key: 'pipeline' }, [
          h('div', { className: 'xhctx-panel-head', key: 'head' }, [
            h('h3', { key: 'title' }, '请求构造链路'),
            h('span', { key: 'meta' }, `seq ${selected.seq}`),
          ]),
          h('div', { className: 'xhctx-pipeline', key: 'body' }, [
            ['1', 'Prompt Assembly', `${sections.length} sections`],
            ['2', 'Tool Registry', `${view.tools.length} tools`],
            ['3', 'Context Policy', `${policy.name ?? 'identity'} v${policy.version ?? 1}`],
            ['4', 'Provider Request', view.config.provider ?? 'unknown'],
          ].map(([index, title, meta]) => h('div', { className: 'xhctx-pipeline-step', key: index }, [
            h('span', { className: 'xhctx-pipeline-index', key: 'index' }, index),
            h('div', { key: 'text' }, [h('strong', { key: 'title' }, title), h('small', { key: 'meta' }, meta)]),
          ]))),
        ]),

        h('section', { className: 'xhctx-panel', key: 'prompt' }, [
          h('div', { className: 'xhctx-panel-head', key: 'head' }, [
            h('h3', { key: 'title' }, 'Prompt Assembly'),
            h('span', { key: 'meta' }, prompt.assemblerVersion ?? '未记录组装器版本'),
          ]),
          h('div', { className: 'xhctx-section-list', key: 'sections' }, sections.map((section, index) =>
            h('details', { className: 'xhctx-assembly-section', key: `${section?.id ?? index}-${index}` }, [
              h('summary', { key: 'summary' }, [
                h('span', { className: 'xhctx-section-index', key: 'index' }, String(index + 1).padStart(2, '0')),
                h('strong', { key: 'id' }, section?.id ?? `section-${index + 1}`),
                h('span', { key: 'version' }, section?.version ?? '未记录版本'),
              ]),
              h('dl', { className: 'xhctx-detail-grid', key: 'details' }, [
                detailRow('Version', section?.version, 'version'),
                detailRow('Content SHA-256', section?.contentSha256 ?? section?.content_sha256, 'hash'),
              ]),
            ]))),
          h('details', { className: 'xhctx-injected-prompt', open: true, key: 'system' }, [
            h('summary', { key: 'summary' }, [
              h('strong', { key: 'title' }, '最终注入的 System Prompt'),
              h('span', { key: 'meta' }, `≈ ${fmtTokens(estimateTokens(systemPrompt))} tok`),
            ]),
            h('pre', { key: 'content' }, systemPrompt || '这一步没有记录 System Prompt。'),
          ]),
        ]),

        h('section', { className: 'xhctx-panel', key: 'tools' }, [
          h('div', { className: 'xhctx-panel-head xhctx-tool-head', key: 'head' }, [
            h('div', { key: 'title' }, [
              h('h3', { key: 'heading' }, 'Tool Registry'),
              h('span', { key: 'count' }, `${view.tools.length} 个模型可见工具`),
            ]),
            h('input', {
              className: 'xhctx-tool-search',
              value: toolQuery,
              onChange: event => setToolQuery(event.target.value),
              placeholder: '搜索工具',
              'aria-label': '搜索 Harness 工具',
              key: 'search',
            }),
          ]),
          h('div', { className: 'xhctx-registry', key: 'registry' }, tools.length > 0
            ? tools.map((tool, index) => h('details', { className: 'xhctx-registry-tool', key: `${tool?.name ?? index}-${index}` }, [
                h('summary', { key: 'summary' }, [
                  h('code', { key: 'name' }, tool?.name ?? `tool-${index + 1}`),
                  h('span', { key: 'tokens' }, `≈ ${fmtTokens(estimateTokens(tool))} tok`),
                ]),
                h('p', { key: 'description' }, tool?.description || '无 Description'),
                h('h4', { key: 'schema-title' }, 'JSON Schema'),
                h('pre', { key: 'schema' }, JSON.stringify(tool?.parameters ?? {}, null, 2)),
              ]))
            : h('div', { className: 'xhctx-empty' }, '没有匹配的工具。')),
        ]),

        h('div', { className: 'xhctx-harness-columns', key: 'policy-route' }, [
          h('section', { className: 'xhctx-panel', key: 'policy' }, [
            h('div', { className: 'xhctx-panel-head', key: 'head' }, h('h3', null, 'Context Policy')),
            h('dl', { className: 'xhctx-detail-grid', key: 'details' }, [
              detailRow('Policy', `${policy.name ?? 'identity'} v${policy.version ?? 1}`, 'policy'),
              detailRow('Messages', `${context.visible_message_count ?? context.visibleMessageCount ?? view.messages.length} / ${context.source_message_count ?? context.sourceMessageCount ?? view.messages.length}`, 'messages'),
              detailRow('Context Window', `${fmtTokens(budget.window)} tokens`, 'window'),
              detailRow('Reserved Output', `${fmtTokens(budget.reserved)} tokens`, 'reserved'),
              detailRow('Token Meter', budget.meter ?? '未记录', 'meter'),
              detailRow('Accuracy', budget.accuracy ?? 'estimated', 'accuracy'),
            ]),
          ]),
          h('section', { className: 'xhctx-panel', key: 'route' }, [
            h('div', { className: 'xhctx-panel-head', key: 'head' }, h('h3', null, 'Runtime Route')),
            h('dl', { className: 'xhctx-detail-grid', key: 'details' }, [
              detailRow('Provider', view.config.provider ?? 'unknown', 'provider'),
              detailRow('Model', view.config.model ?? 'unknown', 'model'),
              detailRow('Reasoning Effort', reasoningEffort, 'reasoning'),
              detailRow('Sequence', String(selected.seq), 'sequence'),
              detailRow('Assembly ID', prompt.assemblyId ?? prompt.assembly_id, 'assembly'),
              detailRow('Tool Definitions SHA-256', view.options.toolDefinitionsSha256 ?? view.options.tool_definitions_sha256, 'tools-hash'),
            ]),
          ]),
        ]),
      ])
    }

    const FILTERS = Object.freeze([
      { id: 'system', label: 'System', color: '#596174' },
      { id: 'user', label: '人', color: '#1768d5' },
      { id: 'reasoning', label: '思考', color: '#c06a00' },
      { id: 'assistant', label: '回答', color: '#16804a' },
      { id: 'tool-call', label: '调用', color: '#7751d6' },
      { id: 'tool-result', label: '结果', color: '#00839a' },
      { id: 'compaction', label: '压缩', color: '#b42584' },
      { id: 'error', label: '错误', color: '#c93b3b' },
    ])

    function requestKindCounts(request) {
      const counts = Object.fromEntries(FILTERS.map(filter => [filter.id, 0]))
      if (request === undefined) return counts
      for (const message of normalizedRequest(request).messages) {
        const role = message?.role ?? 'unknown'
        const content = typeof message?.content === 'string'
          ? message.content
          : JSON.stringify(message?.content ?? '')
        const reasoning = typeof message?.reasoning === 'string' ? message.reasoning : ''
        const toolCalls = asArray(message?.tool_calls ?? message?.toolCalls)
        const providerItems = asArray(message?.provider_items ?? message?.providerItems)
        if (role === 'assistant') {
          if (reasoning.length > 0) counts.reasoning += 1
          if (content.length > 0 || (reasoning.length === 0 && toolCalls.length === 0 && providerItems.length === 0)) {
            counts.assistant += 1
          }
          counts['tool-call'] += toolCalls.length
        } else if (role === 'tool') {
          counts['tool-result'] += 1
        } else if (role === 'system') {
          counts.system += 1
        } else if (compactId(message) !== undefined) {
          counts.compaction += 1
        } else if (role === 'user') {
          counts.user += 1
        } else if (role === 'error' || message?.error !== undefined) {
          counts.error += 1
        }
      }
      return counts
    }

    function FilterBar({ requests, hiddenKinds, onToggle, onReset }) {
      const counts = requests.reduce((total, request) => {
        const next = requestKindCounts(request)
        for (const filter of FILTERS) total[filter.id] += next[filter.id]
        return total
      }, Object.fromEntries(FILTERS.map(filter => [filter.id, 0])))
      const available = FILTERS.filter(filter => counts[filter.id] > 0)
      const allVisible = available.every(filter => !hiddenKinds.has(filter.id))
      const total = available.reduce((sum, filter) => sum + counts[filter.id], 0)
      return h('div', { className: 'xhctx-filterbar', role: 'toolbar', 'aria-label': '上下文内容筛选' }, [
        h('span', { className: 'xhctx-filter-label', key: 'label' }, '内容筛选'),
        h('button', {
          type: 'button',
          className: `xhctx-filter xhctx-filter-all${allVisible ? ' xhctx-filter-active' : ''}`,
          'aria-pressed': allVisible,
          title: '显示全部上下文内容',
          onClick: onReset,
          key: 'all',
        }, [h('span', { key: 'text' }, '全部'), h('span', { className: 'xhctx-filter-count', key: 'count' }, total)]),
        ...available.map(filter => {
          const active = !hiddenKinds.has(filter.id)
          return h('button', {
            type: 'button',
            className: `xhctx-filter${active ? ' xhctx-filter-active' : ''}`,
            style: { '--xhctx-filter': filter.color },
            'aria-pressed': active,
            title: active ? `隐藏「${filter.label}」` : `显示「${filter.label}」`,
            onClick: () => onToggle(filter.id),
            key: filter.id,
          }, [
            h('span', { className: 'xhctx-filter-dot', 'aria-hidden': true, key: 'dot' }),
            h('span', { key: 'text' }, filter.label),
            h('span', { className: 'xhctx-filter-count', key: 'count' }, counts[filter.id]),
          ])
        }),
      ])
    }

    function CompactionBanner({ compaction, after }) {
      if (compaction === undefined) return null
      const beforeTokens = numberOrUndefined(compaction.shadowedTokenCount ?? compaction.shadowed_token_count)
      const afterBudget = after === undefined ? {} : tokenBudget(normalizedRequest(after))
      const summary = typeof compaction.summary === 'string' ? compaction.summary : ''
      return h('details', { className: 'xhctx-compaction-banner', open: true }, [
        h('summary', { key: 'summary' }, [
          h('strong', { key: 'title' }, `压缩 ${compaction.compactionId ?? compaction.compaction_id ?? ''}`),
          h('span', { key: 'tokens' }, `${fmtTokens(beforeTokens)} shadowed → ${fmtTokens(afterBudget.used)} request tokens`),
        ]),
        h('pre', { key: 'body' }, summary || '压缩摘要未记录。'),
      ])
    }

    function ContextView({ useSession }) {
      const snapshot = useSession(state => state.views.get(TARGET) ?? EMPTY)
      const [selectedSeq, setSelectedSeq] = useState(null)
      const [mode, setMode] = useState('actual')
      const [query, setQuery] = useState('')
      const [hiddenKinds, setHiddenKinds] = useState(() => new Set())
      const requests = snapshot.requests
      const latest = requests.at(-1)
      const selected = requests.find(request => request.seq === selectedSeq) ?? latest

      useEffect(() => {
        if (selectedSeq !== null && !requests.some(request => request.seq === selectedSeq)) {
          setSelectedSeq(null)
        }
      }, [requests, selectedSeq])

      const relation = useMemo(() => {
        if (selected === undefined) return {}
        const compaction = snapshot.compactions
          .filter(item => item.seq < selected.seq)
          .at(-1)
        if (compaction === undefined) return {}
        return {
          compaction,
          before: requests.filter(request => request.seq < compaction.seq).at(-1),
          after: requests.find(request => request.seq > compaction.seq),
        }
      }, [requests, selected, snapshot.compactions])

      const selectedView = selected === undefined ? undefined : normalizedRequest(selected)
      const filtered = (request) => {
        if (request === undefined || query.trim() === '') return request
        const normalized = normalizedRequest(request)
        const needle = query.trim().toLocaleLowerCase()
        const messages = normalized.messages.filter(message =>
          JSON.stringify(message).toLocaleLowerCase().includes(needle))
        return { ...request, header: { ...normalized.header, input: messages } }
      }
      const actual = filtered(selected)
      const before = filtered(relation.before)
      const after = filtered(relation.after ?? selected)
      const filterRequests = mode === 'diff'
        ? [before, after].filter(request => request !== undefined)
        : [mode === 'before' ? before : mode === 'after' ? after : actual].filter(request => request !== undefined)
      const toggleKind = kind => setHiddenKinds(current => {
        const next = new Set(current)
        if (next.has(kind)) next.delete(kind)
        else next.add(kind)
        return next
      })

      let body
      if (mode === 'diff') {
        body = h('div', { className: 'xhctx-diff' }, [
          h(ContextRequestView, { request: before, heading: '压缩前', dimmed: true, hiddenKinds, key: 'before' }),
          h(ContextRequestView, { request: after, heading: '压缩后', hiddenKinds, key: 'after' }),
        ])
      } else {
        body = h(ContextRequestView, {
          request: mode === 'before' ? before : mode === 'after' ? after : actual,
          heading: mode === 'before' ? '压缩前' : mode === 'after' ? '压缩后' : '模型实际收到',
          hiddenKinds,
        })
      }

      return h('div', { className: 'xhctx-root', 'data-conversation-composer-overlay': '' }, [
        h('div', { className: 'xhctx-toolbar', key: 'toolbar' }, [
          h('select', {
            className: 'xhctx-select',
            value: selected?.seq ?? '',
            onChange: event => setSelectedSeq(Number(event.target.value)),
            'aria-label': '选择模型请求',
            key: 'select',
          }, requests.map((request, index) =>
            h('option', { value: request.seq, key: request.seq }, requestLabel(request, index)))),
          h('div', { className: 'xhctx-modes', role: 'group', 'aria-label': '上下文视图', key: 'modes' }, [
            ['actual', '实际发送'],
            ['before', '压缩前'],
            ['after', '压缩后'],
            ['diff', 'Diff'],
          ].map(([id, label]) => h('button', {
            type: 'button',
            className: mode === id ? 'xhctx-mode xhctx-mode-active' : 'xhctx-mode',
            disabled: id !== 'actual' && relation.compaction === undefined,
            onClick: () => setMode(id),
            key: id,
          }, label))),
          h('input', {
            className: 'xhctx-search',
            value: query,
            onChange: event => setQuery(event.target.value),
            placeholder: '搜索上下文',
            'aria-label': '搜索上下文',
            key: 'search',
          }),
        ]),
        h(FilterBar, {
          requests: filterRequests,
          hiddenKinds,
          onToggle: toggleKind,
          onReset: () => setHiddenKinds(new Set()),
          key: 'filters',
        }),
        hiddenKinds.has('compaction') ? null : h(CompactionBanner, { compaction: relation.compaction, after: relation.after ?? selected, key: 'compaction' }),
        h('div', { className: 'xhctx-body', key: 'body' }, body),
      ])
    }

    // Match upstream Trajectory: the overlay marker bounds the shared host;
    // only this view scrolls. Never reset Chat scroll state on stream updates.
    // Grid rows must keep their intrinsic height rather than clip their panels.
    const CSS = `
.xhctx-root{flex:1;min-height:0;min-width:0;overflow:auto;background:#f8fafc;color:#172033;padding:14px 18px calc(var(--dsh-composer-height,150px) + 24px);box-sizing:border-box}
.xhctx-toolbar{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px;border:1px solid #dbe3ef;border-radius:12px;background:rgba(255,255,255,.94);backdrop-filter:blur(12px);box-shadow:0 8px 24px rgba(35,50,80,.07)}
.xhctx-select,.xhctx-search{height:34px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172033;padding:0 10px;font:inherit}.xhctx-select{min-width:190px}.xhctx-search{min-width:150px;flex:1}
.xhctx-modes{display:flex;padding:3px;background:#eef2f7;border-radius:9px}.xhctx-mode{border:0;background:transparent;border-radius:7px;padding:6px 10px;color:#657086;cursor:pointer}.xhctx-mode:hover:not(:disabled){color:#172033}.xhctx-mode-active{background:#fff;color:#145cff;box-shadow:0 1px 4px rgba(30,50,80,.13)}.xhctx-mode:disabled{opacity:.35;cursor:not-allowed}
.xhctx-filterbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0 8px;padding:8px 10px;border:1px solid #e1e6ee;border-radius:11px;background:#fff;box-shadow:0 2px 8px rgba(30,45,70,.035)}
.xhctx-filter-label{margin-right:2px;font-size:11px;font-weight:700;color:#7a8495}.xhctx-filter{--xhctx-filter:#657086;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:1px solid #d8dee8;border-radius:8px;background:#f7f8fa;color:#8a93a3;font:600 11px/1 inherit;cursor:pointer;transition:background .15s,border-color .15s,color .15s,box-shadow .15s}.xhctx-filter:hover{border-color:color-mix(in srgb,var(--xhctx-filter) 50%,#d8dee8);color:var(--xhctx-filter)}.xhctx-filter:focus-visible{outline:2px solid #8bb0ff;outline-offset:2px}.xhctx-filter-active{border-color:color-mix(in srgb,var(--xhctx-filter) 34%,#d8dee8);background:color-mix(in srgb,var(--xhctx-filter) 9%,#fff);color:var(--xhctx-filter);box-shadow:0 1px 2px rgba(30,45,70,.05)}.xhctx-filter-all{--xhctx-filter:#335fdb}.xhctx-filter-dot{width:7px;height:7px;border-radius:50%;background:var(--xhctx-filter);opacity:.35}.xhctx-filter-active .xhctx-filter-dot{opacity:1;box-shadow:0 0 0 2px color-mix(in srgb,var(--xhctx-filter) 14%,transparent)}.xhctx-filter-count{min-width:14px;padding:1px 4px;border-radius:999px;background:rgba(100,116,139,.1);font-size:9px;text-align:center;color:inherit}.xhctx-filter-all .xhctx-filter-count{margin-left:1px}
.xhctx-compaction-banner{margin:7px 0 12px;border:1px solid #ecb6dc;border-radius:10px;background:#fff0fa;overflow:hidden}.xhctx-compaction-banner summary{display:flex;gap:16px;justify-content:space-between;cursor:pointer;padding:10px 12px;color:#8b1b66}.xhctx-compaction-banner pre{margin:0;padding:10px 12px;border-top:1px solid #f2cce6;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:240px;overflow:auto}
.xhctx-request{min-width:0}.xhctx-column-title{font-size:14px;margin:8px 2px;color:#3e4a60}.xhctx-request-details{margin:0 0 9px;border-bottom:1px solid #e3e8ef}.xhctx-request-details>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 2px 8px;color:#68758c;font-size:11px;cursor:pointer;list-style:none}.xhctx-request-details>summary::-webkit-details-marker{display:none}.xhctx-request-details>summary:after{content:'›';margin-left:auto;color:#98a2b3;font-size:18px;line-height:1;transition:transform .15s}.xhctx-request-details[open]>summary:after{transform:rotate(90deg)}.xhctx-request-count{margin-left:4px;color:#8a94a6}.xhctx-request-details .xhctx-detail-grid{margin:0 0 10px}
.xhctx-detail-grid{display:grid;grid-template-columns:minmax(110px,.42fr) minmax(0,1fr);gap:0;margin:0}.xhctx-detail-row{display:contents}.xhctx-detail-row dt,.xhctx-detail-row dd{margin:0;padding:7px 9px;border-top:1px solid #edf0f4;font-size:11px;line-height:1.4}.xhctx-detail-row dt{color:#7b8596}.xhctx-detail-row dd{color:#283448;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.xhctx-cards{display:grid;gap:8px}.xhctx-card{--xhctx:#667085;--xhctx-bg:#fff;margin:0;border:1px solid color-mix(in srgb,var(--xhctx) 32%,#fff);border-left:5px solid var(--xhctx);border-radius:10px;background:var(--xhctx-bg);overflow:hidden;box-shadow:0 2px 8px rgba(30,45,70,.04)}
.xhctx-system{--xhctx:#596174;--xhctx-bg:#f2f4f7}.xhctx-user{--xhctx:#1768d5;--xhctx-bg:#eef5ff}.xhctx-reasoning{--xhctx:#c06a00;--xhctx-bg:#fff7e8}.xhctx-assistant{--xhctx:#16804a;--xhctx-bg:#effaf4}.xhctx-tool-call{--xhctx:#7751d6;--xhctx-bg:#f6f2ff}.xhctx-tool-result{--xhctx:#00839a;--xhctx-bg:#edfafd}.xhctx-provider{--xhctx:#667085;--xhctx-bg:#f6f7f9}.xhctx-compaction{--xhctx:#b42584;--xhctx-bg:#fff0fa}.xhctx-error{--xhctx:#c93b3b;--xhctx-bg:#fff1f1}.xhctx-tool-schema{--xhctx:#7751d6;--xhctx-bg:#fff}
.xhctx-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--xhctx) 16%,transparent)}.xhctx-kind{font-size:11px;font-weight:800;letter-spacing:.04em;color:var(--xhctx)}.xhctx-card-meta{font-size:10px;color:#798397;text-align:right}.xhctx-content{margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:420px;overflow:auto}.xhctx-raw{border-top:1px dashed color-mix(in srgb,var(--xhctx) 20%,transparent);padding:6px 10px}.xhctx-raw summary{font-size:10px;color:#7a8495;cursor:pointer}.xhctx-raw pre{white-space:pre-wrap;word-break:break-all;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:300px;overflow:auto}
.xhctx-harness-root{display:grid;grid-auto-rows:max-content;align-content:start;gap:10px}.xhctx-harness-toolbar{flex-wrap:nowrap}.xhctx-harness-hint{margin-left:auto;color:#7a8495;font-size:11px}.xhctx-panel{min-width:0;border:1px solid #e0e6ee;border-radius:12px;background:#fff;overflow:hidden;box-shadow:0 2px 9px rgba(30,45,70,.035)}.xhctx-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid #edf0f4}.xhctx-panel-head h3{margin:0;color:#273348;font-size:13px}.xhctx-panel-head span{color:#7b8596;font-size:10px}.xhctx-pipeline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;padding:13px}.xhctx-pipeline-step{position:relative;display:flex;align-items:center;gap:9px;min-width:0;padding-right:18px}.xhctx-pipeline-step:not(:last-child):after{content:'›';position:absolute;right:7px;color:#a8b0bd}.xhctx-pipeline-index{display:grid;place-items:center;flex:0 0 auto;width:21px;height:21px;border:1px solid #cbd5e1;border-radius:50%;color:#536174;font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.xhctx-pipeline-step strong,.xhctx-pipeline-step small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhctx-pipeline-step strong{color:#344054;font-size:11px}.xhctx-pipeline-step small{margin-top:2px;color:#8993a3;font-size:9px}.xhctx-section-list{display:grid;gap:0}.xhctx-assembly-section{border-bottom:1px solid #edf0f4}.xhctx-assembly-section>summary{display:grid;grid-template-columns:34px minmax(0,1fr) minmax(100px,.8fr);align-items:center;gap:8px;padding:9px 13px;cursor:pointer;list-style:none}.xhctx-assembly-section>summary::-webkit-details-marker{display:none}.xhctx-assembly-section>summary strong{font-size:11px;color:#344054}.xhctx-assembly-section>summary span:last-child{overflow:hidden;color:#8590a2;font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.xhctx-section-index{color:#4973d5!important;font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace!important}.xhctx-assembly-section .xhctx-detail-grid{margin:0 13px 9px}.xhctx-injected-prompt{margin:12px;border:1px solid #dce3ec;border-radius:9px;background:#f8fafc;overflow:hidden}.xhctx-injected-prompt>summary{display:flex;justify-content:space-between;gap:12px;padding:9px 11px;cursor:pointer;color:#38455a;font-size:11px}.xhctx-injected-prompt>summary span{color:#8993a3;font-size:9px}.xhctx-injected-prompt pre{max-height:360px;overflow:auto;margin:0;padding:11px;border-top:1px solid #e3e8ef;white-space:pre-wrap;word-break:break-word;color:#263248;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.xhctx-tool-head>div:first-child{display:flex;align-items:baseline;gap:8px}.xhctx-tool-search{width:190px;height:29px;box-sizing:border-box;border:1px solid #d5dce7;border-radius:7px;background:#fff;padding:0 9px;color:#273348;font:inherit;font-size:11px}.xhctx-registry{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:10px}.xhctx-registry-tool{min-width:0;border:1px solid #e1e6ee;border-radius:9px;background:#fafbfc;overflow:hidden}.xhctx-registry-tool>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;cursor:pointer;list-style:none}.xhctx-registry-tool>summary::-webkit-details-marker{display:none}.xhctx-registry-tool>summary code{overflow:hidden;color:#3e4d64;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.xhctx-registry-tool>summary span{flex:0 0 auto;color:#8a94a6;font-size:9px}.xhctx-registry-tool p{margin:0;padding:0 10px 9px;color:#596579;font-size:10px;line-height:1.55}.xhctx-registry-tool h4{margin:0;padding:8px 10px;border-top:1px solid #e6eaf0;color:#7a8495;font-size:9px;text-transform:uppercase}.xhctx-registry-tool pre{max-height:280px;overflow:auto;margin:0;padding:0 10px 10px;white-space:pre-wrap;word-break:break-word;color:#344054;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.xhctx-harness-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px}.xhctx-harness-columns .xhctx-detail-grid{padding:0 4px 5px}
.xhctx-diff{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.xhctx-dimmed{opacity:.72}.xhctx-empty{padding:30px;text-align:center;border:1px dashed #cbd5e1;border-radius:12px;color:#778196;background:#fff}
@media(max-width:760px){.xhctx-root{padding:10px 10px calc(var(--dsh-composer-height,150px) + 24px)}.xhctx-toolbar{align-items:stretch}.xhctx-select,.xhctx-search{width:100%}.xhctx-diff,.xhctx-harness-columns{grid-template-columns:1fr}.xhctx-harness-toolbar{flex-wrap:wrap}.xhctx-harness-hint{width:100%;margin:0}.xhctx-pipeline{grid-template-columns:1fr 1fr;gap:10px}.xhctx-pipeline-step:after{display:none}.xhctx-registry{grid-template-columns:1fr}.xhctx-tool-head{align-items:stretch;flex-direction:column}.xhctx-tool-search{width:100%}}
@media(prefers-color-scheme:dark){.xhctx-root{background:#0f131b;color:#e7ebf2}.xhctx-toolbar{background:rgba(24,29,39,.94);border-color:#31394a}.xhctx-select,.xhctx-search,.xhctx-tool-search{background:#171c26;border-color:#3a4355;color:#e7ebf2}.xhctx-modes{background:#252c39}.xhctx-mode{color:#aeb7c8}.xhctx-mode-active{background:#343d4d;color:#76a2ff}.xhctx-filterbar,.xhctx-panel{background:#171c26;border-color:#31394a;box-shadow:none}.xhctx-filter{background:#202631;border-color:#3a4355;color:#8993a5}.xhctx-filter-active{background:color-mix(in srgb,var(--xhctx-filter) 16%,#171c26);border-color:color-mix(in srgb,var(--xhctx-filter) 45%,#3a4355);color:color-mix(in srgb,var(--xhctx-filter) 72%,#fff)}.xhctx-request-details,.xhctx-panel-head,.xhctx-assembly-section,.xhctx-detail-row dt,.xhctx-detail-row dd{border-color:#2c3442}.xhctx-detail-row dd,.xhctx-panel-head h3,.xhctx-pipeline-step strong,.xhctx-assembly-section>summary strong{color:#d7dde7}.xhctx-card{box-shadow:none}.xhctx-system{--xhctx-bg:#202631}.xhctx-user{--xhctx-bg:#14243b}.xhctx-reasoning{--xhctx-bg:#332718}.xhctx-assistant{--xhctx-bg:#142b21}.xhctx-tool-call{--xhctx-bg:#241d38}.xhctx-tool-result{--xhctx-bg:#122a30}.xhctx-provider{--xhctx-bg:#202631}.xhctx-compaction{--xhctx-bg:#351c30}.xhctx-error{--xhctx-bg:#351c22}.xhctx-injected-prompt,.xhctx-registry-tool{background:#202631;border-color:#353e4d}.xhctx-injected-prompt pre,.xhctx-registry-tool pre,.xhctx-registry-tool>summary code{color:#d6dde8}.xhctx-injected-prompt pre,.xhctx-registry-tool h4{border-color:#303847}.xhctx-empty{background:#171c26;border-color:#3a4355}}
`

    const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions']

    function apply(ctx) {
      ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'xharness-context: styles')
      ctx.conversationEvents.register(requestDefinition)
      ctx.conversationEvents.register(compactionDefinition)
      ctx.conversationViews.register(viewDefinition)
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'context',
        order: 20,
        label: () => 'Context',
      }, ContextView))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'harness',
        order: 30,
        label: () => 'Harness',
      }, HarnessView))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
