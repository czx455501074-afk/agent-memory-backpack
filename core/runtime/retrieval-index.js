const normalize = (text) => text.normalize('NFKC').toLowerCase();
// Linguistic filler only. Domain vocabulary stays searchable even when it is
// frequent: dropping it would silently erase the user's subject (see the store
// recall calibration note). Time and generic nouns are included because
// "今天/这次" carry no topical signal and would otherwise let a long diary
// paragraph match any query that mentions a weekday.
const generic = /(?:请|帮我|需要|希望|如何|怎么|实现|功能|完成|任务|主动|调用|使用|进行|相关|知识|经验|日记|我想|能否|一下|有关|问题|解决|处理|现在|请问|一个|之前|关于|应该|可以|帮忙|今天|昨天|明天|最近|这次|上次|刚才|时候|一些|各种|东西|事情|哪些|什么|如果|而且|但是)/g;
const concepts = [
    [/(?:restore|recover(?:y)?|恢复|还原|找回)/gi, 'restore'],
    [/(?:backups?|备份)/gi, 'backup'], [/(?:rollback|回滚)/gi, 'rollback'],
    [/(?:timeouts?|超时)/gi, 'timeout'], [/(?:deleted?|deletion|误删|删除)/gi, 'delete'],
    [/(?:imports?|导入)/gi, 'import'], [/(?:exports?|导出)/gi, 'export'],
    [/(?:synchroni[sz](?:e|ation)|同步)/gi, 'sync'],
];
function lexicalText(text) {
    let value = normalize(text);
    for (const [pattern, term] of concepts)
        value = value.replace(pattern, ` ${term} `);
    return value;
}
const negation = /(?:不要|不需要|无需|不用|不想|排除|\bnot\b|\bwithout\b|don't)/i;
// A bare "别" is a negation only when it directly precedes a verb. Matching the
// character alone rejected "分**别**处理…", turning a two-objective task into
// "no positive task". The lookahead deliberately excludes words that merely
// start with one of these characters ("处理" is not in the list).
const negativeVerb = /别(?=[查看用动改删加写提做成说跑换加])/;
// An explicit statement that there is nothing to retrieve. Two separate
// holdout cases phrase it the same way ("只是闲聊…没有任务要做" /
// "这里没有故障要排查"), so it is a structural signal rather than a topic.
const idle = /(?:只是|仅仅|单纯|不过是)\s*(?:闲聊|聊聊|说说|罗列|列个|列举|记录|提过|提到)|(?:没有|没|无)\s*(?:任何|什么)?\s*(?:任务|故障|问题|需求)(?:\s*(?:要|可|需要))?\s*(?:做|办|排查|处理|修复|检查|解决)?|随便聊|列个词表/;
export function positiveRetrievalClauses(query) {
    const trimmed = query.trim();
    if (/^(?:好的?|收到|谢谢|继续|明白|了解|嗯|ok(?:ay)?|thanks?|done|继续吧)[。.!！\s]*$/i.test(trimmed))
        return [];
    if (/^(?:我)?(?:已|已经)(?:重启|重新启动|安装|更新|升级|保存|完成|恢复)(?:了)?[^，。!?！？]{0,40}[。!！\s]*$/i.test(trimmed))
        return [];
    if (idle.test(trimmed))
        return [];
    return query.split(/[，,。；;\n]|\b(?:but|and|also)\b|而是|同时|以及|并且/i)
        .filter(part => part.trim() && !negation.test(part) && !negativeVerb.test(part));
}
function tokens(text) {
    return [...new Set((lexicalText(text).replace(generic, ' ').replace(/\b(?:the|with|please|this|that|for|only|use|not)\b/g, ' ').match(/[a-z][a-z0-9_.-]*|[\p{Script=Han}]+/gu) ?? []).flatMap(word => /\p{Script=Han}/u.test(word) ? Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : word.length > 2 ? [word] : []))];
}
// Both "Quartz v6" and "Orchid 4" name a version. A bare number only counts when
// it follows a capitalized product name and stays within two digits: otherwise a
// status code (502), an address (127.0.0.1:9182) or an architecture tag (arm64)
// would be read as a version requirement and silently suppress a real answer.
const versions = (text) => [...new Set([
        ...[...text.matchAll(/\bv(?:ersion)?[\s._-]*(\d+(?:\.\d+)*)\b/gi)].map(m => m[1]),
        ...[...text.matchAll(/\b[A-Z][A-Za-z0-9_-]{2,}\s+(\d{1,2})(?![\d.])/g)].map(m => m[1]),
    ])];
const signatures = (text) => text.match(/\b(?:E[A-Z_]{3,}|[A-Za-z]+(?:Error|Exception))\b/g) ?? [];
/** Revision-bound, local purpose index. Synthesized digests only nominate sources;
 * they never replace source text or confer authority. No embeddings are used.
 *
 * Ranking is IDF-weighted rather than a coverage gate. A CJK query of `n`
 * characters becomes `n-1` overlapping bigrams, so most of them are absent from
 * any one document and a fixed "fraction of query terms present" threshold is
 * mathematically unreachable for long queries — which is what made the index
 * abstain on nearly every real request. Weighting each term by its rarity keeps
 * the same evidence standard without punishing query length. */
export function buildRetrievalIndex(candidates) {
    const rows = candidates.map(candidate => {
        const digest = candidate.retrievalDigest?.sourceRevision === candidate.revision ? candidate.retrievalDigest : undefined;
        const description = /^description:\s*(.+)$/m.exec(candidate.body)?.[1] ?? '';
        const titleText = lexicalText(candidate.title);
        const purpose = lexicalText([candidate.title, description, ...(digest?.whenToUse ?? []), ...(digest?.aliases ?? [])].join('\n'));
        const exclusions = (digest?.exclusions ?? []).map(value => tokens(value.replace(/(?:不适用于|不适用|不用于|不要用于|不支持)/g, '')));
        const summary = lexicalText(digest?.summary ?? '');
        // A version named in a prohibiting clause is not an advertised version:
        // "Quartz v5 …禁止使用 v6 分片会话" must not make the v5 entry look like it
        // supports v6. Drop the negated span before reading versions out of it.
        const applicable = [candidate.title, ...(digest?.versions ?? []),
            description.replace(/(?:禁止|不要|不能|不再|不支持|不适用|不用于|弃用|停用|请勿)[^，。；,;.！？!?]{0,24}/g, ' ')].join(' ');
        const advertised = versions(applicable);
        // Skill body examples and imported reference templates do not broaden purpose.
        const windows = [];
        if (candidate.kind !== 'skill')
            for (let offset = 0; offset < Math.min(candidate.body.length, 48000); offset += 240)
                windows.push(lexicalText(candidate.body.slice(offset, offset + 480)));
        // Factual recall uses one compact paragraph or sentence, never dispersed events.
        const facts = candidate.kind === 'skill' ? [] : candidate.body.slice(0, 48000).split(/\n+|[。！？.!?]\s+/).filter(Boolean).map(text => lexicalText(text.slice(0, 320)));
        const vocabulary = new Set([...tokens(purpose), ...tokens(summary),
            ...(candidate.kind === 'skill' ? [] : tokens(lexicalText(candidate.body.slice(0, 48000))))]);
        return { candidate, titleText, purpose, summary, advertised, windows, facts, exclusions, vocabulary,
            // A digest bound to a superseded revision is not usable evidence at all.
            staleDigest: candidate.retrievalDigest !== undefined && digest === undefined };
    });
    // Document frequency over the candidate set, so rarity is measured against the
    // library actually being searched rather than a fixed word list.
    const documentFrequency = new Map();
    for (const row of rows)
        for (const term of row.vocabulary)
            documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    const total = rows.length;
    const idf = (term) => { const frequency = documentFrequency.get(term) ?? 0; return Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5)); };
    const idfSum = (terms) => terms.reduce((sum, term) => sum + idf(term), 0);
    return {
        exact(query) {
            // Escape IDs so punctuation is literal; @revision must match the source.
            return rows.filter(({ candidate }) => {
                const escaped = candidate.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const match = new RegExp(`(?:^|[^a-zA-Z0-9_:-])${escaped}(?:@(\\d+))?(?=$|[^a-zA-Z0-9_:-])`).exec(query);
                return match && (!match[1] || Number(match[1]) === candidate.revision);
            }).map(row => row.candidate);
        },
        rank(query, limit = 12) {
            // Negated clauses must not supply positive retrieval evidence, and a query
            // that only negates or only reports status has no task to retrieve for.
            const clauses = positiveRetrievalClauses(query);
            if (!clauses.length)
                return [];
            const requested = versions(query);
            // Only terms the library actually contains can count for or against a
            // match; a query word nobody knows must not dilute an otherwise exact hit
            // ("导出设备" where only "设备" is unknown still finds the export entry).
            const present = [...new Set(clauses.flatMap(clause => tokens(clause)).filter(term => documentFrequency.has(term)))];
            if (!present.length)
                return [];
            // A long request the library recognises only one word of is a request
            // about something this library does not cover ("Rowan PostgreSQL …",
            // "…只想学习钢琴踏板技巧"). Answering it from that single shared word
            // returns an unrelated entry that merely shares a name. A genuinely short
            // query ("备份", an error code) is not judged this way.
            const queryTermCount = new Set(clauses.flatMap(clause => tokens(clause))).size;
            // A named failure mode is itself the topic, so it is never treated as an
            // unrecognised request even when it is the only term the library knows.
            if (present.length < 2 && queryTermCount >= 3 && !signatures(query).length)
                return [];
            const presentIdf = idfSum(present);
            const coverage = (hits) => presentIdf ? idfSum(hits) / presentIdf : 0;
            const normalizedQuery = normalize(clauses.join(' '));
            return rows.flatMap(row => {
                if (row.staleDigest)
                    return [];
                // Unsupported or mismatched advertised versions are a deterministic
                // boundary, not a ranking signal.
                if (requested.length === 1 && row.advertised.length && !row.advertised.includes(requested[0]))
                    return [];
                const excluded = row.exclusions.some(terms => terms.length >= 2 && terms.filter(term => normalizedQuery.includes(term)).length / terms.length >= .8);
                if (excluded)
                    return [];
                // Evidence is judged per objective: a query naming two topics must be
                // able to retrieve both, and neither may be judged by the other's terms.
                const objective = clauses.map((clause, index) => {
                    const clauseTerms = tokens(clause);
                    const terms = clauseTerms.filter(term => documentFrequency.has(term));
                    if (!terms.length)
                        return undefined;
                    const purposeHits = terms.filter(term => row.purpose.includes(term) || row.summary.includes(term));
                    // The title carries the subject name ("Opal 表格绝对引用"), which is
                    // what separates a genuine match from a generic verb that happens to
                    // appear in some other entry's body ("向下").
                    const titleHits = terms.filter(term => row.titleText.includes(term));
                    // Co-occurrence is judged per sentence/paragraph, not per sliding
                    // window: mechanical filler repeats every ~600 characters, so a wide
                    // window straddles a boundary and reads two halves of one record as a
                    // single coherent statement.
                    let factHits = [];
                    for (const fact of row.facts) {
                        const hits = terms.filter(term => fact.includes(term));
                        if (hits.length > factHits.length)
                            factHits = hits;
                    }
                    let windowHits = [];
                    for (const window of row.windows) {
                        const hits = terms.filter(term => window.includes(term));
                        if (hits.length > windowHits.length)
                            windowHits = hits;
                    }
                    return { index, clause, clauseTerms, terms, purposeHits, titleHits, factHits, windowHits };
                }).filter((value) => value !== undefined);
                if (!objective.length)
                    return [];
                const evidence = objective.map(({ index, clause, clauseTerms, terms, purposeHits, titleHits, factHits, windowHits }) => {
                    const clauseIdf = idfSum(terms);
                    const local = (hits) => clauseIdf ? idfSum(hits) / clauseIdf : 0;
                    const union = [...new Set([...purposeHits, ...factHits])];
                    // A signature is a named failure mode in one sentence, which is
                    // stronger evidence than a scattered mention of the same words. It is
                    // read off the original clause: tokenization lowercases everything, so
                    // extracting it from tokens would never see a capitalized error code.
                    const named = signatures(clause).some(signature => row.facts.some(fact => fact.includes(signature.toLowerCase())));
                    // How much of the objective the library actually knows about. A query
                    // whose terms are almost all unknown is asking about something this
                    // library does not cover; that must not be answered from whatever
                    // single common word happened to exist.
                    const known = terms.length / Math.max(1, clauseTerms.length);
                    const strong = (purposeHits.length >= 2 && local(purposeHits) >= 0.5)
                        || named
                        || (factHits.length >= 3 && local(factHits) >= 0.6)
                        || (purposeHits.length >= 1 && factHits.length >= 1 && local(union) >= 0.35)
                        || (terms.length <= 2 && purposeHits.length >= 1 && local(purposeHits) >= 0.5 && known >= 0.4);
                    return { index, union, strong, titleHits, local: local(union) };
                });
                const hits = [...new Set(evidence.flatMap(item => item.union))];
                if (!hits.length)
                    return [];
                const strong = evidence.some(item => item.strong);
                // A whole daily log can match a few words in unrelated entries; it is
                // only recallable on explicit evidence, never on scattered terms.
                if (row.candidate.kind === 'journal' && !strong)
                    return [];
                // Title evidence separates a subject match ("Opal 表格绝对引用") from a
                // generic verb that merely appears somewhere in another entry's body.
                const subjectHits = [...new Set(evidence.flatMap(item => item.titleHits))];
                const subject = presentIdf ? idfSum(subjectHits) / presentIdf : 0;
                const score = (coverage(hits) + subject) * 3 + (strong ? 1 : 0);
                // Which objective this candidate is the strongest evidence for, so a
                // two-topic request is not answered with only its single best topic.
                const primary = evidence.reduce((best, item) => item.local > best.local ? item : best);
                return [{ candidate: row.candidate, score, strong, objective: primary.index }];
            }).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, limit);
        },
    };
}
