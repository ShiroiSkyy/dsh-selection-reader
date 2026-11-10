/**
 * 划词解读 · Host 半边
 *
 * 浏览器的 Client 半边通过 /selection-reader/api/* 调用这里：
 *  - POST /interpret     把「选中的文本 + 本轮对话」交给 Harness 的 ctx.llm，或交给自定义的 OpenAI 兼容接口；
 *  - POST /custom/test   测试第三方接口是否可用（发一个最小请求）；
 *  - GET  /models        列出当前可用的服务商与模型，供插件设置里的「指定模型」使用；
 *  - GET  /health        健康检查；
 *  - GET/POST /diag      接收并读取浏览器侧的高亮渲染诊断信息。
 *
 * 模型默认跟随当前会话（由 Client 传入会话正在使用的 provider/model），
 * 取不到时退回 Harness 的默认模型选择；也可以在插件设置里指定模型或填写第三方 API。
 */

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'selection-reader'

/** 依赖：需要 Harness 的 HTTP 服务来暴露接口。 */
export const inject = ['webServer']

const API = '/selection-reader/api'
const DEFAULT_PROVIDER = 'deepseek-account'
const DEFAULT_MODEL = 'deepseek-flash'
const MAX_TEXT = 4000
const MAX_CONTEXT = 12000
const BODY_LIMIT = 256 * 1024
const CALL_TIMEOUT_MS = 90 * 1000

const FALLBACK_PROMPT = [
  '你是「划词解读」助手。用户会在对话中划中一段文字，请你只解释这段文字在当前这轮对话语境里的意思。',
  '',
  '要求：',
  '1. 先判断这段文字在本轮对话中的具体含义、指代和用途，不要泛泛给出百科定义。',
  '2. 如果它是术语、缩写或专业名词，先给出它在这个语境里的所指，再补一句必要的背景。',
  '3. 输出分三段，用小标题「此处含义」「依据」「补充」；没有依据或补充时省略对应段。',
  '4. 全程用简体中文，控制在 300 字以内，不要重复原文，不要输出 Markdown 代码块。',
  '5. 如果仅凭本轮对话无法确定含义，就直接说明不确定，并给出最可能的解释。',
].join('\n')

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function errorPayload(error, code) {
  return {
    ok: false,
    error: {
      code: code || (error && error.code) || 'ERROR',
      message: String(error && error.message ? error.message : error),
    },
  }
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function safeGet(ctx, service) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(service) : undefined
  } catch {
    return undefined
  }
}

/** 当前默认模型选择（Host 侧配置的默认 provider/model）。 */
function defaultSelection(ctx) {
  try {
    const service = safeGet(ctx, 'agentDefaultModel')
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 没有默认模型服务时退回内置值 */
  }
  return undefined
}

function buildRequestText(text, context) {
  const parts = []
  parts.push('【本轮对话】')
  parts.push(context && String(context).trim() ? String(context).trim() : '（本轮对话没有可用文本）')
  parts.push('')
  parts.push('【需要解读的文本】')
  parts.push('<<<')
  parts.push(text)
  parts.push('>>>')
  parts.push('')
  parts.push('请只解释上面这段文本在本轮对话语境里的含义。')
  return parts.join('\n')
}

/** 把 llm.stream 的 chunk 收成完整文本；失败时抛出可读错误。 */
async function collectCompletion(llm, options) {
  let text = ''
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') text += chunk.text || ''
    else if (chunk.type === 'finish') {
      finish = chunk.reason || null
      if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
        const failure = finish.failure || {}
        throw new Error(failure.message || `模型调用失败（${finish.kind}）`)
      }
    }
  }
  return text.trim()
}

