/**
 * 术语桥（term bridge）：从条目本身抽出「别人会怎么找它」。
 *
 * **为什么需要它。** 检索是词法的（中文按重叠二元组、英文按词），而人不会用库里的措辞
 * 提问。实测的病：库里 173 条条目，**173 条没有任何桥字段**；用户说"我装插件之前存进去
 * 的那些技能和规范"，而那条的标题是别的词，于是检索回执 `matched=0`、`gaps` 一堆，
 * agent 就"听不懂"了。这不是模型笨，是**库里没有可对上的术语**。
 *
 * **它不做什么。** 只服务检索。别名与关键词都不参与权限、门禁、判定与采纳——和 `labels`
 * 同一条纪律：只用来找东西。所以这个文件里没有任何"决定"，只有"怎么找"。
 *
 * **两个来源，先规则后模型。** 这里实现的是**规则**部分：离线、确定、可复算，装完就能用。
 * 模型归纳（让 agent 读条目后写出用户可能的说法）是更强的补充，但它是可选的、需要模型可用，
 * 所以走单独的路径，并且**只在规则版没覆盖时才有价值**——顺序反过来的话，一次模型不可用就
 * 会让整个桥消失。
 */

/** 中文虚词、通用动词与项目管理词：出现在几乎每条里，因此不含检索信息。 */
export const TERM_STOPWORDS = new Set([
  '需要', '使用', '进行', '可以', '这个', '那个', '当前', '一个', '我们', '你们', '他们',
  '任务', '经验', '检查', '继续', '主动', '问题', '结果', '原因', '方法', '步骤', '情况',
  '时候', '如果', '因为', '所以', '但是', '而且', '并且', '以及', '或者', '不是', '没有',
  '就是', '这样', '那样', '什么', '怎么', '为什么', '哪些', '已经', '还在', '还是', '只是',
  '应该', '必须', '不要', '不能', '不会', '可能', '确实', '其实', '另外', '同时', '然后',
  '第一', '第二', '第三', '注意', '说明', '结论', '证据', '适用', '不适用', '判据',
  'and', 'the', 'for', 'with', 'that', 'this', 'from', 'not', 'are', 'was', 'were',
  'but', 'you', 'your', 'its', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
]);

/**
 * 概念组：**同一件事的各种说法**。任一组员真的出现在条目里，整组都成为该条目的别名。
 *
 * 为什么必须是"组"而不是"中英对照表"：实测撞到的失败正是这个形状——用户问
 * 「我以前写下的那些规矩」，库里那 4 条 norm 的标题写的是「规范」，于是检索
 * `matched=0`、agent"听不懂"。**"规矩"与"规范"是同一个东西的两种说法，而词法检索看不见
 * 这层关系**；只补中英对照救不了它。
 *
 * 边界：这张表**只该放这个项目真实会撞上的说法**，不该长成通用同义词典——每多一个泛词，
 * 就多一分"任何查询都命中一堆无关条目"的风险（术语调研里明确警告过：tags/keywords 这类
 * 粗召回手段**不能替代专名映射**）。真正个性化的说法由模型归纳或用户纠正来补（见文件头）。
 */
const CONCEPT_GROUPS: string[][] = [
  ['规范', '规则', '规矩', '准则', '要求', 'norm', 'norms', 'rule', 'rules'],
  ['技能', 'skill', 'skills'],
  ['经验', 'memory', 'memories', '教训', '踩坑', '心得'],
  ['流程', 'workflow', 'workflows', '工序', '做法', '步骤'],
  ['日记', 'journal', 'diary', '日志'],
  ['材料', 'material', 'reference', '资料', '参考'],
  ['知识库', 'knowledge', 'library', '记忆库', '库'],
  ['检索', 'search', 'retrieval', '查询', '搜'],
  ['安装', 'install', 'setup', '部署', 'deploy'],
  ['卸载', 'uninstall', 'remove'],
  ['插件', 'plugin', 'adapter', '适配器'],
  ['核心', 'core', 'service', '服务'],
  ['凭据', 'credential', 'token', '密钥', '口令'],
  ['版本', 'revision', 'version', '修订'],
  ['候选', 'candidate', '待审', '提案'],
  ['采纳', 'adopt', 'approve', '批准', '通过'],
  ['注入', 'inject', 'injection'],
  ['门禁', 'gate', '拦截', '拒绝'],
  ['图像', 'image', 'img', '图片'],
  ['视频', 'video'],
  ['剪辑', 'edit', 'editing'],
  ['训练', 'train', 'training', 'lora'],
  ['画布', 'canvas'],
  ['记忆', 'memory', '记住', 'remember'],
];

/** 中英对照扩展：库里有该组任一词，就把整组作为别名补上。 */
function bilingual(terms: string[]): string[] {
  const lowered = new Set(terms.map(term => term.toLowerCase()));
  const extra = new Set<string>();
  for (const group of CONCEPT_GROUPS) {
    if (group.some(word => lowered.has(word.toLowerCase()))) for (const word of group) extra.add(word);
  }
  return [...extra];
}

