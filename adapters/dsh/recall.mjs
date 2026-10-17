/** Host-driven retrieval. Search and body reads are real core calls, independently
 * of whether the model chooses to invoke an AMB tool. Never call an empty search:
 * that would inject unrelated entries from the entire shared library. */
export function isContinuationQuery(query) {
  return /^(?:继续|接着|接着做|继续做|继续执行|好的|好|可以|确认|同意|是|是的|嗯|行|没问题|继续吧|continue|resume|yes|ok|okay|go ahead)[\s。！!，,.？?]*$/i.test(String(query ?? '').trim())
}

/**
 * What one recall passage may cost, in characters.
 *
 * This budget governs the *recall* passage only. The normative text and the task
 * handoff are delivered by `prepare` and by the handoff path and never pass
 * through here, so a budget can only ever shorten recalled knowledge - it cannot
 * touch a prohibition, an obligation, or a handoff line.
 *
 * Defaults, and where they come from (measured on the real library, see
 * docs/implementation/r5-recall-budget.md):
 *   totalChars 1600   - with the normative text reduced to its 53-character
 *                       pointer, real recall passages measured 296, 427, 802 and
 *                       ~1051 characters. 1600 covers that spread with room for
 *                       two index entries and sits below the 2800-character
 *                       single-excerpt ceiling it replaces.
 *   indexChars 240    - title + knowledge id + one sentence + the retrieval hint.
 *   summaryChars 800  - one paragraph of real body, still retrievable in full.
 *   excerptChars 2800 - unchanged from the previous behaviour, so a passage that
 *                       already fitted the old path stays byte-identical.
 */
export const RECALL_BUDGET_DEFAULTS = Object.freeze({
  totalChars: 1600,
  indexChars: 240,
  summaryChars: 800,
  excerptChars: 2800,
  level: 'auto',
})

const DISCLOSURE_LEVELS = new Set(['auto', 'index', 'summary', 'full'])

function positiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Resolve the recall budget from configuration, then the environment, then the
 * defaults above. `auto` is the default disclosure level: a passage that fits
 * keeps its full excerpt (byte-identical to the previous behaviour), and a
 * passage that does not fit degrades entry by entry to summary, then to index.
 */
export function resolveRecallBudget(config = {}, env = process.env) {
  const level = String(config.recallLevel ?? env?.AMB_RECALL_LEVEL ?? '').trim().toLowerCase()
  return Object.freeze({
    totalChars: positiveInt(config.recallBudgetChars ?? env?.AMB_RECALL_BUDGET_CHARS, RECALL_BUDGET_DEFAULTS.totalChars),
    indexChars: positiveInt(config.recallIndexChars ?? env?.AMB_RECALL_INDEX_CHARS, RECALL_BUDGET_DEFAULTS.indexChars),
    summaryChars: positiveInt(config.recallSummaryChars ?? env?.AMB_RECALL_SUMMARY_CHARS, RECALL_BUDGET_DEFAULTS.summaryChars),
    excerptChars: positiveInt(config.recallExcerptChars ?? env?.AMB_RECALL_EXCERPT_CHARS, RECALL_BUDGET_DEFAULTS.excerptChars),
    level: DISCLOSURE_LEVELS.has(level) ? level : RECALL_BUDGET_DEFAULTS.level,
  })
}

