/** Host-driven retrieval. Search and body reads are real core calls, independently
 * of whether the model chooses to invoke an AMB tool. Never call an empty search:
 * that would inject unrelated entries from the entire shared library. */
export function isContinuationQuery(query) {
  return /^(?:继续|接着|接着做|继续做|继续执行|好的|好|可以|确认|同意|是|是的|嗯|行|没问题|继续吧|continue|resume|yes|ok|okay|go ahead)[\s。！!，,.？?]*$/i.test(String(query ?? '').trim())
}

export async function recallKnowledge({ client, config, logger, adapter, sessionId, query, trigger = 'task' }) {
  if (isContinuationQuery(query)) return { context: '', ids: [] }
  if (typeof query !== 'string' || !query.trim()) return { context: '', ids: [] }
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
    const ids = [], blocks = []
    let budget = 6000
    reads.forEach((result, index) => {
      const item = candidates[index]
      if (result.status !== 'fulfilled' || typeof result.value?.body !== 'string') {
        logger.warn('knowledge.auto_read_failed', { adapter, sessionId, trigger, knowledgeId: item.id })
        return
      }
      const value = result.value
      const located = Array.isArray(value.passages) && value.passages.length ? value.passages.map(p=>`[原文字符 ${p.offset}]\n${p.text}`).join('\n[…]\n') : value.body
      const excerpt = located.slice(0, Math.min(2800, budget))
      budget -= excerpt.length
      ids.push(value.id ?? item.id)
      blocks.push(`### ${value.title ?? item.title ?? item.id} (${item.id}@${value.revision ?? item.revision})\n${excerpt}${excerpt.length < value.body.length ? '\n[正文节选；可用 amb_read_knowledge 读取全文。]' : ''}`
        + (Array.isArray(value.leaves) && value.leaves.length ? `\n参考文档：${value.leaves.map(leaf => leaf.path).slice(0, 12).join('、')}；需要时用 amb_read_knowledge(includeLeaves:true) 读取。` : '')
        + (value.needsStructure ? '\n[原始技能尚未结构化；不能据此声称完整流程已验证。]' : ''))
    })
    logger.info('knowledge.auto_recall', { adapter, sessionId, trigger,
      matched: found.results.length, readIds: ids, knowledgeRevision: found.knowledgeRevision,
      selectionMode: found.selection?.mode, selectionReason: found.selection?.reason })
    let context = blocks.length ? `[AMB 自动检索并读取：${trigger}]\n以下为库内参考资料，请结合当前任务与验证结果使用。\n${blocks.join('\n\n')}` : ''
    if (config.token) context = context.split(config.token).join('[redacted]')
    return { ids, context }
  } catch {
    logger.warn('knowledge.auto_recall_failed', { adapter, sessionId, trigger })
    return { ids: [], context: '' }
  }
}