/** 提取中文词（连续汉字 ≥2 且非停用词）与英文/代码标识符。 */
function extractTerms(text: string): { han: string[]; latin: string[] } {
  const han: string[] = [];
  const latin: string[] = [];
  for (const match of String(text ?? '').matchAll(/[\p{Script=Han}]{2,}|[A-Za-z][A-Za-z0-9_.:-]{2,}/gu)) {
    const value = match[0];
    if (/^\p{Script=Han}/u.test(value)) {
      // 长串再切成 2-4 字的滑窗候选，让「本地知识库检索」也能贡献「知识库」「检索」
      if (value.length <= 6) han.push(value);
      else for (let i = 0; i + 2 <= value.length; i++) han.push(value.slice(i, i + 2));
    } else {
      latin.push(value.toLowerCase());
    }
  }
  return { han, latin };
}

/**
 * 频率排序，取前 N，去掉停用词与过短的噪声。
 *
 * 高频优先是有意的：一条两万字的技能里，"comfyui" 出现 40 次而某个偶然出现的词只出现 1 次，
 * 前者才是这条讲什么的证据。平手时按词本身排序，保证同一份输入永远得到同一份输出（可复算）。
 */
function topByFrequency(terms: string[], stop: Set<string>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const term of terms) {
    if (stop.has(term) || term.length < 2) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/** 标题的变体：去括号、去 Markdown 装饰、取冒号/破折号前的短语。 */
function titleVariants(title: string): string[] {
  const raw = String(title ?? '').trim();
  if (!raw) return [];
  const variants = new Set<string>();
  variants.add(raw);
  variants.add(raw.replace(/[（(][^）)]*[）)]/g, '').trim());
  variants.add(raw.replace(/^[#>\-*\s]+/, '').replace(/[*`_]/g, '').trim());
  for (const separator of [':', '：', '—', ' - ', '|']) {
    const head = raw.split(separator)[0]?.trim();
    if (head && head.length >= 2) variants.add(head);
  }
  return [...variants].filter(value => value.length >= 2 && value.length <= 2000);
}

/**
 * 从条目的正文里挑出结构化标识：路径、文件名、URL 主机、代码标识符。
 *
 * 这些词的价值在于**它们是用户会原样打出来的东西**——项目里的绝对路径、包名、函数名。
 * 规则频次排不出来它们（出现次数少），但它们命中率最高，所以单独抽、单独保底。
 */
function structuralTerms(body: string): string[] {
  const found = new Set<string>();
  for (const match of String(body ?? '').matchAll(/[A-Za-z]:\\[^\s"'`）)，。]+/g)) found.add(match[0]);
  for (const match of String(body ?? '').matchAll(/\bhttps?:\/\/[^\s"'`）)，。]+/g)) {
    found.add(match[0]);
    try { found.add(new URL(match[0]).hostname); } catch { /* 不是合法 URL 就只要原文 */ }
  }
  for (const match of String(body ?? '').matchAll(/\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+){1,4}\b/g)) {
    // 连字符/下划线的标识符：amb_read_knowledge、comfyui-mcp、wan-2.2
    if (match[0].length >= 6) found.add(match[0]);
  }
  for (const match of String(body ?? '').matchAll(/\b\S+\.(?:md|ts|mjs|cjs|js|py|json|yml|yaml|toml|ps1|cmd|sqlite)\b/gi)) {
    found.add(match[0]);
  }
  return [...found].slice(0, 24);
}

/**
 * 生成一条条目的术语桥。
 *
 * 返回 `{ aliases, keywords }`，两者都只用于检索。**空结果是允许的**：一条内容稀薄、
 * 没有可提取术语的条目不该被硬塞进一堆通用词——那会让它被任何查询命中，比搜不到更糟。
 */
export function buildTermBridge(input: {
  title?: string; body?: string; kind?: string;
  /** 调用方已知的结构化标识（如技能的 name、流程的 tags），优先于从正文猜。 */
  structured?: string[];
}): { aliases: string[]; keywords: string[] } {
  const title = String(input.title ?? '');
  const body = String(input.body ?? '');
  const stop = TERM_STOPWORDS;

  const fromTitle = extractTerms(title);
  const fromBody = extractTerms(body);

  // 关键词：标题术语优先（它最像"这条讲什么"），再用正文高频补齐。
  const keywords = [...new Set([
    ...fromTitle.han.filter(term => !stop.has(term)),
    ...fromTitle.latin.filter(term => !stop.has(term)),
    ...topByFrequency(fromBody.han, stop, 24),
    ...topByFrequency(fromBody.latin, stop, 24),
    ...(input.structured ?? []).flatMap(value => extractTerms(value).latin.concat(extractTerms(value).han)),
    ...structuralTerms(body),
  ])].filter(term => term.length >= 2 && term.length <= 200).slice(0, 60);

  // 别名：同一种东西的别的叫法。规则能给的只有"标题变体 + 中英对照 + 类别词"。
  const aliases = [...new Set([
    ...titleVariants(title),
    ...bilingual([...fromTitle.han, ...fromTitle.latin, ...keywords]),
    // 类别词本身也是别名：用户说"那条规范""我的技能"时，靠它把范围收窄到对应 kind。
    ...(input.kind ? [input.kind] : []),
  ])].filter(term => term.length >= 2 && term.length <= 200).slice(0, 40);

  return { aliases, keywords };
}
