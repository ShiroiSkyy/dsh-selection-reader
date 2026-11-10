/**
 * 划词解读 · Client 半边
 *
 * 界面组成：
 *  - 划词浮层旁：官方「引用文本」浮层出现时，在它右侧并排画一个「解读」按钮，
 *    点「解读」立即高亮选中的文字，并在旁边弹出解读窗口；不改动官方浮层本身。
 *  - 原文高亮用 CSS Custom Highlight API 画，不往 React 管理的 DOM 里插节点；
 *    点击/右键高亮在捕获阶段命中，右键菜单提供「删除解读」（同时删除历史记录）。
 *  - sidebar.panellist + main：插件页，包含「解读历史」和「插件设置」两个标签。
 *  - shell.overlay：解读窗口、右键菜单、轻提示。
 *  - conversation.input.dock：只用来跟踪当前会话 id，本身不渲染。
 *
 * 历史记录按「对话 + 轮次」唯一：同一轮次只保留最新一条；同样的文本再次解读直接读缓存。
 * 所有可调项都在插件设置页里，保存在浏览器 localStorage。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-selection-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'selectionReader'
    const PANEL_ID = 'selection-reader'
    const API = '/selection-reader/api'
    const HISTORY_KEY = 'selection-reader:history:v1'
    const SETTINGS_KEY = 'selection-reader:settings:v1'
    const MAX_CONTEXT = 12000

    const DEFAULT_PROMPT = [
      '你是「划词解读」助手。用户会在对话中划中一段文字，请你只解释这段文字在当前这轮对话语境里的意思。',
      '',
      '要求：',
      '1. 先判断这段文字在本轮对话中的具体含义、指代和用途，不要泛泛给出百科定义。',
      '2. 如果它是术语、缩写或专业名词，先给出它在这个语境里的所指，再补一句必要的背景。',
      '3. 输出分三段，用小标题「此处含义」「依据」「补充」；没有依据或补充时省略对应段。',
      '4. 全程用简体中文，控制在 300 字以内，不要重复原文，不要输出 Markdown 代码块。',
      '5. 如果仅凭本轮对话无法确定含义，就直接说明不确定，并给出最可能的解释。',
    ].join('\n')

    /* @region SELECTION_READER_STORE */
    // ---------- 纯逻辑：去重、覆盖、上限、搜索（不依赖浏览器，测试直接抽取本区） ----------

    function recordKey(record) {
      const sessionId = record && record.sessionId ? String(record.sessionId) : ''
      const turn = record ? record.turn : null
      if (typeof turn === 'number' && Number.isFinite(turn)) return sessionId + '\u0000turn:' + String(turn)
      return sessionId + '\u0000node:' + String((record && record.nodeKey) || '')
    }

    function normalizeSettings(raw) {
      const input = raw && typeof raw === 'object' ? raw : {}
      const maxChars = Number(input.maxChars)
      const historyLimit = Number(input.historyLimit)
      return {
        prompt: typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : DEFAULT_PROMPT,
        modelMode: input.modelMode === 'fixed' ? 'fixed' : input.modelMode === 'custom' ? 'custom' : 'current',
        provider: typeof input.provider === 'string' ? input.provider : '',
        model: typeof input.model === 'string' ? input.model : '',
        customBaseUrl: typeof input.customBaseUrl === 'string' ? input.customBaseUrl : '',
        customApiKey: typeof input.customApiKey === 'string' ? input.customApiKey : '',
        customModel: typeof input.customModel === 'string' ? input.customModel : '',
        maxChars: Number.isFinite(maxChars) ? Math.max(50, Math.min(4000, Math.round(maxChars))) : 500,
        entryEnabled: input.entryEnabled !== false,
        highlightStyle: input.highlightStyle === 'underline' ? 'underline' : 'fill',
        highlightColor:
          input.highlightColor === 'amber' || input.highlightColor === 'blue' ? input.highlightColor : 'theme',
        historyLimit: Number.isFinite(historyLimit) ? Math.max(20, Math.min(1000, Math.round(historyLimit))) : 200,
      }
    }

    function normalizeHistory(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        if (typeof item.sessionId !== 'string' || !item.sessionId) continue
        if (typeof item.text !== 'string' || !item.text) continue
        if (typeof item.result !== 'string' || !item.result) continue
        const createdAt = Number(item.createdAt)
        const updatedAt = Number(item.updatedAt)
        out.push({
          id: typeof item.id === 'string' && item.id ? item.id : 'r-' + String(out.length),
          text: item.text,
          result: item.result,
          model: typeof item.model === 'string' ? item.model : '',
          sessionId: item.sessionId,
          sessionTitle: typeof item.sessionTitle === 'string' ? item.sessionTitle : '',
          nodeKey: typeof item.nodeKey === 'string' ? item.nodeKey : '',
          turn: typeof item.turn === 'number' && Number.isFinite(item.turn) ? item.turn : null,
          start: Number.isFinite(Number(item.start)) ? Math.max(0, Number(item.start)) : 0,
          end: Number.isFinite(Number(item.end)) ? Math.max(0, Number(item.end)) : 0,
          createdAt: Number.isFinite(createdAt) ? createdAt : 0,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : Number.isFinite(createdAt) ? createdAt : 0,
        })
      }
      out.sort((left, right) => right.updatedAt - left.updatedAt)
      return out
    }

    function findCachedInterpretation(records, sessionId, turn, nodeKey, text) {
      const key = recordKey({ sessionId: sessionId, turn: turn, nodeKey: nodeKey })
      for (const record of records || []) {
        if (recordKey(record) === key && record.text === text) return record
      }
      return null
    }

    function upsertInterpretation(records, record, limit) {
      const key = recordKey(record)
      const next = []
      for (const item of records || []) if (recordKey(item) !== key) next.push(item)
      next.push(record)
      next.sort((left, right) => right.updatedAt - left.updatedAt)
      const cap = Math.max(1, Math.min(1000, Number(limit) || 200))
      return next.slice(0, cap)
    }

    function removeInterpretation(records, id) {
      return (records || []).filter((record) => record.id !== id)
    }

    function searchInterpretations(records, query) {
      const text = String(query || '').trim().toLowerCase()
      if (!text) return records || []
      return (records || []).filter((record) => {
        const title = String(record.sessionTitle || '').toLowerCase()
        return String(record.text || '').toLowerCase().indexOf(text) !== -1 || title.indexOf(text) !== -1
      })
    }

    function hitRecord(records, sessionId, nodeKey, offset) {
      for (const record of records || []) {
        if (record.sessionId !== sessionId) continue
        if (record.nodeKey !== nodeKey) continue
        if (offset >= record.start && offset < record.end) return record
      }
      return null
    }

    const SECTION_LABELS = {
      此处含义: '此处含义',
      含义: '此处含义',
      解释: '此处含义',
      依据: '依据',
      出处: '依据',
      原文: '依据',
      补充: '补充',
      备注: '补充',
      背景: '补充',
      注意: '补充',
    }

    /** 把模型输出切成带小标题的段落；识别「此处含义 / 依据 / 补充」的多种写法。 */
    function parseInterpretation(raw) {
      const text = String(raw || '')
        .replace(/\r\n?/g, '\n')
        .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
        .trim()
      if (!text) return []
      const headerOnly =
        /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*[【「\[]?\s*(此处含义|含义|解释|依据|出处|原文|补充|备注|背景|注意)\s*[】」\]]?\s*(?:\*\*)?\s*[:：]?\s*$/
      const headerInline =
        /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*[【「\[]?\s*(此处含义|含义|解释|依据|出处|原文|补充|备注|背景|注意)\s*[】」\]]?\s*(?:\*\*)?\s*[:：]\s*(.+)$/
      const sections = []
      let current = null
      function flush() {
        if (!current) return
        const body = current.lines.join('\n').trim()
        if (body) sections.push({ label: current.label, body: body })
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) {
          if (current) current.lines.push('')
          continue
        }
        const inline = trimmed.match(headerInline)
        if (inline) {
          flush()
          current = { label: SECTION_LABELS[inline[1]] || inline[1], lines: [inline[2].trim()] }
          continue
        }
        const header = trimmed.match(headerOnly)
        if (header) {
          flush()
          current = { label: SECTION_LABELS[header[1]] || header[1], lines: [] }
          continue
        }
        if (!current) current = { label: '', lines: [] }
        current.lines.push(line)
      }
      flush()
      if (sections.length) return sections
      return [{ label: '', body: text }]
    }

    /** 把段落正文按选中词切成可高亮片段。 */
    function splitTermText(body, term) {
      const text = String(body || '')
      const needle = String(term || '').trim()
      if (!needle || needle.length < 2) return [{ text: text, hit: false }]
      const parts = []
      let index = 0
      while (index < text.length) {
        const found = text.indexOf(needle, index)
        if (found === -1) {
          parts.push({ text: text.slice(index), hit: false })
          break
        }
        if (found > index) parts.push({ text: text.slice(index, found), hit: false })
        parts.push({ text: needle, hit: true })
        index = found + needle.length
      }
      return parts.length ? parts : [{ text: text, hit: false }]
    }
    /* @endregion */

    // ---------- 本地存储与订阅 ----------

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return parsed === null || parsed === undefined ? fallback : parsed
      } catch {
        return fallback
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* 本地存储不可用时只保留在内存里 */
      }
    }

    function createStore(initial, persistKey) {
      let value = initial
      const listeners = new Set()
      return {
        get() {
          return value
        },
        set(next) {
          value = next
          if (persistKey) writeJson(persistKey, value)
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* 单个订阅方异常不影响其他订阅 */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    function useSnapshot(store) {
      const forceUpdate = React.useReducer((value) => (value + 1) | 0, 0)[1]
      React.useEffect(() => {
        return store.subscribe(forceUpdate)
      }, [store])
      return store.get()
    }

    const settingsStore = createStore(normalizeSettings(readJson(SETTINGS_KEY, null)), SETTINGS_KEY)
    const historyStore = createStore(normalizeHistory(readJson(HISTORY_KEY, [])), HISTORY_KEY)
    const uiStore = createStore({ popup: null, menu: null, toast: null })

    const pendingMap = new Map()
    let toastTimer = null
    let pluginCtx = null
    let currentSessionId = null
    let currentSessionTitle = ''
    let lastSelectionInfo = null
    let quickActionAt = 0
    let syncTimer = null

    function showToast(text) {
      if (!text) return
      if (toastTimer) clearTimeout(toastTimer)
      uiStore.set({ ...uiStore.get(), toast: { text: text, id: Date.now() } })
      toastTimer = setTimeout(() => {
        toastTimer = null
        const current = uiStore.get()
        if (current.toast) uiStore.set({ ...current, toast: null })
      }, 2600)
    }

    function openPopup(popup) {
      const current = uiStore.get()
      uiStore.set({ ...current, popup: popup })
    }

    function updatePopup(patch) {
      const current = uiStore.get()
      if (!current.popup) return
      uiStore.set({ ...current, popup: { ...current.popup, ...patch } })
    }

    function closePopup() {
      const current = uiStore.get()
      uiStore.set({ ...current, popup: null })
    }

    /** 只更新仍属于这次请求的窗口，避免并发解读时旧结果覆盖新窗口。 */
    function updatePopupIfCurrent(pendingId, patch) {
      const current = uiStore.get()
      const popup = current.popup
      if (!popup) return
      if (popup.pendingId !== pendingId && popup.id !== pendingId) return
      updatePopup(patch)
    }

    function setCurrentSession(sessionId, sessionTitle) {
      const next = sessionId || null
      const nextTitle = sessionTitle || ''
      if (currentSessionId === next && currentSessionTitle === nextTitle) return
      currentSessionId = next
      currentSessionTitle = nextTitle
      lastApply = { signature: '', at: 0, incomplete: false }
      scheduleHighlightSync()
    }

    // ---------- 选中文字与 DOM 锚点 ----------

    function closestSource(node) {
      if (!node) return null
      const element = node.nodeType === 3 ? node.parentElement : node
      return element && typeof element.closest === 'function' ? element.closest('[data-text-interaction-source]') : null
    }

    function textNodesOf(root) {
      const nodes = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        nodes.push(node)
        node = walker.nextNode()
      }
      return nodes
    }

    /** 把 (node, offset) 换算成来源容器内的纯文本偏移。 */
    function offsetIn(root, node, offset) {
      try {
        const range = document.createRange()
        range.setStart(root, 0)
        range.setEnd(node, offset)
        return range.toString().length
      } catch {
        return null
      }
    }

    /** 把纯文本偏移换回 DOM Range。 */
    function rangeFromOffsets(root, start, end) {
      if (!(start >= 0) || !(end > start)) return null
      const nodes = textNodesOf(root)
      let position = 0
      let startPoint = null
      let endPoint = null
      for (const node of nodes) {
        const length = node.data.length
        if (startPoint === null && start <= position + length) startPoint = [node, Math.max(0, start - position)]
        if (startPoint !== null && end <= position + length) {
          endPoint = [node, Math.max(0, end - position)]
          break
        }
        position += length
      }
      if (startPoint === null || endPoint === null) return null
      try {
        const range = document.createRange()
        range.setStart(startPoint[0], startPoint[1])
        range.setEnd(endPoint[0], endPoint[1])
        return range
      } catch {
        return null
      }
    }

    function nodeElementOf(source) {
      const element = source && typeof source.closest === 'function' ? source.closest('[data-chat-node-key]') : null
      return element
    }

    function captureSelection(sessionId) {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const source = closestSource(range.startContainer)
      if (!source || source !== closestSource(range.endContainer)) return null
      const start = offsetIn(source, range.startContainer, range.startOffset)
      const end = offsetIn(source, range.endContainer, range.endOffset)
      if (start === null || end === null || end <= start) return null
      const raw = source.textContent.slice(start, end)
      const text = raw.trim()
      if (!text) return null
      const lead = raw.length - raw.trimStart().length
      const trail = raw.length - raw.trimEnd().length
      const nodeRow = nodeElementOf(source)
      const turnRow = source.closest('[data-chat-turn]')
      const turnValue = turnRow ? Number(turnRow.getAttribute('data-chat-turn')) : NaN
      const rect = range.getBoundingClientRect()
      return {
        sessionId: sessionId,
        text: text,
        start: start + lead,
        end: end - trail,
        nodeKey: nodeRow ? nodeRow.getAttribute('data-chat-node-key') || '' : '',
        turn: Number.isFinite(turnValue) ? turnValue : null,
        source: source,
        rect: rect,
      }
    }

    /** 把选中文字所在这一轮的对话文本收成上下文。 */
    function turnContextOf(source) {
      const turnRow = source && typeof source.closest === 'function' ? source.closest('[data-chat-turn]') : null
      if (!turnRow) return ''
      const turn = turnRow.getAttribute('data-chat-turn')
      const flow = turnRow.closest('[data-chat-flow]') || document
      let targets = []
      try {
        targets = Array.from(flow.querySelectorAll('[data-chat-turn="' + turn + '"] [data-text-interaction-source]'))
      } catch {
        targets = []
      }
      const chunks = []
      const seen = new Set()
      for (const element of targets) {
        if (seen.has(element)) continue
        seen.add(element)
        const text = String(element.textContent || '').trim()
        if (!text) continue
        const kindRow = element.closest('[data-chat-flow-kind]')
        const kind = kindRow ? kindRow.getAttribute('data-chat-flow-kind') : ''
        chunks.push((kind === 'user' ? '用户' : '助手') + '：' + text)
      }
      return chunks.join('\n\n').slice(0, MAX_CONTEXT)
    }

    // ---------- 高亮：用 DOM mark 包裹（可见、可点击、可右键） ----------

    let lastMarkStats = { records: 0, marks: 0, at: 0 }
    let lastApply = { signature: '', at: 0, incomplete: false }

    function markStyleToken() {
      const settings = settingsStore.get()
      return settings.highlightStyle + ':' + settings.highlightColor
    }

    function scheduleHighlightSync() {
      if (syncTimer) return
      syncTimer = setTimeout(() => {
        syncTimer = null
        applyMarks()
      }, 120)
    }

    function renderedRecords() {
      const pendings = []
      const pendingKeys = new Set()
      for (const pending of pendingMap.values()) {
        if (pending.sessionId !== currentSessionId) continue
        pendings.push(pending)
        pendingKeys.add(recordKey(pending))
      }
      const records = []
      for (const record of historyStore.get()) {
        if (record.sessionId !== currentSessionId) continue
        if (pendingKeys.has(recordKey(record))) continue
        records.push(record)
      }
      return records.concat(pendings)
    }

    function recordById(recordId) {
      for (const record of renderedRecords()) {
        if (record.id === recordId) return record
      }
      return null
    }

    function textSegmentsOfRange(range) {
      const segments = []
      if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
        if (range.endOffset > range.startOffset) {
          segments.push({ node: range.startContainer, start: range.startOffset, end: range.endOffset })
        }
        return segments
      }
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        let intersects = false
        try {
          intersects = range.intersectsNode(node)
        } catch {
          intersects = false
        }
        if (intersects) {
          const start = node === range.startContainer ? range.startOffset : 0
          const end = node === range.endContainer ? range.endOffset : node.data.length
          if (end > start) segments.push({ node: node, start: start, end: end })
        }
        node = walker.nextNode()
      }
      return segments
    }

    function clearMarks() {
      const marks = document.querySelectorAll('mark[data-si-record]')
      for (const mark of marks) {
        const parent = mark.parentNode
        if (!parent) continue
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
        parent.normalize()
      }
    }

    function wrapRangeWithMark(range, record, styleToken) {
      for (const segment of textSegmentsOfRange(range)) {
        const textNode = segment.node
        if (!textNode || !textNode.parentNode) continue
        const middle = textNode.data.slice(segment.start, segment.end)
        if (!middle) continue
        const parent = textNode.parentNode
        const fragment = document.createDocumentFragment()
        if (segment.start > 0) fragment.appendChild(document.createTextNode(textNode.data.slice(0, segment.start)))
        const mark = document.createElement('mark')
        mark.className = 'sr-hl'
        mark.setAttribute('data-si-record', record.id)
        mark.setAttribute('data-si-style', styleToken)
        mark.textContent = middle
        fragment.appendChild(mark)
        if (segment.end < textNode.data.length) {
          fragment.appendChild(document.createTextNode(textNode.data.slice(segment.end)))
        }
        parent.replaceChild(fragment, textNode)
      }
    }

    function findRangeForRecord(record) {
      const flow = document.querySelector('[data-chat-flow]')
      if (!flow || !record) return null
      if (record.nodeKey) {
        for (const element of flow.querySelectorAll('[data-chat-node-key]')) {
          if (element.getAttribute('data-chat-node-key') !== record.nodeKey) continue
          const source = element.matches('[data-text-interaction-source]')
            ? element
            : element.querySelector('[data-text-interaction-source]')
          if (!source) continue
          const range = rangeFromOffsets(source, record.start, record.end)
          if (range && range.toString().trim()) return { range: range, source: source }
        }
      }
      const needle = String(record.text || '')
      if (!needle) return null
      for (const source of flow.querySelectorAll('[data-text-interaction-source]')) {
        if (record.turn !== null && record.turn !== undefined) {
          const turnRow = source.closest('[data-chat-turn]')
          const turnValue = turnRow ? Number(turnRow.getAttribute('data-chat-turn')) : NaN
          if (Number.isFinite(turnValue) && turnValue !== record.turn) continue
        }
        const index = source.textContent.indexOf(needle)
        if (index < 0) continue
        const range = rangeFromOffsets(source, index, index + needle.length)
        if (range) return { range: range, source: source }
      }
      return null
    }

    function applyMarks() {
      if (!currentSessionId) {
        clearMarks()
        lastMarkStats = { records: 0, marks: 0, at: Date.now() }
        lastApply = { signature: '', at: 0, incomplete: false }
        return
      }
      const records = renderedRecords()
      const existing = Array.prototype.slice.call(document.querySelectorAll('mark[data-si-record]'))
      if (records.length === 0) {
        if (existing.length) clearMarks()
        lastMarkStats = { records: 0, marks: 0, at: Date.now() }
        lastApply = { signature: '', at: 0, incomplete: false }
        return
      }
      const signature = records
        .map((record) => record.id)
        .sort()
        .join('|')
      if (
        lastApply.incomplete &&
        lastApply.signature === signature &&
        Date.now() - lastApply.at < 2000
      ) {
        return
      }
      const existingIds = new Set()
      const recordIds = new Set()
      for (const record of records) recordIds.add(record.id)
      for (const mark of existing) existingIds.add(mark.getAttribute('data-si-record'))
      let complete = existing.length > 0
      if (complete) {
        for (const mark of existing) {
          if (!recordIds.has(mark.getAttribute('data-si-record'))) {
            complete = false
            break
          }
        }
      }
      if (complete) {
        for (const record of records) {
          if (!existingIds.has(record.id)) {
            complete = false
            break
          }
        }
      }
      if (complete) {
        const token = markStyleToken()
        for (const mark of existing) {
          if (mark.getAttribute('data-si-style') !== token) mark.setAttribute('data-si-style', token)
        }
        lastMarkStats = { records: records.length, marks: existing.length, at: Date.now() }
        lastApply = { signature: signature, at: 0, incomplete: false }
        return
      }
      clearMarks()
      const token = markStyleToken()
      let made = 0
      for (const record of records) {
        const found = findRangeForRecord(record)
        if (!found) continue
        wrapRangeWithMark(found.range, record, token)
        made += 1
      }
      lastApply = { signature: signature, at: Date.now(), incomplete: made < records.length }
      lastMarkStats = { records: records.length, marks: made, at: Date.now() }
    }

    function popupGeometry(rect) {
      const margin = 16
      const width = Math.min(420, window.innerWidth - margin * 2)
      const base = rect || { left: margin, top: margin, right: margin, bottom: margin, width: 0, height: 0 }
      const left = Math.max(margin, Math.min(Number(base.left) || margin, window.innerWidth - width - margin))
      const estimate = 320
      let top = (Number(base.bottom) || margin) + 10
      if (top + estimate > window.innerHeight - margin) {
        top = Math.max(margin, (Number(base.top) || margin) - estimate - 10)
      }
      return { left: left + 'px', top: top + 'px' }
    }

    function openRecordPopup(record, preferredRect) {
      let rect = preferredRect || null
      if (!rect) {
        const found = findRangeForRecord(record)
        rect = found ? found.range.getBoundingClientRect() : null
      }
      if (pendingMap.has(record.id)) {
        const pending = pendingMap.get(record.id)
        openPopup({
          id: 'pending-' + record.id,
          text: record.text,
          status: pending.status === 'error' ? 'error' : 'loading',
          error: pending.error || '',
          rect: rect,
          pendingId: record.id,
          request: pending.request,
        })
        return
      }
      openPopup({
        id: 'view-' + record.id,
        text: record.text,
        status: 'done',
        result: record.result,
        model: record.model || '',
        rect: rect,
        recordId: record.id,
      })
    }

    function deleteInterpretation(recordId) {
      if (!recordId) return
      if (pendingMap.has(recordId)) pendingMap.delete(recordId)
      else historyStore.set(removeInterpretation(historyStore.get(), recordId))
      const current = uiStore.get()
      const closingPopup = current.popup && (current.popup.recordId === recordId || current.popup.pendingId === recordId)
      uiStore.set({ ...current, menu: null, popup: closingPopup ? null : current.popup })
      scheduleHighlightSync()
    }

    // ---------- 发起解读 ----------

    function resolveModelSelection(sessionId) {
      const settings = settingsStore.get()
      if (settings.modelMode === 'fixed' && settings.provider && settings.model) {
        return { provider: settings.provider, model: settings.model }
      }
      try {
        const resolver = pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('modelDirectories') : null
        if (resolver && typeof resolver.directoryFor === 'function') {
          const directory = resolver.directoryFor(sessionId)
          const snapshot = directory && typeof directory.getSnapshot === 'function' ? directory.getSnapshot() : null
          const current = snapshot && snapshot.current
          if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
            return { provider: current.provider, model: current.model }
          }
        }
      } catch {
        /* 取不到当前会话模型时交给 Host 默认模型 */
      }
      return {}
    }

    async function requestInterpretation(payload) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), 120 * 1000) : null
      try {
        const response = await fetch(API + '/interpret', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        })
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!data || data.ok !== true) {
          const message = data && data.error && data.error.message ? data.error.message : 'HTTP ' + response.status
          throw new Error(message)
        }
        const model = data.model && typeof data.model.model === 'string' ? data.model.model : ''
        return { text: String(data.text || ''), model: model }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /** 测试第三方接口是否可用（Host 侧发一个最小请求）。 */
    async function requestCustomTest(config) {
      const response = await fetch(API + '/custom/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseURL: config.baseURL, apiKey: config.apiKey, model: config.model }),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!data) throw new Error('HTTP ' + response.status)
      if (data.ok !== true) {
        throw new Error(data.error && data.error.message ? data.error.message : '测试失败')
      }
      return { text: String(data.text || ''), latencyMs: Number(data.latencyMs) || 0 }
    }

    function startInterpretation(info) {
      const request = {
        text: info.text,
        context: info.context,
        sessionId: info.sessionId,
        sessionTitle: info.sessionTitle || '',
        nodeKey: info.nodeKey || '',
        turn: info.turn,
        start: info.start,
        end: info.end,
        rect: info.rect,
      }
      const cached = findCachedInterpretation(historyStore.get(), request.sessionId, request.turn, request.nodeKey, request.text)
      if (cached) {
        scheduleHighlightSync()
        openPopup({
          id: 'cache-' + cached.id,
          text: cached.text,
          status: 'done',
          result: cached.result,
          model: cached.model || '',
          rect: request.rect,
          recordId: cached.id,
        })
        return
      }
      const pendingId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      pendingMap.set(pendingId, {
        id: pendingId,
        sessionId: request.sessionId,
        nodeKey: request.nodeKey,
        turn: request.turn,
        start: request.start,
        end: request.end,
        text: request.text,
        status: 'loading',
        error: '',
        request: request,
      })
      scheduleHighlightSync()
      openPopup({ id: pendingId, text: request.text, status: 'loading', rect: request.rect, pendingId: pendingId, request: request })
      runInterpretation(request, pendingId)
    }

    async function runInterpretation(request, pendingId) {
      try {
        const settings = settingsStore.get()
        if (settings.modelMode === 'custom' && (!String(settings.customBaseUrl || '').trim() || !String(settings.customModel || '').trim())) {
          throw new Error('先在插件设置里填好自定义 API 的接口地址和模型名')
        }
        const payload = {
          text: request.text,
          context: request.context,
          prompt: settings.prompt,
        }
        if (settings.modelMode === 'custom') {
          payload.custom = {
            baseURL: settings.customBaseUrl,
            apiKey: settings.customApiKey,
            model: settings.customModel,
          }
        } else {
          Object.assign(payload, resolveModelSelection(request.sessionId))
        }
        const outcome = await requestInterpretation(payload)
        const now = Date.now()
        const record = {
          id: 'r-' + now + '-' + Math.random().toString(36).slice(2, 8),
          text: request.text,
          result: outcome.text,
          model: outcome.model || '',
          sessionId: request.sessionId,
          sessionTitle: request.sessionTitle || '',
          nodeKey: request.nodeKey || '',
          turn: request.turn,
          start: request.start,
          end: request.end,
          createdAt: now,
          updatedAt: now,
        }
        pendingMap.delete(pendingId)
        historyStore.set(upsertInterpretation(historyStore.get(), record, settingsStore.get().historyLimit))
        scheduleHighlightSync()
        updatePopupIfCurrent(pendingId, { status: 'done', result: outcome.text, model: outcome.model || '', recordId: record.id, pendingId: null, error: '' })
      } catch (error) {
        const pending = pendingMap.get(pendingId)
        if (pending) {
          pending.status = 'error'
          pending.error = String(error && error.message ? error.message : error)
          pendingMap.set(pendingId, pending)
        }
        scheduleHighlightSync()
        updatePopupIfCurrent(pendingId, {
          status: 'error',
          error: String(error && error.message ? error.message : error),
          pendingId: pendingId,
        })
      }
    }

    function retryPopup() {
      const popup = uiStore.get().popup
      if (!popup || !popup.pendingId) return
      const pending = pendingMap.get(popup.pendingId)
      if (!pending || !pending.request) return
      pending.status = 'loading'
      pending.error = ''
      pendingMap.set(popup.pendingId, pending)
      scheduleHighlightSync()
      updatePopup({ status: 'loading', error: '' })
      runInterpretation(pending.request, popup.pendingId)
    }

    // ---------- 时间格式 ----------

    function formatTime(timestamp) {
      const date = new Date(Number(timestamp) || Date.now())
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      if (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
      ) {
        return pad(date.getHours()) + ':' + pad(date.getMinutes())
      }
      if (date.getFullYear() === now.getFullYear()) return date.getMonth() + 1 + '月' + date.getDate() + '日'
      return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日'
    }

    // ---------- 文案 ----------

    const zh = {
      'panel.label': '划词解读',
      'page.title': '划词解读',
      'page.subtitle': '划词看解释，历史随时找回',
      'tabs.history': '解读历史',
      'tabs.settings': '插件设置',
      'history.search': '搜索解读文本或对话',
      'history.count': '共 {count} 条',
      'history.empty': '还没有解读记录',
      'history.emptyHint': '在对话里划词，点「解读」试试',
      'history.noResult': '没有匹配的记录',
      'history.untitled': '未命名对话',
      'history.meta': '{title} · {time}',
      'detail.title': '解读',
      'detail.conversation': '对话：{title}',
      'detail.jump': '回到对话',
      'detail.close': '关闭',
      'settings.section.interpret': '解读',
      'settings.section.display': '划词与显示',
      'settings.section.history': '历史',
      'settings.prompt': '解读提示词',
      'settings.promptHint': '发给 AI 的系统提示词，修改后立即生效',
      'settings.restore': '恢复默认',
      'settings.restored': '已恢复默认提示词',
      'settings.model': '模型',
      'settings.modelCurrent': '跟随当前会话',
      'settings.modelFixed': '指定模型',
      'settings.provider': '服务商',
      'settings.modelId': '模型',
      'settings.modelHint': '跟随当前会话时，使用这条对话正在用的模型',
      'settings.modelCustom': '自定义 API',
      'settings.customHint': 'OpenAI 兼容接口（/chat/completions）；地址可只填到 /v1',
      'settings.customBaseUrl': '接口地址',
      'settings.customApiKey': 'API Key',
      'settings.customApiKeyHint': '只保存在本机浏览器，不会上传到别处',
      'settings.customModel': '模型名',
      'settings.customTest': '测试连接',
      'settings.customTesting': '测试中…',
      'settings.customOk': '连接成功 · {latency} ms',
      'settings.customFail': '测试失败：{message}',
      'settings.customRequired': '先填接口地址和模型名',
      'settings.modelsRetry': '重试',
      'settings.modelsLoading': '正在读取模型列表…',
      'settings.modelsFailed': '模型列表读取失败，可改为手动填写',
      'settings.maxChars': '单次解读字数上限',
      'settings.maxCharsHint': '超出时提示，不发起解读',
      'settings.entry': '划词菜单显示「解读」',
      'settings.entryHint': '关闭后划词只出现「引用文本」',
      'settings.style': '高亮样式',
      'settings.style.fill': '浅色底',
      'settings.style.underline': '下划线',
      'settings.color': '高亮颜色',
      'settings.color.theme': '跟随主题',
      'settings.color.amber': '暖黄',
      'settings.color.blue': '浅蓝',
      'settings.historyLimit': '历史记录上限',
      'settings.historyLimitHint': '超出后先覆盖同一轮次，再删除最旧记录',
      'settings.clear': '清空历史',
      'settings.clearConfirm': '确认清空',
      'settings.cleared': '历史已清空',
      'settings.autosave': '修改即时生效，无需保存',
      'settings.save': '保存设置',
      'settings.revert': '撤销修改',
      'settings.saved': '设置已保存',
      'settings.unsaved': '有未保存的修改',
      'settings.saveHint': '修改后需点「保存设置」生效',
      'surface.quote': '引用文本',
      'surface.interpret': '解读',
      'popup.loading': '正在解读…',
      'popup.error': '解读失败',
      'popup.retry': '重试',
      'popup.close': '关闭',
      'popup.kicker': '划词解读',
      'popup.copy': '复制解读',
      'popup.drag': '拖动标题栏可移动窗口',
      'popup.dragHint': '拖动标题栏移动窗口',
      'toast.copied': '已复制解读',
      'toast.copyFailed': '复制失败，可手动选中复制',
      'toast.maxChars': '一次最多解读 {count} 字',
      'toast.noSelection': '没有读到选中的文字',
      'toast.deleted': '已删除解读',
      'toast.jumpFailed': '原对话已不存在',
      'menu.delete': '删除解读',
      'common.close': '关闭',
      'model.placeholderProvider': '例如 deepseek-account',
      'model.placeholderModel': '例如 deepseek-flash',
    }

    const en = {
      'panel.label': 'Selection reader',
      'page.title': 'Selection reader',
      'page.subtitle': 'Explain selected text in context, with history',
      'tabs.history': 'History',
      'tabs.settings': 'Settings',
      'history.search': 'Search text or conversation',
      'history.count': '{count} entries',
      'history.empty': 'No interpretations yet',
      'history.emptyHint': 'Select text in a conversation and click Interpret',
      'history.noResult': 'No matching entries',
      'history.untitled': 'Untitled conversation',
      'history.meta': '{title} · {time}',
      'detail.title': 'Interpretation',
      'detail.conversation': 'Conversation: {title}',
      'detail.jump': 'Back to conversation',
      'detail.close': 'Close',
      'settings.section.interpret': 'Interpretation',
      'settings.section.display': 'Selection and display',
      'settings.section.history': 'History',
      'settings.prompt': 'Interpretation prompt',
      'settings.promptHint': 'System prompt sent to the model; changes apply immediately',
      'settings.restore': 'Restore default',
      'settings.restored': 'Default prompt restored',
      'settings.model': 'Model',
      'settings.modelCurrent': 'Follow current conversation',
      'settings.modelFixed': 'Use a specific model',
      'settings.provider': 'Provider',
      'settings.modelId': 'Model',
      'settings.modelHint': 'Following uses the model of the current conversation',
      'settings.modelCustom': 'Custom API',
      'settings.customHint': 'OpenAI-compatible (chat/completions); the URL may stop at /v1',
      'settings.customBaseUrl': 'Endpoint URL',
      'settings.customApiKey': 'API key',
      'settings.customApiKeyHint': 'Stored only in this browser; never sent anywhere else',
      'settings.customModel': 'Model name',
      'settings.customTest': 'Test connection',
      'settings.customTesting': 'Testing…',
      'settings.customOk': 'Connected · {latency} ms',
      'settings.customFail': 'Test failed: {message}',
      'settings.customRequired': 'Enter the endpoint URL and model first',
      'settings.modelsRetry': 'Retry',
      'settings.modelsLoading': 'Loading models…',
      'settings.modelsFailed': 'Could not load models; enter them manually',
      'settings.maxChars': 'Characters per interpretation',
      'settings.maxCharsHint': 'Selections beyond the limit are refused',
      'settings.entry': 'Show Interpret in the selection menu',
      'settings.entryHint': 'When off, only Quote text appears',
      'settings.style': 'Highlight style',
      'settings.style.fill': 'Soft fill',
      'settings.style.underline': 'Underline',
      'settings.color': 'Highlight color',
      'settings.color.theme': 'Follow theme',
      'settings.color.amber': 'Amber',
      'settings.color.blue': 'Blue',
      'settings.historyLimit': 'History limit',
      'settings.historyLimitHint': 'New entries overwrite the same turn, then the oldest entry is dropped',
      'settings.clear': 'Clear history',
      'settings.clearConfirm': 'Confirm clear',
      'settings.cleared': 'History cleared',
      'settings.save': 'Save settings',
      'settings.revert': 'Discard changes',
      'settings.saved': 'Settings saved',
      'settings.unsaved': 'Unsaved changes',
      'settings.saveHint': 'Click "Save settings" to apply changes',
      'surface.quote': 'Quote text',
      'surface.interpret': 'Interpret',
      'popup.loading': 'Interpreting…',
      'popup.error': 'Interpretation failed',
      'popup.retry': 'Retry',
      'popup.close': 'Close',
      'popup.kicker': 'Selection reader',
      'popup.copy': 'Copy interpretation',
      'popup.drag': 'Drag the header to move the window',
      'popup.dragHint': 'Drag header to move',
      'toast.copied': 'Interpretation copied',
      'toast.copyFailed': 'Copy failed; select the text manually',
      'toast.maxChars': 'At most {count} characters per interpretation',
      'toast.noSelection': 'No selected text found',
      'toast.deleted': 'Interpretation deleted',
      'toast.jumpFailed': 'The original conversation no longer exists',
      'menu.delete': 'Delete interpretation',
      'common.close': 'Close',
      'model.placeholderProvider': 'e.g. deepseek-account',
      'model.placeholderModel': 'e.g. deepseek-flash',
    }

    // ---------- 样式 ----------

    const STYLE_CSS = [
      '.sr-surface{display:flex;align-items:center;gap:4px;}',
      '.sr-action{corner-shape:round;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;border:none;border-radius:999px;padding:5px 10px;}',
      '@media (hover:hover){.sr-action:hover{background:var(--dsw-alias-button-floating-hover);}}',
      '.sr-action:focus-visible{background:var(--dsw-alias-button-floating-hover);outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px;}',
      '.sr-popup{position:fixed;z-index:1500;display:flex;flex-direction:column;box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:min(60vh,520px);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#202127);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l1);overflow:hidden;font-size:13px;line-height:20px;}',
      '.sr-popup-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);}',
      '.sr-popup-title{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sr-popup-body{padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);}',
      '.sr-popup-body-error{color:var(--dsw-alias-state-error-primary,#e5484d);}',
      '.sr-loading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);}',
      '.sr-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));animation:sr-spin .8s linear infinite;flex:none;}',
      '@keyframes sr-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.sr-spinner{animation-duration:2s}}',
      '.sr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:1;cursor:pointer;flex:none;}',
      '.sr-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary);}',
      '.sr-menu{position:fixed;z-index:1600;min-width:140px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#202127);box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l1);}',
      '.sr-menu-item{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:13px;line-height:20px;font-family:inherit;cursor:pointer;}',
      '.sr-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}',
      '.sr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1700;max-width:80vw;padding:8px 14px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sr-page{box-sizing:border-box;height:100%;min-height:100%;overflow-y:auto;padding:24px 24px 48px;color:var(--dsw-alias-label-primary);}',
      '.sr-page-inner{display:flex;flex-direction:column;gap:16px;max-width:860px;margin:0 auto;}',
      '.sr-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px;}',
      '.sr-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:38px;height:38px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-titles{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;}',
      '.sr-title{margin:0;font-size:20px;line-height:28px;font-weight:600;}',
      '.sr-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.sr-tabs{display:flex;gap:4px;padding:3px;background:var(--dsw-alias-bg-layer-2);border-radius:10px;width:max-content;max-width:100%;}',
      '.sr-tab{border:0;background:transparent;padding:5px 14px;border-radius:8px;font-size:13px;line-height:20px;font-family:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);}',
      '.sr-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1,#2b2d34);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);}',
      '.sr-toolbar{display:flex;align-items:center;gap:10px;}',
      '.sr-search{flex:1;box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit;outline:none;}',
      '.sr-search:focus{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.sr-list{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);}',
      '.sr-row{display:flex;flex-direction:column;gap:3px;padding:11px 14px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l1);background:transparent;text-align:left;cursor:pointer;color:inherit;font:inherit;}',
      '.sr-row:last-child{border-bottom:0;}',
      '.sr-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));}',
      '.sr-row-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sr-row-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sr-empty{padding:36px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;}',
      '.sr-empty-title{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;margin-bottom:6px;}',
      '.sr-card{padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:12px;}',
      '.sr-card-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.sr-field{display:flex;flex-direction:column;gap:6px;}',
      '.sr-field-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:2px 0;}',
      '.sr-field-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);}',
      '.sr-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.sr-textarea{box-sizing:border-box;width:100%;min-height:132px;resize:vertical;padding:10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:13px/20px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;}',
      '.sr-textarea:focus{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-input{box-sizing:border-box;height:30px;padding:0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;outline:none;}',
      '.sr-input:focus{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-select{height:30px;padding:0 6px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;}',
      '.sr-number{width:96px;}',
      '.sr-radio-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13px;line-height:20px;}',
      '.sr-radio{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary);}',
      '.sr-radio input{accent-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-checkbox{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.sr-checkbox input{accent-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:30px;padding:0 12px;border:0;border-radius:8px;font-size:13px;line-height:20px;font-family:inherit;cursor:pointer;}',
      '.sr-btn[disabled]{opacity:.45;cursor:not-allowed;}',
      '.sr-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.sr-btn-primary:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.sr-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary);}',
      '.sr-btn-ghost:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary);}',
      '.sr-btn-outline{background:transparent;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);}',
      '.sr-btn-outline:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}',
      '.sr-btn-danger{background:transparent;border:.5px solid var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d);}',
      '.sr-btn-danger:hover:not([disabled]){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 10%,transparent);}',
      '.sr-modal-backdrop{position:fixed;inset:0;z-index:1400;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px;}',
      '.sr-modal{box-sizing:border-box;width:min(560px,100%);max-height:min(80vh,720px);display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#202127);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l1);overflow:hidden;}',
      '.sr-modal-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);}',
      '.sr-modal-title{flex:1;min-width:0;font-size:14px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sr-modal-meta{padding:8px 16px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.sr-modal-body{padding:12px 16px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);}',
      '.sr-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l1);}',
      '::highlight(sr-fill-theme){background-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 20%,transparent);}',
      '::highlight(sr-fill-amber){background-color:rgba(245,166,35,.28);}',
      '::highlight(sr-fill-blue){background-color:rgba(64,158,255,.24);}',
      '::highlight(sr-underline-theme){text-decoration:underline;text-decoration-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));text-decoration-thickness:2px;text-underline-offset:3px;}',
      '::highlight(sr-underline-amber){text-decoration:underline;text-decoration-color:#d99a1f;text-decoration-thickness:2px;text-underline-offset:3px;}',
      '::highlight(sr-underline-blue){text-decoration:underline;text-decoration-color:#409eff;text-decoration-thickness:2px;text-underline-offset:3px;}',
      '/* 划词按钮与解读窗口：质感、入场动效、可拖动窗口、结构化内容 */',
      '.sr-action{display:inline-flex;align-items:center;gap:5px;transition:background .12s ease,transform .08s ease,box-shadow .12s ease;}',
      '.sr-action:active{transform:scale(.97);}',
      '.sr-action-interpret{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500;box-shadow:var(--dsw-elevation-panel);}',
      '@media (hover:hover){.sr-action.sr-action-interpret:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff);filter:brightness(1.04);}}',
      '.sr-action.sr-action-interpret:focus-visible{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff);outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:2px;}',
      '@keyframes sr-fade-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
      '.sr-action-interpret{animation:sr-fade-in .14s ease-out;}',
      '@keyframes sr-pop-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}',
      '.sr-popup{width:min(460px,calc(100vw - 32px));max-height:min(72vh,620px);border-radius:14px;animation:sr-pop-in .16s ease-out;}',
      '@media (prefers-reduced-motion:reduce){.sr-action-interpret,.sr-popup{animation:none;}}',
      '.sr-popup-head{cursor:grab;user-select:none;gap:10px;padding:11px 12px 11px 14px;align-items:center;}',
      '.sr-dragging .sr-popup-head{cursor:grabbing;}',
      'body.sr-dragging{cursor:grabbing;user-select:none;}',
      '.sr-popup-mark{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 14%,transparent);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));flex:none;}',
      '.sr-popup-titles{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;}',
      '.sr-popup-kicker{font-size:10px;line-height:14px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);}',
      '.sr-popup-title{font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sr-popup-actions{display:flex;align-items:center;gap:2px;flex:none;}',
      '.sr-popup-body{padding:12px 14px 14px;white-space:normal;}',
      '.sr-popup-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 14px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      '.sr-popup-foot-hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sr-model-chip{flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sr-sections{display:flex;flex-direction:column;gap:10px;}',
      '.sr-section{padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
      '.sr-section[data-tone="primary"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 8%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 26%,transparent);}',
      '.sr-section[data-tone="evidence"]{background:var(--dsw-alias-bg-layer-1);border-left:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 45%,transparent);}',
      '.sr-section[data-tone="note"]{background:transparent;border-style:dashed;}',
      '.sr-section-label{display:inline-flex;align-items:center;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));margin-bottom:4px;letter-spacing:.02em;}',
      '.sr-section[data-tone="evidence"] .sr-section-label{color:var(--dsw-alias-label-secondary);}',
      '.sr-section[data-tone="note"] .sr-section-label{color:var(--dsw-alias-label-tertiary);}',
      '.sr-section-body{font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.sr-section-paragraph{margin:0 0 6px;}',
      '.sr-section-paragraph:last-child{margin-bottom:0;}',
      '.sr-term-mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5a623) 26%,transparent);color:inherit;border-radius:4px;padding:0 2px;font-weight:600;}',
      '.sr-loading-wrap{display:flex;flex-direction:column;gap:10px;}',
      '.sr-loading-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;}',
      '.sr-skeleton{display:flex;flex-direction:column;gap:8px;}',
      '.sr-skeleton-line{display:block;height:10px;border-radius:6px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2) 25%,var(--dsw-alias-bg-layer-3,#2f3138) 37%,var(--dsw-alias-bg-layer-2) 63%);background-size:400% 100%;animation:sr-shimmer 1.4s ease infinite;}',
      '@keyframes sr-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
      '@media (prefers-reduced-motion:reduce){.sr-skeleton-line{animation:none;}}',
      '.sr-error-wrap{display:flex;flex-direction:column;gap:10px;align-items:flex-start;}',
      '.sr-error-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 14%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:13px;font-weight:700;}',
      '.sr-error-text{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#e5484d);overflow-wrap:anywhere;}',
      '.sr-search-wrap{position:relative;display:flex;align-items:center;flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);}',
      '.sr-search-wrap .sr-search-icon{position:absolute;left:10px;pointer-events:none;display:inline-flex;}',
      '.sr-search-wrap .sr-search{padding-left:30px;flex:1;}',
      '.sr-row{flex-direction:row;align-items:center;gap:10px;transition:background .12s ease;}',
      '.sr-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;text-align:left;}',
      '.sr-row-arrow{flex:none;color:var(--dsw-alias-label-tertiary);opacity:0;transform:translateX(-2px);transition:opacity .12s ease,transform .12s ease;}',
      '.sr-row:hover .sr-row-arrow{opacity:1;transform:none;}',
      '.sr-empty{display:flex;flex-direction:column;align-items:center;gap:8px;}',
      '.sr-empty-mark{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);margin-bottom:2px;}',
      '.sr-tab{transition:background .12s ease,color .12s ease;}',
      '.sr-modal-body{padding-top:4px;white-space:normal;}',
      '.sr-modal-foot{flex-wrap:wrap;}',
      '.sr-detail-copy{gap:5px;}',
      '.sr-hl{border-radius:3px;padding:0;cursor:pointer;background:transparent;box-decoration-break:clone;-webkit-box-decoration-break:clone;}',
      '.sr-hl[data-si-style="fill:theme"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 22%,transparent);}',
      '.sr-hl[data-si-style="fill:amber"]{background:rgba(245,166,35,.28);}',
      '.sr-hl[data-si-style="fill:blue"]{background:rgba(64,158,255,.24);}',
      '.sr-hl[data-si-style="underline:theme"]{background:transparent;text-decoration:underline;text-decoration-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));text-decoration-thickness:2px;text-underline-offset:3px;}',
      '.sr-hl[data-si-style="underline:amber"]{background:transparent;text-decoration:underline;text-decoration-color:#d99a1f;text-decoration-thickness:2px;text-underline-offset:3px;}',
      '.sr-hl[data-si-style="underline:blue"]{background:transparent;text-decoration:underline;text-decoration-color:#409eff;text-decoration-thickness:2px;text-underline-offset:3px;}',
      '.sr-hl:hover{filter:brightness(.96);}',
      '.sr-input-wide{width:min(340px,100%);}',
      '.sr-test-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.sr-test-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#1f9d55);overflow-wrap:anywhere;}',
      '.sr-test-fail{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d);overflow-wrap:anywhere;max-width:100%;}',
      '.sr-btn-sm{height:26px;padding:0 10px;font-size:12px;}',
      '.sr-savebar{position:sticky;bottom:12px;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px;margin-top:4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);}',
      '.sr-save-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.sr-save-state[data-dirty="true"]{color:var(--dsw-alias-state-warn-primary,#d97706);font-weight:500;}',
      '.sr-save-actions{display:flex;align-items:center;gap:8px;}',
    ].join('\n')

    // ---------- 小组件 ----------

    function ReaderGlyph(props) {
      const size = props.size || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', {
          x: 3.2,
          y: 4.2,
          width: 17.6,
          height: 15.6,
          rx: 4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
        }),
        h('path', {
          d: 'M7.4 9.2h6.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M7.4 13.1h4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', {
          cx: 16.4,
          cy: 14.6,
          r: 2.8,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
        }),
        h('path', {
          d: 'M18.5 16.8l2 2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    function PanellistIcon(props) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h(ReaderGlyph, { size: props.size || 18 }),
      )
    }

    // ---------- 划词浮层旁的「解读」按钮 ----------
    // 官方「引用文本」所在的浮层一次只挂一个交互组件，不能直接往里加按钮；
    // 这里把「解读」挂在同一个浮层右侧，跟随它的位置显示。

    function isSelectionInsideChat() {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false
      const source = closestSource(selection.getRangeAt(0).startContainer)
      return Boolean(source && source.closest('[data-chat-flow]'))
    }

    function computeQuickButtonPosition() {
      if (!settingsStore.get().entryEnabled) return null
      if (!isSelectionInsideChat()) return null
      const surface = document.querySelector('[data-text-interaction-surface]')
      if (!surface) return null
      if (surface.getAttribute('aria-hidden') === 'true') return null
      const style = window.getComputedStyle(surface)
      if (style.display === 'none' || style.visibility === 'hidden') return null
      const pill = surface.querySelector('button') || surface
      const rect = pill.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const height = Math.max(24, Math.round(rect.height))
      const width = 64
      let left = rect.right + 6
      if (left + width > window.innerWidth - 8) left = rect.left - width - 6
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8))
      return { left: Math.round(left), top: Math.round(top), height: height }
    }

    function rememberSelection() {
      if (!currentSessionId || !isSelectionInsideChat()) {
        lastSelectionInfo = null
        return
      }
      const info = captureSelection(currentSessionId)
      lastSelectionInfo = info ? { ...info, at: Date.now() } : null
    }

    function takeLastSelection() {
      const info = lastSelectionInfo
      lastSelectionInfo = null
      if (!info || Date.now() - info.at > 8000) return null
      return info
    }

    function openQuickInterpret(t) {
      const settings = settingsStore.get()
      if (!settings.entryEnabled || !currentSessionId) return
      const info = takeLastSelection() || captureSelection(currentSessionId)
      if (!info) {
        showToast(t('toast.noSelection'))
        return
      }
      if (info.text.length > settings.maxChars) {
        showToast(t('toast.maxChars', { count: settings.maxChars }))
        return
      }
      const context = turnContextOf(info.source)
      const rect = info.rect
      const selection = window.getSelection()
      if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges()
      startInterpretation({
        sessionId: info.sessionId,
        text: info.text,
        start: info.start,
        end: info.end,
        nodeKey: info.nodeKey,
        turn: info.turn,
        context: context,
        sessionTitle: currentSessionTitle,
        rect: rect,
      })
    }

    function copyText(text, t) {
      const value = String(text || '')
      if (!value) return
      try {
        const result = navigator.clipboard.writeText(value)
        if (result && typeof result.then === 'function') {
          result.then(
            () => showToast(t('toast.copied')),
            () => showToast(t('toast.copyFailed')),
          )
        } else {
          showToast(t('toast.copied'))
        }
      } catch {
        showToast(t('toast.copyFailed'))
      }
    }

    function CopyIcon(props) {
      const size = props.size || 14
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', {
          d: 'M15 9V6.5A2.5 2.5 0 0 0 12.5 4H6.5A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    function SearchIcon(props) {
      const size = props.size || 14
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M15.4 15.4l4.1 4.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function ChevronIcon(props) {
      const size = props.size || 14
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M9 5.5l7 6.5-7 6.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function toneOfLabel(label) {
      if (label === '此处含义') return 'primary'
      if (label === '依据') return 'evidence'
      if (label === '补充') return 'note'
      return 'plain'
    }

    function renderTermText(body, term) {
      const paragraphs = String(body || '').split(/\n{2,}/)
      return paragraphs.map((paragraph, paragraphIndex) => {
        const lines = paragraph.split('\n')
        return h(
          'p',
          { key: 'p-' + paragraphIndex, className: 'sr-section-paragraph' },
          lines.map((line, lineIndex) => {
            const pieces = splitTermText(line, term)
            return h(
              'span',
              { key: 'l-' + lineIndex },
              pieces.map((piece, pieceIndex) =>
                piece.hit
                  ? h('mark', { key: 'm-' + pieceIndex, className: 'sr-term-mark' }, piece.text)
                  : h(React.Fragment, { key: 't-' + pieceIndex }, piece.text),
              ),
              lineIndex < lines.length - 1 ? h('br', { key: 'br-' + lineIndex }) : null,
            )
          }),
        )
      })
    }

    function InterpretationSections(props) {
      const sections = React.useMemo(() => parseInterpretation(props.result), [props.result])
      if (sections.length === 0 || (sections.length === 1 && !sections[0].label && !sections[0].body)) {
        return h('div', { className: 'sr-section-body' }, props.result || '')
      }
      return h(
        'div',
        { className: 'sr-sections' },
        sections.map((section, index) => {
          const tone = toneOfLabel(section.label)
          return h(
            'section',
            { key: 's-' + index, className: 'sr-section', 'data-tone': tone },
            section.label ? h('div', { className: 'sr-section-label' }, section.label) : null,
            h('div', { className: 'sr-section-body' }, renderTermText(section.body, props.term)),
          )
        }),
      )
    }

    function PopupCard(props) {
      const t = props.t
      const popup = props.popup
      const cardRef = React.useRef(null)
      const cleanupRef = React.useRef(null)
      React.useEffect(() => {
        return () => {
          if (cleanupRef.current) cleanupRef.current()
        }
      }, [])

      function startDrag(event) {
        if (event.button !== 0) return
        const target = event.target instanceof Element ? event.target : null
        if (target && target.closest('button')) return
        const element = cardRef.current
        if (!element) return
        event.preventDefault()
        const rect = element.getBoundingClientRect()
        const drag = {
          startX: event.clientX,
          startY: event.clientY,
          startLeft: rect.left,
          startTop: rect.top,
          width: rect.width,
          height: rect.height,
        }
        document.body.classList.add('sr-dragging')
        function onMove(moveEvent) {
          const width = Math.min(drag.width, window.innerWidth - 16)
          const height = Math.min(drag.height, window.innerHeight - 16)
          const left = Math.max(8, Math.min(drag.startLeft + moveEvent.clientX - drag.startX, window.innerWidth - width - 8))
          const top = Math.max(8, Math.min(drag.startTop + moveEvent.clientY - drag.startY, window.innerHeight - height - 8))
          props.onMove({ left: left, top: top })
        }
        function onUp() {
          document.body.classList.remove('sr-dragging')
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          cleanupRef.current = null
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        cleanupRef.current = onUp
      }

      const positionStyle = popup.position
        ? { left: Math.round(popup.position.left) + 'px', top: Math.round(popup.position.top) + 'px' }
        : popupGeometry(popup.rect)
      const status = popup.status

      let body = null
      if (status === 'loading') {
        body = h(
          'div',
          { className: 'sr-loading-wrap', 'aria-busy': 'true' },
          h(
            'div',
            { className: 'sr-loading-head' },
            h('span', { className: 'sr-spinner' }),
            h('span', null, t('popup.loading')),
          ),
          h(
            'div',
            { className: 'sr-skeleton' },
            h('span', { className: 'sr-skeleton-line', style: { width: '92%' } }),
            h('span', { className: 'sr-skeleton-line', style: { width: '100%' } }),
            h('span', { className: 'sr-skeleton-line', style: { width: '76%' } }),
          ),
        )
      } else if (status === 'error') {
        body = h(
          'div',
          { className: 'sr-error-wrap' },
          h('span', { className: 'sr-error-icon', 'aria-hidden': 'true' }, '!'),
          h('div', { className: 'sr-error-text' }, popup.error || t('popup.error')),
          popup.pendingId
            ? h('button', { type: 'button', className: 'sr-btn sr-btn-primary', onClick: props.onRetry }, t('popup.retry'))
            : null,
        )
      } else {
        body = h(InterpretationSections, { result: popup.result, term: popup.text })
      }

      return h(
        'div',
        {
          ref: cardRef,
          className: 'sr-popup',
          'data-si-popup': '1',
          'data-status': status,
          role: 'dialog',
          'aria-label': t('popup.kicker'),
          style: { ...positionStyle, pointerEvents: 'auto' },
        },
        h(
          'header',
          { className: 'sr-popup-head', title: t('popup.drag'), onPointerDown: startDrag },
          h('span', { className: 'sr-popup-mark', 'aria-hidden': 'true' }, h(ReaderGlyph, { size: 15 })),
          h(
            'div',
            { className: 'sr-popup-titles' },
            h('span', { className: 'sr-popup-kicker' }, t('popup.kicker')),
            h('span', { className: 'sr-popup-title', title: popup.text }, popup.text),
          ),
          h(
            'div',
            { className: 'sr-popup-actions' },
            status === 'done'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'sr-icon-btn',
                    'aria-label': t('popup.copy'),
                    title: t('popup.copy'),
                    onClick: () => copyText(popup.result, t),
                  },
                  h(CopyIcon, { size: 14 }),
                )
              : null,
            h(
              'button',
              { type: 'button', className: 'sr-icon-btn', 'aria-label': t('popup.close'), title: t('popup.close'), onClick: props.onClose },
              '×',
            ),
          ),
        ),
        h('div', { className: 'sr-popup-body' }, body),
        h(
          'footer',
          { className: 'sr-popup-foot' },
          h('span', { className: 'sr-popup-foot-hint' }, t('popup.dragHint')),
          popup.model ? h('span', { className: 'sr-model-chip' }, popup.model) : null,
        ),
      )
    }

    function QuickInterpretButton(props) {
      const t = props.t
      const settings = useSnapshot(settingsStore)
      const [position, setPosition] = React.useState(null)

      React.useEffect(() => {
        if (!settings.entryEnabled) {
          setPosition(null)
          return undefined
        }
        let timer = 0
        let attempts = 0

        function step() {
          timer = 0
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
            setPosition(null)
            return
          }
          rememberSelection()
          const next = computeQuickButtonPosition()
          setPosition((previous) => {
            if (previous === null && next === null) return previous
            if (previous && next && previous.left === next.left && previous.top === next.top) return previous
            return next
          })
          if (next) {
            attempts = 0
            timer = window.setTimeout(step, 250)
          } else if (attempts < 10) {
            attempts += 1
            timer = window.setTimeout(step, 50)
          }
        }

        function kick() {
          attempts = 0
          if (timer) window.clearTimeout(timer)
          timer = window.setTimeout(step, 0)
        }

        function onSelectionChange() {
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
            lastSelectionInfo = null
            setPosition(null)
            if (timer) {
              window.clearTimeout(timer)
              timer = 0
            }
            return
          }
          kick()
        }

        document.addEventListener('selectionchange', onSelectionChange, true)
        document.addEventListener('pointerup', onSelectionChange, true)
        document.addEventListener('keyup', onSelectionChange, true)
        window.addEventListener('scroll', kick, true)
        window.addEventListener('resize', kick)
        return () => {
          document.removeEventListener('selectionchange', onSelectionChange, true)
          document.removeEventListener('pointerup', onSelectionChange, true)
          document.removeEventListener('keyup', onSelectionChange, true)
          window.removeEventListener('scroll', kick, true)
          window.removeEventListener('resize', kick)
          if (timer) window.clearTimeout(timer)
        }
      }, [settings.entryEnabled])

      // 用 pointerdown 直接触发：官方浮层会在 pointerdown 时收起，
      // 如果等到 click，按钮可能已经因浮层消失而卸载，表现为「点了没反应」。
      function onPointerDown(event) {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const now = Date.now()
        if (now - quickActionAt < 350) return
        quickActionAt = now
        setPosition(null)
        openQuickInterpret(t)
      }

      if (!position) return null
      return h(
        'button',
        {
          type: 'button',
          className: 'sr-action sr-action-interpret',
          'data-si-ui': '1',
          style: {
            position: 'fixed',
            left: position.left + 'px',
            top: position.top + 'px',
            height: position.height + 'px',
            padding: '0 10px',
            boxSizing: 'border-box',
            zIndex: 1450,
            pointerEvents: 'auto',
          },
          onPointerDown: onPointerDown,
          'aria-label': t('surface.interpret'),
          title: t('surface.interpret'),
        },
        h(ReaderGlyph, { size: 13 }),
        h('span', null, t('surface.interpret')),
      )
    }

    function SessionTracker(props) {
      const sessionId = props.sessionId
      const useSessions = props.useSessions
      const sessionTitle =
        typeof useSessions === 'function'
          ? useSessions((state) => {
              const row = state && state.byId && sessionId ? state.byId[sessionId] : null
              return row ? row.title || '' : ''
            })
          : ''
      React.useEffect(() => {
        setCurrentSession(sessionId || null, sessionTitle || '')
        return () => {
          if (currentSessionId === (sessionId || null)) setCurrentSession(null, '')
        }
      }, [sessionId, sessionTitle])
      return null
    }

    function FormRow(props) {
      return h(
        'div',
        { className: 'sr-field-row' },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          h('span', { className: 'sr-field-label' }, props.label),
          props.hint ? h('span', { className: 'sr-hint' }, props.hint) : null,
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, props.children),
      )
    }

    function SettingsPanel(props) {
      const t = props.t
      const draft = props.draft
      const setDraft = props.setDraft
      const saved = useSnapshot(settingsStore)
      const [models, setModels] = React.useState({ status: 'idle', providers: [], defaultSelection: null })
      const [customTest, setCustomTest] = React.useState({ status: 'idle', message: '', latencyMs: 0 })
      const [modelRetry, setModelRetry] = React.useState(0)
      const [clearArmed, setClearArmed] = React.useState(false)

      const dirty = React.useMemo(
        () => JSON.stringify(normalizeSettings(draft)) !== JSON.stringify(normalizeSettings(saved)),
        [draft, saved],
      )

      function patch(patchValue) {
        setDraft(normalizeSettings({ ...draft, ...patchValue }))
      }

      function save() {
        let next = normalizeSettings(draft)
        if (next.modelMode === 'fixed' && !next.provider && activeProvider) {
          next = normalizeSettings({
            ...next,
            provider: activeProvider.id,
            model: next.model || ((activeProvider.models && activeProvider.models[0] && activeProvider.models[0].id) || ''),
          })
        }
        settingsStore.set(next)
        setDraft(next)
        showToast(t('settings.saved'))
      }

      function revert() {
        setDraft(normalizeSettings(settingsStore.get()))
      }

      React.useEffect(() => {
        if (draft.modelMode !== 'fixed') return undefined
        if (models.status === 'ready' || models.status === 'loading') return undefined
        let alive = true
        setModels({ status: 'loading', providers: [], defaultSelection: null })
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = setTimeout(() => {
          if (controller) controller.abort()
        }, 12000)
        fetch(API + '/models', { signal: controller ? controller.signal : undefined })
          .then((response) => response.json())
          .then((data) => {
            if (!alive) return
            if (!data || data.ok !== true) throw new Error('models unavailable')
            const providers = Array.isArray(data.providers) ? data.providers : []
            setModels({ status: 'ready', providers: providers, defaultSelection: data.defaultSelection || null })
          })
          .catch(() => {
            if (alive) setModels({ status: 'error', providers: [], defaultSelection: null })
          })
          .finally(() => clearTimeout(timer))
        return () => {
          alive = false
          clearTimeout(timer)
          if (controller) controller.abort()
        }
      }, [draft.modelMode, modelRetry])

      async function testCustomApi() {
        const value = normalizeSettings(draft)
        if (!String(value.customBaseUrl || '').trim() || !String(value.customModel || '').trim()) {
          setCustomTest({ status: 'fail', message: t('settings.customRequired'), latencyMs: 0 })
          return
        }
        setCustomTest({ status: 'testing', message: '', latencyMs: 0 })
        try {
          const result = await requestCustomTest({
            baseURL: value.customBaseUrl,
            apiKey: value.customApiKey,
            model: value.customModel,
          })
          setCustomTest({ status: 'ok', message: result.text || 'OK', latencyMs: result.latencyMs })
        } catch (error) {
          setCustomTest({
            status: 'fail',
            message: String(error && error.message ? error.message : error),
            latencyMs: 0,
          })
        }
      }

      React.useEffect(() => {
        if (!clearArmed) return undefined
        const timer = setTimeout(() => setClearArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [clearArmed])

      const activeProvider =
        models.providers.find((provider) => provider.id === draft.provider) || models.providers[0] || null
      const providerOptions = models.providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name))
      const modelOptions = activeProvider
        ? (activeProvider.models || []).map((model) => h('option', { key: model.id, value: model.id }, model.name || model.id))
        : []

      return h(
        React.Fragment,
        null,
        h(
          'section',
          { className: 'sr-card' },
          h('h3', { className: 'sr-card-title' }, t('settings.section.interpret')),
          h(
            'div',
            { className: 'sr-field' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', { className: 'sr-field-label' }, t('settings.prompt')),
                h('span', { className: 'sr-hint' }, t('settings.promptHint')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sr-btn sr-btn-ghost',
                  onClick: () => {
                    patch({ prompt: DEFAULT_PROMPT })
                    showToast(t('settings.restored'))
                  },
                },
                t('settings.restore'),
              ),
            ),
            h('textarea', {
              className: 'sr-textarea',
              value: draft.prompt,
              spellCheck: false,
              onChange: (event) => patch({ prompt: event.target.value }),
            }),
          ),
          h(
            FormRow,
            { label: t('settings.model'), hint: t('settings.modelHint') },
            h(
              'div',
              { className: 'sr-radio-row' },
              h(
                'label',
                { className: 'sr-radio' },
                h('input', {
                  type: 'radio',
                  name: 'sr-model-mode',
                  checked: draft.modelMode === 'current',
                  onChange: () => patch({ modelMode: 'current' }),
                }),
                t('settings.modelCurrent'),
              ),
              h(
                'label',
                { className: 'sr-radio' },
                h('input', {
                  type: 'radio',
                  name: 'sr-model-mode',
                  checked: draft.modelMode === 'fixed',
                  onChange: () => patch({ modelMode: 'fixed' }),
                }),
                t('settings.modelFixed'),
              ),
              h(
                'label',
                { className: 'sr-radio' },
                h('input', {
                  type: 'radio',
                  name: 'sr-model-mode',
                  checked: draft.modelMode === 'custom',
                  onChange: () => patch({ modelMode: 'custom' }),
                }),
                t('settings.modelCustom'),
              ),
            ),
          ),
          draft.modelMode === 'fixed'
            ? h(
                'div',
                { className: 'sr-field' },
                models.status === 'loading' ? h('span', { className: 'sr-hint' }, t('settings.modelsLoading')) : null,
                models.status === 'error'
                  ? h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                      h('span', { className: 'sr-hint' }, t('settings.modelsFailed')),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'sr-btn sr-btn-ghost sr-btn-sm',
                          onClick: () => {
                            setModels({ status: 'idle', providers: [], defaultSelection: null })
                            setModelRetry((value) => value + 1)
                          },
                        },
                        t('settings.modelsRetry'),
                      ),
                    )
                  : null,
                models.status === 'ready' && models.providers.length > 0
                  ? h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                      h('span', { className: 'sr-field-label' }, t('settings.provider')),
                      h(
                        'select',
                        {
                          className: 'sr-select',
                          value: draft.provider || (activeProvider ? activeProvider.id : ''),
                          onChange: (event) => {
                            const provider = models.providers.find((item) => item.id === event.target.value)
                            const model = provider && provider.models && provider.models[0] ? provider.models[0].id : ''
                            patch({ provider: event.target.value, model: model })
                          },
                        },
                        providerOptions,
                      ),
                      h('span', { className: 'sr-field-label' }, t('settings.modelId')),
                      h(
                        'select',
                        {
                          className: 'sr-select',
                          value: draft.model || (activeProvider && activeProvider.models && activeProvider.models[0] ? activeProvider.models[0].id : ''),
                          onChange: (event) => patch({ model: event.target.value }),
                        },
                        modelOptions,
                      ),
                    )
                  : h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                      h('span', { className: 'sr-field-label' }, t('settings.provider')),
                      h('input', {
                        className: 'sr-input',
                        value: draft.provider,
                        placeholder: t('model.placeholderProvider'),
                        onChange: (event) => patch({ provider: event.target.value }),
                      }),
                      h('span', { className: 'sr-field-label' }, t('settings.modelId')),
                      h('input', {
                        className: 'sr-input',
                        value: draft.model,
                        placeholder: t('model.placeholderModel'),
                        onChange: (event) => patch({ model: event.target.value }),
                      }),
                    ),
              )
            : null,
          draft.modelMode === 'custom'
            ? h(
                'div',
                { className: 'sr-field' },
                h('span', { className: 'sr-hint' }, t('settings.customHint')),
                h(
                  'div',
                  { className: 'sr-field' },
                  h('span', { className: 'sr-field-label' }, t('settings.customBaseUrl')),
                  h('input', {
                    className: 'sr-input sr-input-wide',
                    value: draft.customBaseUrl,
                    placeholder: 'https://api.openai.com/v1',
                    spellCheck: false,
                    onChange: (event) => patch({ customBaseUrl: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { className: 'sr-field' },
                  h('span', { className: 'sr-field-label' }, t('settings.customApiKey')),
                  h('input', {
                    className: 'sr-input sr-input-wide',
                    type: 'password',
                    value: draft.customApiKey,
                    placeholder: 'sk-…',
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (event) => patch({ customApiKey: event.target.value }),
                  }),
                  h('span', { className: 'sr-hint' }, t('settings.customApiKeyHint')),
                ),
                h(
                  'div',
                  { className: 'sr-field' },
                  h('span', { className: 'sr-field-label' }, t('settings.customModel')),
                  h('input', {
                    className: 'sr-input sr-input-wide',
                    value: draft.customModel,
                    placeholder: 'gpt-4o-mini',
                    spellCheck: false,
                    onChange: (event) => patch({ customModel: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { className: 'sr-test-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sr-btn sr-btn-outline',
                      disabled: customTest.status === 'testing',
                      onClick: testCustomApi,
                    },
                    customTest.status === 'testing' ? t('settings.customTesting') : t('settings.customTest'),
                  ),
                  customTest.status === 'ok'
                    ? h('span', { className: 'sr-test-ok' }, t('settings.customOk', { latency: customTest.latencyMs }))
                    : null,
                  customTest.status === 'fail'
                    ? h('span', { className: 'sr-test-fail' }, t('settings.customFail', { message: customTest.message }))
                    : null,
                ),
              )
            : null,
          h(
            FormRow,
            { label: t('settings.maxChars'), hint: t('settings.maxCharsHint') },
            h('input', {
              className: 'sr-input sr-number',
              type: 'number',
              min: 50,
              max: 4000,
              step: 50,
              value: draft.maxChars,
              onChange: (event) => patch({ maxChars: Number(event.target.value) }),
            }),
          ),
        ),
        h(
          'section',
          { className: 'sr-card' },
          h('h3', { className: 'sr-card-title' }, t('settings.section.display')),
          h(
            FormRow,
            { label: t('settings.entry'), hint: t('settings.entryHint') },
            h(
              'label',
              { className: 'sr-checkbox' },
              h('input', {
                type: 'checkbox',
                checked: draft.entryEnabled,
                onChange: (event) => patch({ entryEnabled: event.target.checked }),
              }),
              draft.entryEnabled ? '开' : '关',
            ),
          ),
          h(
            FormRow,
            { label: t('settings.style') },
            h(
              'div',
              { className: 'sr-radio-row' },
              h(
                'label',
                { className: 'sr-radio' },
                h('input', {
                  type: 'radio',
                  name: 'sr-style',
                  checked: draft.highlightStyle === 'fill',
                  onChange: () => patch({ highlightStyle: 'fill' }),
                }),
                t('settings.style.fill'),
              ),
              h(
                'label',
                { className: 'sr-radio' },
                h('input', {
                  type: 'radio',
                  name: 'sr-style',
                  checked: draft.highlightStyle === 'underline',
                  onChange: () => patch({ highlightStyle: 'underline' }),
                }),
                t('settings.style.underline'),
              ),
            ),
          ),
          h(
            FormRow,
            { label: t('settings.color') },
            h(
              'div',
              { className: 'sr-radio-row' },
              [
                ['theme', t('settings.color.theme')],
                ['amber', t('settings.color.amber')],
                ['blue', t('settings.color.blue')],
              ].map((option) =>
                h(
                  'label',
                  { key: option[0], className: 'sr-radio' },
                  h('input', {
                    type: 'radio',
                    name: 'sr-color',
                    checked: draft.highlightColor === option[0],
                    onChange: () => patch({ highlightColor: option[0] }),
                  }),
                  option[1],
                ),
              ),
            ),
          ),
        ),
        h(
          'section',
          { className: 'sr-card' },
          h('h3', { className: 'sr-card-title' }, t('settings.section.history')),
          h(
            FormRow,
            { label: t('settings.historyLimit'), hint: t('settings.historyLimitHint') },
            h('input', {
              className: 'sr-input sr-number',
              type: 'number',
              min: 20,
              max: 1000,
              step: 20,
              value: draft.historyLimit,
              onChange: (event) => patch({ historyLimit: Number(event.target.value) }),
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end' } },
            h(
              'button',
              {
                type: 'button',
                className: 'sr-btn ' + (clearArmed ? 'sr-btn-danger' : 'sr-btn-outline'),
                onClick: () => {
                  if (!clearArmed) {
                    setClearArmed(true)
                    return
                  }
                  setClearArmed(false)
                  historyStore.set([])
                  showToast(t('settings.cleared'))
                },
              },
              clearArmed ? t('settings.clearConfirm') : t('settings.clear'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sr-savebar' },
          h(
            'span',
            { className: 'sr-save-state', 'data-dirty': dirty ? 'true' : 'false' },
            dirty ? t('settings.unsaved') : t('settings.saveHint'),
          ),
          h(
            'div',
            { className: 'sr-save-actions' },
            h(
              'button',
              { type: 'button', className: 'sr-btn sr-btn-ghost', disabled: !dirty, onClick: revert },
              t('settings.revert'),
            ),
            h(
              'button',
              { type: 'button', className: 'sr-btn sr-btn-primary', disabled: !dirty, onClick: save },
              t('settings.save'),
            ),
          ),
        ),
      )
    }

    function SelectionReaderPage(props) {
      const t = props.t
      const records = useSnapshot(historyStore)
      const [tab, setTab] = React.useState('history')
      const [query, setQuery] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [settingsDraft, setSettingsDraft] = React.useState(() => normalizeSettings(settingsStore.get()))
      const filtered = React.useMemo(() => searchInterpretations(records, query), [records, query])

      function jump(record) {
        try {
          if (typeof props.openSession !== 'function') throw new Error('session api unavailable')
          props.openSession(record.sessionId)
          setDetail(null)
        } catch {
          showToast(t('toast.jumpFailed'))
        }
      }

      const historyBody = h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'sr-toolbar' },
          h(
            'div',
            { className: 'sr-search-wrap' },
            h('span', { className: 'sr-search-icon', 'aria-hidden': 'true' }, h(SearchIcon, { size: 14 })),
            h('input', {
              className: 'sr-search',
              value: query,
              placeholder: t('history.search'),
              'aria-label': t('history.search'),
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          h('span', { className: 'sr-count' }, t('history.count', { count: filtered.length })),
        ),
        filtered.length === 0
          ? h(
              'div',
              { className: 'sr-list' },
              h(
                'div',
                { className: 'sr-empty' },
                h('span', { className: 'sr-empty-mark', 'aria-hidden': 'true' }, h(ReaderGlyph, { size: 26 })),
                h('div', { className: 'sr-empty-title' }, records.length === 0 ? t('history.empty') : t('history.noResult')),
                records.length === 0 ? h('div', null, t('history.emptyHint')) : null,
              ),
            )
          : h(
              'div',
              { className: 'sr-list' },
              filtered.map((record) =>
                h(
                  'button',
                  { key: record.id, type: 'button', className: 'sr-row', onClick: () => setDetail(record) },
                  h(
                    'span',
                    { className: 'sr-row-main' },
                    h('span', { className: 'sr-row-title' }, record.text),
                    h(
                      'span',
                      { className: 'sr-row-meta' },
                      t('history.meta', {
                        title: record.sessionTitle || t('history.untitled'),
                        time: formatTime(record.updatedAt || record.createdAt),
                      }),
                    ),
                  ),
                  h('span', { className: 'sr-row-arrow', 'aria-hidden': 'true' }, h(ChevronIcon, { size: 14 })),
                ),
              ),
            ),
      )

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, STYLE_CSS),
        h(
          'div',
          { className: 'sr-page' },
          h(
            'div',
            { className: 'sr-page-inner' },
            h(
              'header',
              { className: 'sr-head' },
              h('span', { className: 'sr-mark' }, h(ReaderGlyph, { size: 22 })),
              h(
                'div',
                { className: 'sr-titles' },
                h('h1', { className: 'sr-title' }, t('page.title')),
                h('p', { className: 'sr-sub' }, t('page.subtitle')),
              ),
            ),
            h(
              'div',
              { className: 'sr-tabs', role: 'tablist' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'sr-tab',
                  role: 'tab',
                  'aria-selected': tab === 'history' ? 'true' : 'false',
                  'data-active': tab === 'history' ? 'true' : 'false',
                  onClick: () => setTab('history'),
                },
                t('tabs.history'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sr-tab',
                  role: 'tab',
                  'aria-selected': tab === 'settings' ? 'true' : 'false',
                  'data-active': tab === 'settings' ? 'true' : 'false',
                  onClick: () => setTab('settings'),
                },
                t('tabs.settings'),
              ),
            ),
            tab === 'history' ? historyBody : h(SettingsPanel, { t: t, draft: settingsDraft, setDraft: setSettingsDraft }),
          ),
        ),
        detail
          ? h(
              'div',
              {
                className: 'sr-modal-backdrop',
                'data-si-ui': '1',
                onClick: (event) => {
                  if (event.target === event.currentTarget) setDetail(null)
                },
              },
              h(
                'div',
                { className: 'sr-modal' },
                h(
                  'div',
                  { className: 'sr-modal-head' },
                  h('span', { className: 'sr-modal-title', title: detail.text }, t('detail.title') + '：' + detail.text),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sr-icon-btn',
                      'aria-label': t('detail.close'),
                      onClick: () => setDetail(null),
                    },
                    '×',
                  ),
                ),
                h(
                  'div',
                  { className: 'sr-modal-meta' },
                  t('detail.conversation', { title: detail.sessionTitle || t('history.untitled') }) +
                    (detail.model ? ' · ' + detail.model : ''),
                ),
                h(
                  'div',
                  { className: 'sr-modal-body' },
                  h(InterpretationSections, { result: detail.result, term: detail.text }),
                ),
                h(
                  'div',
                  { className: 'sr-modal-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sr-btn sr-btn-ghost sr-detail-copy',
                      onClick: () => copyText(detail.result, t),
                    },
                    h(CopyIcon, { size: 14 }),
                    t('popup.copy'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'sr-btn sr-btn-ghost', onClick: () => setDetail(null) },
                    t('detail.close'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'sr-btn sr-btn-primary', onClick: () => jump(detail) },
                    t('detail.jump'),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function Overlay(props) {
      const t = props.t
      const ui = useSnapshot(uiStore)

      React.useEffect(() => {
        if (!ui.popup && !ui.menu) return undefined
        function onPointerDown(event) {
          const target = event.target instanceof Element ? event.target : null
          if (!target) return
          const current = uiStore.get()
          if (current.popup && !target.closest('[data-si-popup]')) {
            uiStore.set({ ...current, popup: null })
          }
          if (current.menu && !target.closest('[data-si-menu]')) {
            uiStore.set({ ...uiStore.get(), menu: null })
          }
        }
        function onKeyDown(event) {
          if (event.key !== 'Escape') return
          const current = uiStore.get()
          if (current.popup || current.menu) uiStore.set({ ...current, popup: null, menu: null })
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [ui.popup, ui.menu])

      let popup = null
      if (ui.popup) {
        popup = h(PopupCard, {
          popup: ui.popup,
          t: t,
          onMove: (position) => updatePopup({ position: position }),
          onRetry: retryPopup,
          onClose: closePopup,
        })
      }

      let menu = null
      if (ui.menu) {
        const left = Math.max(8, Math.min(ui.menu.x, window.innerWidth - 160))
        const top = Math.max(8, Math.min(ui.menu.y, window.innerHeight - 52))
        menu = h(
          'div',
          { className: 'sr-menu', 'data-si-menu': '1', style: { left: left + 'px', top: top + 'px', pointerEvents: 'auto' } },
          h(
            'button',
            {
              type: 'button',
              className: 'sr-menu-item',
              onClick: () => {
                deleteInterpretation(ui.menu.recordId)
                showToast(t('toast.deleted'))
              },
            },
            t('menu.delete'),
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h(QuickInterpretButton, { t: t }),
        popup,
        menu,
        ui.toast ? h('div', { className: 'sr-toast' }, ui.toast.text) : null,
      )
    }

    // ---------- 全局监听与注册 ----------

    function installHighlightSync(ctx) {
      ctx.effect(() => {
        const unsubscribeSettings = settingsStore.subscribe(scheduleHighlightSync)
        const unsubscribeHistory = historyStore.subscribe(scheduleHighlightSync)
        const unsubscribeUi = uiStore.subscribe((value) => value)
        const observer = new MutationObserver(() => scheduleHighlightSync())
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })

        function onClick(event) {
          if (event.button !== 0) return
          const target = event.target instanceof Element ? event.target : null
          const mark = target ? target.closest('mark[data-si-record]') : null
          if (!mark) return
          const record = recordById(mark.getAttribute('data-si-record'))
          if (!record) return
          event.preventDefault()
          event.stopPropagation()
          openRecordPopup(record, mark.getBoundingClientRect())
        }

        function onContextMenu(event) {
          const target = event.target instanceof Element ? event.target : null
          const mark = target ? target.closest('mark[data-si-record]') : null
          if (!mark) return
          const record = recordById(mark.getAttribute('data-si-record'))
          if (!record) return
          event.preventDefault()
          event.stopPropagation()
          uiStore.set({ ...uiStore.get(), menu: { x: event.clientX, y: event.clientY, recordId: record.id } })
        }

        document.addEventListener('click', onClick, true)
        document.addEventListener('contextmenu', onContextMenu, true)

        // 诊断用：只上报计数和版本，不上报任何对话文本或会话 id（GET /diag 可读）。
        const diagTimer = setInterval(() => {
          const records = renderedRecords()
          if (records.length === 0) return
          try {
            fetch(API + '/diag', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                at: Date.now(),
                client: 'sr-1.2.0',
                records: records.length,
                marks: lastMarkStats.marks,
                nodeKeys: document.querySelectorAll('[data-chat-flow] [data-chat-node-key]').length,
                sources: document.querySelectorAll('[data-chat-flow] [data-text-interaction-source]').length,
              }),
            }).catch(() => {})
          } catch {
            /* 诊断上报失败不影响功能 */
          }
        }, 15000)

        return () => {
          unsubscribeSettings()
          unsubscribeHistory()
          unsubscribeUi()
          observer.disconnect()
          clearInterval(diagTimer)
          document.removeEventListener('click', onClick, true)
          document.removeEventListener('contextmenu', onContextMenu, true)
          if (syncTimer) {
            clearTimeout(syncTimer)
            syncTimer = null
          }
          clearMarks()
        }
      }, 'selection-reader: highlight marks')
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      pluginCtx = ctx
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'selection-reader: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = '@local/dsh-selection-reader'
        style.textContent = STYLE_CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'selection-reader: styles')
      installHighlightSync(ctx)

      function openSession(sessionId) {
        const api = pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('uiWorkspace') : null
        if (!api || typeof api.openSession !== 'function') throw new Error('session api unavailable')
        api.openSession(sessionId)
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: -10,
            locale: NS,
            label: () => t('panel.label'),
          },
          PanellistIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ openSession: openSession }),
          },
          SelectionReaderPage,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'selection-reader-overlay',
            order: 1000,
            locale: NS,
          },
          Overlay,
        ),
      )

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'selection-reader-session',
            order: 1000,
          },
          SessionTracker,
        ),
      )
    }

    return { inject: inject, apply: apply }
  },
})