/** One block per document, in the three disclosure forms the budget may pick. */
function documentForms(doc, budget) {
  const idLine = `### ${doc.title} (${doc.id}@${doc.revision})`
  const leavesLine = doc.leaves.length
    ? `\n参考文档：${doc.leaves.map(leaf => leaf.path).slice(0, 12).join('、')}；需要时用 amb_read_knowledge(includeLeaves:true) 读取。`
    : ''
  const structureLine = doc.needsStructure ? '\n[原始技能尚未结构化；不能据此声称完整流程已验证。]' : ''
  const retrieval = `amb_read_knowledge(knowledgeId: "${doc.id}")`

  const excerpt = doc.located.slice(0, budget.excerptChars)
  const full = `${idLine}\n${excerpt}${excerpt.length < doc.bodyLength ? '\n[正文节选；可用 amb_read_knowledge 读取全文。]' : ''}${leavesLine}${structureLine}`

  /**
   * A degraded entry carries one passage, not the whole document.
   *
   * Stacking every passage of one entry spends the budget on the same document
   * twice; the degraded forms therefore send the single most relevant passage
   * (`firstPassage`) and say how much of the document stayed behind.
   */
  const restHint = doc.passageCount > 1
    ? `\n[该文档另有 ${doc.passageCount - 1} 段未注入；用 amb_read_knowledge 读取全文。]`
    : ''

  const summaryBody = doc.firstPassage.slice(0, budget.summaryChars)
  const summary = `${idLine} [摘要]\n${summaryBody}`
    + (summaryBody.length < doc.located.length ? '\n[正文节选（摘要级）；可用 amb_read_knowledge 读取全文。]' : '')
    + restHint + leavesLine + structureLine

  const sentenceRoom = Math.max(40, budget.indexChars - idLine.length - 96)
  const sentence = doc.firstPassage.replace(/\s+/g, ' ').trim().slice(0, sentenceRoom)
  const index = `${idLine} [索引]\n摘要：${sentence}${sentence.length < doc.firstPassage.trim().length ? '…' : ''}`
    + `\n正文 ${doc.located.length} 字符未注入；用 ${retrieval} 读取全文。`
    + restHint + leavesLine + structureLine

  return { full, summary, index }
}

/** The disclosure forms to try, best first, for the configured level. */
function formOrder(level) {
  if (level === 'full') return ['full']
  if (level === 'summary') return ['summary', 'index']
  if (level === 'index') return ['index']
  return ['full', 'summary', 'index']
}

