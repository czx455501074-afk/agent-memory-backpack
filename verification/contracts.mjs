/**
 * Machine-checkable delivery contract for this repository.
 *
 * Twenty-odd fixes have landed over many rounds, several of them in the same handful of
 * files. A green test suite answers "does the code work now?" but not "is the earlier fix
 * still there?" — and the change that overwrites another line usually brings its own
 * passing test. So each delivery is recorded here as a contract: a file plus what must be
 * present, and what must **not** be present (for defects that were removed, the absence is
 * the delivery).
 *
 * Every entry names the round it came from and why it cannot be deleted. A check that
 * nobody can explain is a check the next person deletes.
 *
 * Usage: node verification/contracts.mjs [--json]
 * Exit: 0 = all present, 1 = at least one missing.
 *
 * Limits, stated so this is not mistaken for more than it is: these prove an *entry point*
 * still exists, not that behaviour is correct. Behaviour belongs to the test suite and to
 * the real path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const asJson = process.argv.includes('--json');

/** @type {Array<{id: string, why: string, file: string, must?: string[], mustNot?: string[], pattern?: RegExp, patternMustNot?: RegExp}>} */
const CONTRACTS = [
  {
    id: 'event-fingerprint-order',
    why: '同一事件经 zod 与 outbox 两条路键序不同，指纹曾因此判成“内容不同”，1,168 条投递被永久放弃。',
    file: 'src/store.ts',
    // `digest(payload)` still appears for candidates and for knowledge writes, and that is
    // correct — those bodies round-trip through one path only. The contract is about the
    // event path specifically, so it checks that the canonical form is what gets hashed
    // there, rather than banning the plain hash everywhere.
    must: ['const digestStable =', 'function canonicalEvent(', 'const fingerprint = digestStable(canonical)'],
  },
  {
    id: 'outbox-requeue',
    why: '判定规则会变，而 abandoned 是终态；没有复审出口时，规则修好了队列也救不回来。',
    file: 'src/store.ts',
    must: ['requeueAbandoned(', 'reasonPattern'],
    other: [['src/server.ts', ["'/v1/outbox/requeue'"]]],
  },
  {
    id: 'outbox-tombstone',
    why: 'DELETE 已送达行会连 (principal, idem) 一起删掉，迟到的重试会被当成新任务。',
    file: 'src/store.ts',
    must: ['trimOutboxTombstones', 'OUTBOX_TOMBSTONE_LIMIT'],
  },
  {
    id: 'stats-read-only',
    why: 'stats() 曾首行调 cleanup()，于是“打开控制台”等于清理一次过期数据。',
    file: 'src/store.ts',
    patternMustNot: /stats\(\)\s*\{[\s\S]{0,600}?this\.cleanup\(/,
  },
  {
    id: 'proposal-target',
    why: '队列此前不说明“目标流程已失效”，14 条待审里有 6 条在点开之前无法判断。',
    file: 'src/store.ts',
    must: ['private proposalTarget(', "state: 'missing'", 'private workflowTarget('],
  },
  {
    id: 'event-indexes',
    why: '事件读取 98ms 里绝大部分是缺索引；复合索引建立后 0.03ms。',
    file: 'src/store.ts',
    must: ['ensureEventIndexes', 'eventIndexVersion'],
  },
  {
    id: 'cjk-word-count',
    why: '守门数的是 token，而四个汉字产生三个 bigram，中文短查询因此被判成长请求弃权。',
    file: 'src/retrieval-index.ts',
    must: ['queryWordCount'],
    mustNot: ['queryTermCount'],
  },
  {
    id: 'jobs-lease-renewal',
    why: '租约固定 90 秒无续租，模型审核超时会被第二个 worker 重复执行，两遍都写结果。',
    file: 'src/jobs.ts',
    must: ['heartbeat(id: string, attempts: number', "AND status='running' AND attempts=?"],
  },
  {
    id: 'capture-opt-in',
    why: '解析层 !== false 与消费方 === true 相反，声称 opt-in 的捕获实际默认开启（重复率 66%）。',
    file: 'adapters/dsh/core-client.mjs',
    must: ['autoCaptureFailures === true', 'autoCaptureMaterial === true'],
    mustNot: ['autoCaptureFailures !== false', 'autoCaptureMaterial !== false'],
  },
  {
    id: 'retry-429-408',
    why: '429/408 曾归 http4xx 被判终局拒绝，限流期间候选既不进 outbox 也不进 spool。',
    file: 'adapters/dsh/core-client.mjs',
    must: ["return 'throttled'", "'throttled'"],
  },
  {
    id: 'spool-prune-persist',
    why: 'spool 只过滤返回值，过期条目留在文件里、永不发送且无任何记录。',
    file: 'adapters/dsh/spool.mjs',
    must: ['saveSpool(dataDir, kept)'],
  },
  {
    id: 'ui-batch-failure-message',
    why: '服务端返回 f.message，界面读 f.reason，批量失败原因显示为 undefined。',
    file: 'src/ui.ts',
    must: ["(f.message || f.reason || '未说明')"],
    mustNot: ["+ ': ' + f.reason;"],
  },
  {
    id: 'ui-reopen-guard',
    why: '过期候选的正文已被清除，界面却给出一个必然 404 的“重新开启”按钮。',
    file: 'src/ui.ts',
    must: ['这条候选的正文已按保留期清除'],
  },
  {
    id: 'panel-no-title-gate',
    why: '面板曾在标题为空时禁用确认按钮，用户被迫在采纳流程里手填标题。',
    file: 'adapters/dsh/client.js',
    must: ['manage.composeTitle'],
  },
  {
    id: 'panel-ack',
    why: '面板的门禁说明承诺会带确认标记，实际从不发送，门禁因此无法从面板通过。',
    file: 'adapters/dsh/index.mjs',
    must: ['params.classificationAcknowledged = true'],
  },
  {
    id: 'derived-title',
    why: '候选只有正文，标题由核心派生，避免三处入口各有一套规矩。',
    file: 'src/store.ts',
    must: ['derivedTitle('],
  },
  {
    id: 'evolve-pipeline-stage-one',
    why: '进化管线第一阶段：重复信号转候选，默认预演、绝不写知识库（8 条禁止自动清单是它的安全论证）。',
    file: 'src/evolve.ts',
    must: ['FORBIDDEN_AUTOMATIC', 'export function distillFailures(', 'EVOLVE_DEFAULTS'],
    other: [
      ['src/store.ts', ['ensureEvolveTables', 'runEvolution(options: { projectId']],
      ['src/server.ts', ["'/v1/evolution/run'"]],
    ],
  },
  {
    id: 'evolve-stages-two-three',
    why: '进化二/三阶段：合并近似与过期标记，升级只产待审提案、绝不自行生效。',
    file: 'src/evolve.ts',
    must: ['export function consolidateCandidates(', 'export function promotionText(', 'EVOLVE_STALE_AFTER_MS'],
    other: [
      ['src/store.ts', ['consolidateEvolution(options', 'promoteEvolution(options']],
      ['src/server.ts', ["'/v1/evolution/promote'"]],
    ],
  },
  {
    id: 'journal-history-searchable',
    why: '全文索引原本只存当前版本，被重写掉的内容再也搜不到（真实库 176 条 journal 背后 1,881 个版本）。',
    file: 'src/store.ts',
    must: ['earlierTerms', 'LIMIT 3`', 'slice(0, 40_000)'],
  },
  {
    id: 'journal-counts-content',
    why: 'journal 模板句曾用事件总数，而 94% 事件是心跳，于是每篇日记都读起来一样。',
    file: 'src/store.ts',
    must: ['JOURNAL_HEARTBEAT_KINDS', '个要点'],
  },
  {
    id: 'retrieval-pool-and-lru',
    why: '检索候选池原本恒为 12（库有 800 条时也只看前十），索引缓存按插入顺序淘汰而非使用顺序。',
    file: 'src/retrieval-service.ts',
    must: ['poolSize', 'snapshot.index.rank(query, poolSize)', 'indexes.delete(projectId);indexes.set(projectId,snapshot)'],
  },
  {
    id: 'important-read-as-value',
    why: 'important 的豁免原本用 LIKE 匹配 JSON 文本，格式化后即失效，会把留给人裁决的条目清掉。',
    file: 'src/store.ts',
    must: ["COALESCE(json_extract(payload,'$.important'),0)=0"],
    mustNot: ['%"important":true%'],
  },
  {
    id: 'jobs-retention',
    why: '终态维护作业从不清理：真实库 3,664 行全 completed，按每次通知与模型审核各一行增长。',
    file: 'src/jobs.ts',
    must: ['purgeCompleted(olderThanMs: number, keep = 200)'],
    other: [['src/store.ts', ['this.jobs.purgeCompleted(14 * DAY)']]],
  },
  {
    id: 'derived-tables-retention',
    why: '版本通知每版本一行且无上限（真实库 2,608 行）、模型评审会留下孤儿；两张表原本由 maintenance 建，导致 Store 打开时清理抛 no such table。',
    file: 'src/store.ts',
    must: ['ensureDerivedTables', 'DELETE FROM revision_notifications WHERE revision NOT IN', "DELETE FROM model_reviews WHERE proposal_id NOT IN (SELECT id FROM proposals)"],
  },
  {
    id: 'injection-stage-cap',
    why: 'workflow 的阶段名列表无上限：30 个阶段会全部内联，而注入本应只给入口。',
    file: 'src/store.ts',
    must: ['INJECTED_STAGE_NAMES', 'function stageTrail(', 'stageTrail(w.stages)', 'INJECTED_TEXT_CHARS', 'clampText(w.overview)'],
  },
  {
    id: 'evolve-scheduled',
    why: '进化管线曾只能手动调用；现按六小时窗口幂等入队，且无人值守时只到 consolidate，绝不 promote。',
    file: 'src/maintenance.ts',
    must: ["jobs.enqueue('evolve'", 'evolveWindow', 'evolve(job) {', 'consolidateEvolution('],
    mustNot: ['promoteEvolution'],
  },
  {
    id: 'refine-reads-every-state',
    why: 'refine 的来源原本只读 pending/needs_evidence：被拒收或过期的重复失败，恰在证据最强时从提炼里消失。',
    file: 'src/refine.ts',
    must: ['FROM proposals${where}'],
    mustNot: ["state IN ('pending','needs_evidence')"],
  },
  {
    id: 'backup-guard-locates-and-redacts',
    why: '导出守卫只会说“Credential-shaped content refused”，于是这台机器完全无法备份：既不知道是哪条内容，也没有任何可用的出路。判定本身已提为共享模块（写入路径要用同一份），所以它在这里钉的是"怎么处置命中"，在 redact.ts 钉的是"怎么判定命中"。',
    file: 'src/backup.ts',
    must: ['value.matchAll(', 'redactCredentials?: boolean', 'rewrittenRevisions', 'refuseFindings('],
    other: [
      ['src/archive.ts', ['redactCredentials: options.redactCredentials']],
      ['src/cli.ts', ["'redact-credentials'"]],
      ['src/redact.ts', ['CREDENTIAL_PATTERN', 'credentialRule(', 'REDACTED = ', 'redactDeep', 'isPlaceholderValue', 'redactInString']],
    ],
  },
  {
    id: 'redact-on-write',
    why: '只在导出时拦等于没拦：值已经落在库里、在每一版历史里、在全文索引里，而从不导出的库会一直留着它。两个同类项目都在摄取前清洗，这就是那轮对照里我们唯一弱于对手的安全项。',
    file: 'src/store.ts',
    must: ['redactInString(submission.discovery', 'redactDeep(entry,', 'redacted?: RedactionFinding[]'],
    other: [
      ['test/redact-on-write.test.ts', ['占位与教学写法必须逐字保留', '重试必须命中同一条候选', '未命中的条目必须逐字节不变']],
    ],
  },
  {
    id: 'backup-export-import-symmetric',
    why: '导出侧跳过派生的全文索引行、导入侧却检查它们，于是能写出来的包永远导不回去（真实库 81 行：7 条规范 + 74 条已退役）。',
    file: 'src/backup.ts',
    must: ["if (table !== 'workflow_search')", 'indexable.has(String(row.id))'],
  },
  {
    id: 'normalize-before-write',
    why: '原文入库会与真正的条目竞争检索、并吃掉注入预算（真实库 7.2% 的条目占掉约 104 万字符），所以落库前必须先写规范描述；这条规则由三处对外文本 + 一份可跑的普查共同承载，改一处不改其余就会分裂。',
    file: 'verification/knowledge-normalization.mjs',
    must: ['SIGNALS', 'transcript-prefix', 'oversize-no-pointer', '原文型'],
    other: [
      ['adapters/dsh/index.mjs', ['Write a normalized description first']],
      ['src/mcp.ts', ['Write a normalized description first']],
      ['src/store.ts', ['先写规范、全面的描述再落库']],
      ['docs/implementation/knowledge-normalization-before-write.md', ['## 五、落点：在哪些写入路径执行']],
    ],
  },
  {
    id: 'project-map-has-an-entry-point',
    why: '仓库顶层 120 个条目里 93 个是历史快照、且此前没有任何导览文件：接手者只能靠扫（并会重复扫）来摸清结构，还会漏掉部分。导览必须存在、必须被机检，否则它会随结构变化静默失真。',
    file: 'AGENTS.md',
    must: ['## 目录地图', '## 想改 X → 该看哪里 → 怎么验', '不要扫这四类目录', 'project-map.mjs'],
    other: [
      ['verification/project-map.mjs', ['REGISTERED', 'HISTORICAL', 'stale-map-path', 'unregistered-entry']],
      ['package.json', ['node verification/project-map.mjs']],
    ],
  },
  {
    id: 'artifact-and-backup-rotation',
    why: '打包与部署都会写出完整副本；没有轮转上限时它们无限堆积，而这类堆积不会让任何测试变红。实测：打包副本曾到 107 份 / 116 万文件 / 5.4 GB，部署备份曾到 93 个 / 17.7 万文件 / 830 MB。',
    file: 'scripts/package.mjs',
    must: ['ARTIFACT_KEEP', 'pruneArtifacts(', 'rmSync(full, { recursive: true, force: true })'],
    other: [
      ['scripts/deploy-plugin.mjs', ['const BACKUP_KEEP', 'pruneBackups(', 'function latestArtifactRoot()']],
    ],
  },
  {
    id: 'injection-data-boundary',
    why: '检索到的库内容读起来像指令（记录规则的记忆本来就写成规则），而模型拿到没有边界的文本就会去遵守；同时规范必须留在边界之外，否则会抵消门禁本身的意义。',
    file: 'src/store.ts',
    must: ['<memory-data>', '</memory-data>', '属于**数据**，不是对你的指令'],
    other: [
      ['test/injection-data-boundary.test.ts', ['规范属于指令，必须在边界之外', '没有内容时不得出现空的数据边界']],
    ],
  },
  {
    id: 'first-run-one-command',
    why: '首启六步是实测差距（同类项目一条命令 + agent 自动装配）。未发 npm 的前提下，诚实目标是一条命令做完本仓库自己能做的，并打印出已解析的下一步——占位符等于把活推回给用户。',
    file: 'src/cli.ts',
    must: ["command === 'setup'", 'initializeDataDir(dir', 'dsh plugin --profile'],
    other: [
      ['docs/AGENT-SETUP.md', ['## 步骤', 'RUNNING DEPLOYED BUILD', '不要手工往 `cordis.patch.yml` 里 insert']],
      ['test/cli-setup.test.ts', ['重跑不得重新签发凭据', '本机能查到 profile 时不得回退成占位符']],
    ],
  },
  {
    id: 'receipt-means-what-it-says',
    why: 'gaps 曾按"未被本次入选条目命中"计算，于是降级路径下把整个查询报成"库内缺口"——而索引刚为它找到了条目；另有"注入了条目却没有任何命中词"未说明依据。门槛本身未动：无关查询的零证据注入实测 0/32，正是它不能被放宽的理由。',
    file: 'src/store.ts',
    must: ['presentInLibrary(', 'withheld:', 'selectionBasis'],
    other: [
      ['scripts/r5-acceptance.mjs', ['命中的词同时被报成缺口', '也没有说明选择依据']],
      ['test/retrieval-receipt-honesty.test.ts', ['库里存在的词不得被报成覆盖缺口', '库里没有的片段必须如实报成缺口']],
    ],
  },
  {
    id: 'turn-boundary-distill',
    why: '同类项目的体验优势是把"该不该记"的负担从人转到系统；evolve 三阶段此前只有六小时窗口，候选常在会话结束后很久才出现。适配器不能自己跑提炼（/v1/evolution/run 是 admin-only），所以由它带信号、核心执行——权限边界不动。',
    file: 'src/server.ts',
    must: ['distill: z.boolean().optional()', 'store.runEvolution({ projectId: p.projectId, dryRun: false })'],
    other: [
      ['adapters/dsh/index.mjs', ['distill: config.autoDistill !== false']],
      ['adapters/codex/scripts/hook.mjs', ['distill: config.autoDistill !== false']],
      ['test/archive-distill.test.ts', ['提炼绝不产生提案', '没有信号就不该产生任何候选']],
    ],
  },
  {
    id: 'optional-vector-layer',
    why: '同类项目普遍有向量检索，本项目刻意没有——取舍保留为默认（可离线、可解释），但"要的话有"必须是事实：默认关闭、覆盖不足拒绝融合、失败回落词法，且未配置时连 await 都不加（默认路径多一个让出点会改变并发交错）。',
    file: 'src/embeddings.ts',
    must: ['embeddingConfigFrom', 'embedTexts', 'cosine', 'rrf', 'RRF_K'],
    other: [
      ['src/retrieval-service.ts', ['fuseWithVectors(', 'coverage_too_thin', 'embeddingsForProject(']],
      ['src/store.ts', ['CREATE TABLE IF NOT EXISTS embeddings(', 'saveEmbeddings(']],
      ['src/cli.ts', ["command === 'embed'"]],
      ['test/embedding-fusion.test.ts', ['向量应当把这条带进来', '未配置时不得改变任何选择结果']],
    ],
  },
  {
    id: 'refusal-names-the-field',
    why: '采纳被拒时只回一句"Request fields are invalid"，而页面能构造 6 种 kind、其中两种（material 需要 url/summary/指纹，journal 需要 did）的字段表单根本没收集——于是"缺 url"变成不可诊断的 400。zod 早已算出路径与原因，是 HTTP 边界把它丢掉了。',
    file: 'src/server.ts',
    must: ['const branches', 'closest', 'fields: listed'],
    other: [
      ['src/ui.ts', ['pe-material-fields', 'pe-journal-fields', '采纳为「材料」需要填来源 URL']],
      ['test/approval-invalid-request.test.ts', ['字段列表里应指出 url', '字段列表里应指出 did']],
    ],
  },
  {
    id: 'term-bridge',
    why: '库里 173/173 条条目没有任何桥字段，用户用同义说法（「我以前写下的那些规矩」）检索 matched=0、agent 就"听不懂"——而库里那 4 条 norm 的标题写的是「规范」。术语桥让「用户怎么说」与「库里怎么写」对上：概念组把同一种东西的多种说法连起来，别名与关键词进全文索引（检索侧零改动）。',
    file: 'src/term-bridge.ts',
    must: ['CONCEPT_GROUPS', 'buildTermBridge', "'规矩'"],
    other: [
      ['src/store.ts', ['withBridge', 'rebuildSearchIndex', 'searchIndexSize']],
      ['src/schema.ts', ['aliases: z.array(shortText)', 'keywords: z.array(shortText)']],
      ['src/cli.ts', ["command === 'reindex'"]],
      ['test/term-bridge.test.ts', ['重建后「规矩」应命中', '不被规则覆盖', '新条目写入时就该带桥']],
    ],
  },
  {
    id: 'host-norms-are-named-not-resent',
    why: '库里 4 条规范全是 hostProvided（宿主已注入，插件刻意不重复发送正文），而回执过去只列 id —— agent 既没在上下文里看到内容、也不知道该去读，表现得像"库里没有"。现在给标题与取回方式，但**不给正文**：重复注入会被 skill-context 的测试挡住，那条约束更重要。',
    file: 'src/store.ts',
    must: ['插件不重复注入正文', "amb_search_universal(kind='norm')"],
    other: [['test/skill-context.test.ts', ['宿主已加载的正文不得重复注入']]],
  },
  {
    id: 'long-entries-are-read-in-chunks',
    why: '正文平均 7459 字符、最长 53117，而 read 一次给全文、prepare 只给前 400 字符——前者让 agent 面对五万字只读开头（Lost in the Middle 中段召回跌到 30% 以下），后者让它以为"就这些"。现在默认分块，回执带总块数、目录与未读数量，注入行写明"上面只是片段、约几块、怎么读全"。',
    file: 'src/retrieval-chunk.ts',
    must: ['chunkBody', 'totalChunks', 'advisory', 'outline'],
    other: [
      ['src/server.ts', ['chunkIndex: z.number().int().nonnegative().optional()', 'chunk: {']],
      ['src/mcp.ts', ['come back in CHUNKS by default']],
      ['adapters/dsh/index.mjs', ['come back in CHUNKS by default']],
      ['src/store.ts', ['上面只是与查询相关的片段，不是全文']],
      ['test/retrieval-chunk.test.ts', ['未读必须明说', '默认不得返回全文']],
    ],
  },
  {
    id: 'explicit-search-falls-back-to-the-index',
    why: '显式检索把降级路径（mode:index —— 本机未配模型时就是它）也当成"模型做了决定"，于是为自动注入设的严格证据门槛拦掉了用户明确要找的东西：实测「规矩」在索引里命中 29 条、literal 5 条，而这个端点 0 条。三条路径的约定必须分开：显式检索兜底、autoRecall 保守、literal 直连索引。',
    file: 'src/server.ts',
    must: ["const decided=(selection.mode==='model'&&!modelAbstained)", 'p.autoRecall===true'],
    other: [
      ['test/search-path-conventions.test.ts', ['显式检索不得返回空', 'autoRecall 在模型不可用时必须保守']],
      ['test/retrieval-service.test.ts', ['unavailable model does not guess automatic recall']],
    ],
  },
  {
    id: 'model-term-bridge-is-optional-and-fault-tolerant',
    why: '规则桥覆盖不了个性化说法（项目内部黑话、旧称、某个人的习惯叫法），模型归纳版补这一层。三条纪律：未配置就明说、不可用/不合形状降级到规则桥、产出逐条清洗——**一个坏项不得作废整批**（schema 设长度下限会一票否决，测试连抓两次：.min(2) 挡单字、.min(1) 挡空白串，两次都成了 invalid_response）。产出存独立表不写回条目，所以不造新修订。',
    file: 'src/term-bridge-model.ts',
    must: ['proposeBridge', 'not_configured', 'bridgeSchema', 'invalid_response'],
    other: [
      ['src/store.ts', ['entry_bridges', 'saveBridge', 'pendingBridgeEntries', 'bridgeCount']],
      ['src/cli.ts', ["command === 'bridge'"]],
      ['test/term-bridge-model.test.ts', ['未配置模型时不崩', '不造新修订', '单字泛词应被拒绝']],
    ],
  },
  {
    id: 'scale-and-concurrency-measured',
    why: '此前所有验证都跑在 177 条的小库上。术语桥把每条的别名与关键词灌进全文索引，条目数一涨，索引体积与重建成本都跟着涨——"177 条下很快"从来不等于"一万条下也能用"。',
    file: 'verification/scale-and-concurrency.mjs',
    must: ['rebuildSearchIndex', 'AMB_SCALE_TAG', 'pathToFileURL'],
    other: [
      ['docs/implementation/term-bridge-and-chunked-reading-2026-10-19.md', ['重建索引期间并发 20 次检索', '两个进程同时写']],
    ],
  },
  {
    id: 'injection-uses-the-real-query',
    why: 'prepare 为了列出全部候选给 knowledge() 传空 query（那是故意的），而片段与"读第几块"必须按真实查询取。把 excerpt 改成"相关段落"之后，prepare 路径上一点没变——因为它传的是空字符串，于是 excerpt 永远是正文开头、hitChunks 永远是 null；而当时的测试测的是 knowledge() 直调，所以全绿。**测了函数不等于测了那条真正在跑的路。**',
    file: 'src/store.ts',
    must: ['excerptQuery', '400, 0.5, query)', 'hitChunks'],
    other: [
      ['test/injection-uses-the-real-query.test.ts', ['片段必须按查询取，不能等于正文开头', '浏览目录时不该指路']],
    ],
  },
  {
    id: 'evolve-tops-up-the-model-bridge',
    why: '自动进化产出的条目自动带**规则桥**（所有写入路径都过 withBridge），但规则覆盖不到项目内部黑话、旧称、某个人的习惯叫法——那要模型。所以 evolve 跑完后排队一个 term_bridge 作业去补：未配置模型时它自己跳过（不假装跑过），补到的桥存独立表、不写回条目（不造新修订），只在真写了东西时才重建索引。',
    file: 'src/maintenance.ts',
    must: ["async term_bridge(job)", "jobs.enqueue('term_bridge'", 'pendingBridgeEntries', 'not_configured'],
    other: [
      ['src/jobs.ts', ["'term_bridge'"]],
      ['src/term-bridge-model.ts', ['proposeBridge']],
      ['test/term-bridge-model.test.ts', ['待补模型桥的条目能被列出来']],
    ],
  },
  {
    id: 'deploy-busy-guidance',
    why: '核心在跑时 Windows 拒绝重命名 core 目录；裸 EBUSY 让“部署失败”看起来像包损坏。',
    file: 'scripts/deploy-plugin.mjs',
    must: ['部署目标被占用'],
  },
];

const results = [];
for (const contract of CONTRACTS) {
  const path = join(ROOT, contract.file);
  if (!existsSync(path)) {
    results.push({ id: contract.id, status: 'FAIL', detail: `文件不存在：${contract.file}` });
    continue;
  }
  const text = readFileSync(path, 'utf8');
  const problems = [];
  for (const needle of contract.must ?? []) {
    if (!text.includes(needle)) problems.push(`缺少：${needle}`);
  }
  for (const needle of contract.mustNot ?? []) {
    if (text.includes(needle)) problems.push(`应当不存在：${needle}`);
  }
  if (contract.patternMustNot && contract.patternMustNot.test(text)) {
    problems.push(`命中禁止模式：${contract.patternMustNot}`);
  }
  for (const [otherFile, needles] of contract.other ?? []) {
    const otherPath = join(ROOT, otherFile);
    if (!existsSync(otherPath)) { problems.push(`文件不存在：${otherFile}`); continue; }
    const otherText = readFileSync(otherPath, 'utf8');
    for (const needle of needles) if (!otherText.includes(needle)) problems.push(`${otherFile} 缺少：${needle}`);
  }
  results.push({ id: contract.id, status: problems.length ? 'FAIL' : 'PASS', file: contract.file, why: contract.why, problems });
}

const failed = results.filter(row => row.status === 'FAIL');
if (asJson) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
} else {
  for (const row of results) {
    console.log(`${row.status === 'PASS' ? 'PASS' : 'FAIL'}  ${row.id}${row.file ? `  (${row.file})` : ''}`);
    for (const problem of row.problems ?? []) console.log(`      - ${problem}`);
  }
  console.log(`\n# ${results.length - failed.length} / ${results.length} 条契约成立${failed.length ? `，${failed.length} 条被覆盖或回退` : ''}`);
}
process.exit(failed.length ? 1 : 0);