/** 第三方接口：允许填基础地址或完整的 /chat/completions 地址。 */
function normalizeChatUrl(baseURL) {
  const url = String(baseURL || '').trim()
  if (!url) throw new Error('缺少接口地址')
  if (!/^https?:\/\//i.test(url)) throw new Error('接口地址需要以 http:// 或 https:// 开头')
  if (/\/chat\/completions\/?$/i.test(url)) return url.replace(/\/+$/, '')
  return url.replace(/\/+$/, '') + '/chat/completions'
}

/** 调一次 OpenAI 兼容的 chat/completions 接口，返回纯文本。 */
async function callCustomChat(options) {
  const url = normalizeChatUrl(options.baseURL)
  const model = String(options.model || '').trim()
  if (!model) throw new Error('缺少模型名')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(options.timeoutMs) || 60000))
  const messages = []
  if (options.system) messages.push({ role: 'system', content: String(options.system) })
  messages.push({ role: 'user', content: String(options.userText || '') })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: 'Bearer ' + String(options.apiKey) } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.max(16, Number(options.maxTokens) || 800),
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.3,
        stream: false,
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    let data = null
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
    if (!response.ok) {
      const fromBody = data && data.error ? (typeof data.error === 'string' ? data.error : data.error.message) : ''
      throw new Error(fromBody || `接口返回 HTTP ${response.status}：${raw.slice(0, 200)}`)
    }
    if (!data) throw new Error(`接口返回的不是 JSON：${raw.slice(0, 200)}`)
    const choice = data.choices && data.choices[0]
    const content = choice && choice.message ? choice.message.content : ''
    const fallback = data.output_text || (data.output && data.output.text) || data.response || ''
    const text = typeof content === 'string' && content.trim() ? content : typeof fallback === 'string' ? fallback : ''
    if (!text.trim()) throw new Error('接口返回了空内容')
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  const disposers = []

  function claim(route) {
    // HMR / 重载时旧实例的路由可能还在表里；先清掉同路径注册，避免 duplicate route。
    try {
      const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes
      if (table && typeof table.delete === 'function') table.delete(route.path)
    } catch {
      /* 私有表不可用时按普通注册处理 */
    }
    disposers.push(ctx.webServer.register(route))
  }

  function route(method, path, handler) {
    claim({
      kind: 'exact',
      path,
      handler: (req, res) => {
        const origin = `http://${req.headers.host || '127.0.0.1'}`
        const url = new URL(req.url || '/', origin)
        const run = async () => {
          if (req.method !== method) {
            sendJson(res, 405, errorPayload(new Error(`只支持 ${method} ${path}`), 'method-not-allowed'))
            return
          }
          const body = method === 'POST' ? await readJsonBody(req) : {}
          const result = await handler({ req, res, url, body })
          if (result !== undefined && !res.writableEnded) sendJson(res, 200, result)
        }
        run().catch((error) => {
          if (res.writableEnded) return
          try {
            sendJson(res, 500, errorPayload(error))
          } catch {
            /* response already closed */
          }
        })
      },
    })
  }

  route('GET', `${API}/health`, async () => {
    const llm = safeGet(ctx, 'llm')
    return {
      ok: true,
      llm: Boolean(llm && typeof llm.stream === 'function'),
      defaultSelection: defaultSelection(ctx) || null,
    }
  })

  let modelCache = null
  let modelCacheAt = 0
  route('GET', `${API}/models`, async () => {
    const now = Date.now()
    if (modelCache !== null && now - modelCacheAt < 60 * 1000) return modelCache
    const llm = safeGet(ctx, 'llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      return { ok: false, error: { code: 'llm/unavailable', message: '当前 Harness 没有提供可用的模型服务' } }
    }
    const providers = []
    const listed = await llm.listProviders()
    for (const provider of listed || []) {
      let models = []
      try {
        const rows = await llm.listModels(provider.id)
        models = (rows || []).map((item) => ({ id: item.id, name: item.name || item.id }))
      } catch {
        models = []
      }
      providers.push({ id: provider.id, name: provider.name || provider.id, models })
    }
    modelCache = { ok: true, providers, defaultSelection: defaultSelection(ctx) || null }
    modelCacheAt = now
    return modelCache
  })

  route('POST', `${API}/custom/test`, async ({ body }) => {
    const startedAt = Date.now()
    try {
      const reply = await callCustomChat({
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        model: body.model,
        system: '你是连接测试助手，只按用户要求回复，不要解释。',
        userText: '请只回复两个字：正常',
        maxTokens: 24,
        timeoutMs: 30000,
        temperature: 0,
      })
      return { ok: true, text: reply, latencyMs: Date.now() - startedAt }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'custom-api-error', message: String(error && error.message ? error.message : error) },
        latencyMs: Date.now() - startedAt,
      }
    }
  })

  let lastDiag = null
  claim({
    kind: 'exact',
    path: `${API}/diag`,
    handler: (req, res) => {
      const run = async () => {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          lastDiag = { at: Date.now(), data: body && typeof body === 'object' ? body : null }
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, diag: lastDiag })
          return
        }
        sendJson(res, 405, errorPayload(new Error('只支持 GET 或 POST'), 'method-not-allowed'))
      }
      run().catch((error) => {
        if (res.writableEnded) return
        try {
          sendJson(res, 500, errorPayload(error))
        } catch {
          /* response already closed */
        }
      })
    },
  })

  route('POST', `${API}/interpret`, async ({ body }) => {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const context = typeof body.context === 'string' ? body.context : ''
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : FALLBACK_PROMPT
    if (!text) return { ok: false, error: { code: 'bad-request', message: '缺少要解读的文本' } }
    if (text.length > MAX_TEXT) {
      return { ok: false, error: { code: 'text-too-long', message: `一次最多解读 ${MAX_TEXT} 字` } }
    }

    if (typeof body.custom === 'object' && body.custom !== null && String(body.custom.baseURL || '').trim()) {
      const startedAt = Date.now()
      try {
        const customModel = String(body.custom.model || '').trim()
        const textResult = await callCustomChat({
          baseURL: body.custom.baseURL,
          apiKey: body.custom.apiKey,
          model: customModel,
          system: prompt,
          userText: buildRequestText(text, context.slice(0, MAX_CONTEXT)),
          maxTokens: 800,
        })
        return {
          ok: true,
          text: textResult,
          model: { provider: 'custom', model: customModel },
          latencyMs: Date.now() - startedAt,
        }
      } catch (error) {
        return {
          ok: false,
          error: { code: 'custom-api-error', message: String(error && error.message ? error.message : error) },
          latencyMs: Date.now() - startedAt,
        }
      }
    }

    const llm = safeGet(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false, error: { code: 'llm/unavailable', message: '当前 Harness 没有提供可用的模型服务' } }
    }

    const fallbackSelection = defaultSelection(ctx)
    const provider =
      typeof body.provider === 'string' && body.provider.trim()
        ? body.provider.trim()
        : (fallbackSelection && fallbackSelection.provider) || DEFAULT_PROVIDER
    const model =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : (fallbackSelection && fallbackSelection.model) || DEFAULT_MODEL

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    try {
      const textResult = await collectCompletion(llm, {
        provider,
        model,
        system: prompt,
        reasoningEffort: 'off',
        maxTokens: 800,
        signal: controller.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildRequestText(text, context.slice(0, MAX_CONTEXT)) }] }],
      })
      if (!textResult) {
        return { ok: false, error: { code: 'empty-result', message: '模型返回了空内容，请重试' } }
      }
      return { ok: true, text: textResult, model: { provider, model } }
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || '')))
      return {
        ok: false,
        error: {
          code: aborted ? 'timeout' : 'llm/error',
          message: aborted ? '解读超时，请重试' : String(error && error.message ? error.message : error),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }, 'selection-reader: http routes')
}