export async function recallKnowledge({ client, config, logger, adapter, sessionId, query, trigger = 'task' }) {
  if (isContinuationQuery(query)) return { context: '', ids: [] }
  if (typeof query !== 'string' || !query.trim()) return { context: '', ids: [] }
  const budget = resolveRecallBudget(config)
  const signal = AbortSignal.timeout(4000)
  try {
    const found = await client.post('/v1/knowledge/search-universal', {
      projectId: config.projectId, query: query.slice(0, 4000), limit: 3, autoRecall: true,
    }, { signal })
    if (!Array.isArray(found.results)) throw new Error('Invalid recall search receipt')
    const candidates = found.results.filter(item => typeof item?.id === 'string').slice(0, 2)
    const reads = await Promise.allSettled(candidates.map(item => client.post('/v1/knowledge/read', {
      projectId: config.projectId, knowledgeId: item.id, includeLeaves: false, query: query.slice(0,4000),
    }, { signal })))
    const header = `[AMB 自动检索并读取：${trigger}]\n以下为库内参考资料，请结合当前任务与验证结果使用。\n`
    const ids = [], blocks = [], levels = [], omitted = []
    let used = header.length
    reads.forEach((result, index) => {
      const item = candidates[index]
      if (result.status !== 'fulfilled' || typeof result.value?.body !== 'string') {
        logger.warn('knowledge.auto_read_failed', { adapter, sessionId, trigger, knowledgeId: item.id })
        return
      }
      const value = result.value
      /**
       * One block per document, and the excerpt is the document's own passages.
       * `located` is what the old path sent; the summary and index forms fall
       * back to the first passage alone, because stacking several passages from
       * one document spends the budget on the same entry twice.
       */
      const located = Array.isArray(value.passages) && value.passages.length
        ? value.passages.map(p => `[原文字符 ${p.offset}]\n${p.text}`).join('\n[…]\n')
        : value.body
      const first = Array.isArray(value.passages) && value.passages.length
        ? `[原文字符 ${value.passages[0].offset}]\n${value.passages[0].text}`
        : value.body
      const doc = {
        id: value.id ?? item.id,
        title: value.title ?? item.title ?? item.id,
        revision: value.revision ?? item.revision,
        located,
        firstPassage: first,
        passageCount: Array.isArray(value.passages) && value.passages.length ? value.passages.length : 1,
        bodyLength: value.body.length,
        leaves: Array.isArray(value.leaves) ? value.leaves : [],
        needsStructure: Boolean(value.needsStructure),
      }
      let forms
      try {
        forms = documentForms(doc, budget)
      } catch {
        // One unrenderable entry must not cost the whole passage: it is dropped
        // with a warning, and the remaining entries still arrive.
        logger.warn('knowledge.auto_recall_block_failed', { adapter, sessionId, trigger, knowledgeId: doc.id })
        return
      }
      // A normative entry is never shortened: recalled knowledge may be trimmed,
      // a prohibition or an obligation may not. Normative text also travels with
      // `prepare`, but when one is recalled here it is delivered whole regardless
      // of what the budget has left.
      const mandatory = /^norm:/.test(String(doc.id))
      const order = formOrder(budget.level)
      let chosen = null
      for (const kind of order) {
        if (mandatory && kind === 'full') { chosen = { kind, text: forms.full }; break }
        const separator = blocks.length ? 2 : 0
        if (used + separator + forms[kind].length <= budget.totalChars) { chosen = { kind, text: forms[kind] }; break }
      }
      if (!chosen && mandatory) chosen = { kind: 'full', text: forms.full }
      /**
       * The most relevant entry always travels in some form.
       *
       * A budget that can empty the whole passage would leave the model with no
       * evidence that anything was recalled at all - it would not even know what
       * to ask for. The first (highest-ranked) entry is therefore always sent,
       * degraded to its index form when the budget cannot hold anything else.
       */
      if (!chosen && blocks.length === 0) chosen = { kind: 'index', text: forms.index, forced: true }
      if (!chosen) {
        omitted.push({ id: doc.id, chars: doc.located.length })
        return
      }
      used += (blocks.length ? 2 : 0) + chosen.text.length
      ids.push(doc.id)
      levels.push(`${doc.id}:${chosen.kind}${chosen.forced ? '(forced)' : ''}`)
      blocks.push(chosen.text)
    })
    const omissionNotice = omitted.length
      ? `\n[召回预算 ${budget.totalChars} 字符已用尽：本次省略 ${omitted.length} 篇正文（共 ${omitted.reduce((sum, item) => sum + item.chars, 0)} 字符）——`
        + `${omitted.map(item => `${item.id}（${item.chars} 字符）`).join('、')}。`
        + `取回方式：amb_read_knowledge(knowledgeId) 读取正文，amb_read_knowledge(knowledgeId, includeLeaves:true) 连同参考文档。]`
      : ''
    let context = blocks.length
      ? `${header}${blocks.join('\n\n')}${omissionNotice}`
      : ''
    if (config.token) context = context.split(config.token).join('[redacted]')
    logger.info('knowledge.auto_recall', { adapter, sessionId, trigger,
      matched: found.results.length, readIds: ids, knowledgeRevision: found.knowledgeRevision,
      selectionMode: found.selection?.mode, selectionReason: found.selection?.reason,
      chars: context.length, budgetChars: budget.totalChars, disclosure: levels,
      omittedIds: omitted.map(item => item.id), omittedChars: omitted.reduce((sum, item) => sum + item.chars, 0) })
    return { ids, context }
  } catch (error) {
    // The name only: a recall failure must be diagnosable without writing a
    // server message, a path or a payload into the adapter log.
    const reason = error instanceof Error && /^[A-Za-z]{1,32}Error$/.test(error.name) ? error.name : 'unknown'
    logger.warn('knowledge.auto_recall_failed', { adapter, sessionId, trigger, reason })
    return { ids: [], context: '' }
  }
}
