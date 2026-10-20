/**
 * 工作类别（domain）：受控词表与规则推断。
 *
 * 为什么需要它：`kind` 回答"这条是什么"（规范/技能/经验/日记），`scope` 回答"管多大范围"，
 * 但两者都不回答"这条讲的是哪摊事"。用户要在 900 条里找"插件装卸相关的坑"，靠的既不是
 * kind 也不是 scope，而是工作类别。没有这一层，检索只能靠词面碰运气。
 *
 * 纪律（来自整理批次与评审）：
 * 1. 词表**受控**：新增域要有定义、反例、别名与负责人，不允许 agent 自造。这里只放首批。
 * 2. 推断**只做建议**：写进条目时标 `domainSource: 'inferred'`，人改过的保持人的值。
 * 3. 推断**只做导航**：domain 不参与权限、门禁、采纳判定，只参与检索与统计。
 *
 * 规则版优先而不是模型版优先：模型不可用时不能整层消失；模型归纳是可选增强。
 */

export interface DomainDefinition {
  id: string;
  /** 中文名，用于展示与人工核对。 */
  label: string;
  /** 判定这条属于本域的典型说法。命中越多分越高。 */
  cues: string[];
  /** 反例：出现这些说法时不该算本域（避免"测试"把一切都吸进 code-change）。 */
  notWhen?: string[];
}

export const DOMAINS: DomainDefinition[] = [
  { id: 'retrieval-knowledge', label: '检索与记忆库',
    cues: ['检索', '召回', '知识库', '记忆', '注入', '索引', '召回率', '向量', 'embedding', 'retrieval', 'recall', 'knowledge', 'memory', 'injection', 'index', 'fts', 'rank'] },
  { id: 'host-runtime', label: '宿主运行时',
    cues: ['宿主', '插件装载', 'adapter', '适配器', 'hook', '运行时', '会话', 'session', 'dsh', 'codex', '重启', '进程', 'pid'] },
  { id: 'plugin-ops', label: '插件安装与部署',
    cues: ['安装', '卸载', '部署', '打包', 'pack', 'deploy', 'uninstall', 'install', 'marketplace', '版本升级', '回滚', 'rollback'] },
  { id: 'code-change', label: '代码改动与测试',
    cues: ['重构', '函数', '接口', '类型', '编译', '测试', '断言', '单测', 'tsc', 'refactor', 'compile', 'test', 'assert', 'typescript', 'bug', '修复'] },
  { id: 'network-proxy', label: '网络与代理',
    cues: ['代理', '网关', '端口', 'tun', 'socks', 'proxy', 'gateway', 'port', 'dns', '证书', 'tls', '超时', 'timeout', '限流', 'rate limit'] },
  { id: 'model-routing', label: '模型与路由',
    cues: ['模型', '路由', '额度', '上下文窗口', 'model', 'route', 'quota', 'token', 'claude', 'gpt', 'gemini', 'deepseek', 'provider'] },
  { id: 'media-generation', label: '图像与视频生成',
    cues: ['生图', '出图', '视频生成', '首帧', '尾帧', '参考图', 'lora', 'comfyui', 'image', 'video', 'seedance', 'wan', 'flux', 'z-image', '画布', 'canvas'] },
  { id: 'short-drama', label: '短剧与剧本',
    cues: ['短剧', '剧本', '分镜', '台词', '角色卡', '场景图', '剧集', 'storyboard', 'script', 'drama'] },
  { id: 'browser-automation', label: '浏览器与抓取',
    cues: ['浏览器', '抓取', '爬取', '登录态', 'cdp', 'playwright', 'puppeteer', 'chrome', 'browser', 'scrape', 'cookie'] },
  { id: 'docs-governance', label: '文档与规范治理',
    cues: ['文档', '规范', '交接', '台账', '治理', 'doc', 'spec', 'handoff', 'changelog', 'readme', 'adr'] },
  { id: 'data-recovery', label: '数据迁移与恢复',
    cues: ['迁移', '备份', '恢复', '快照', '数据库', 'sqlite', 'migrate', 'backup', 'restore', 'snapshot', 'integrity'] },
  { id: 'security-audit', label: '安全与权限',
    cues: ['安全', '权限', '越权', '审计', '凭据', '密钥', '注入攻击', 'security', 'permission', 'auth', 'credential', 'secret', 'admin'] },
];

/** 单个域的最低命中分：低于它不猜。 */
const MIN_SCORE = 2;
/** 最高分与次高分之差低于它时视为并列，返回 undefined（宁可不猜）。 */
const MIN_MARGIN = 1;

export interface DomainInference {
  domain?: string;
  score: number;
  runnerUp?: string;
  runnerUpScore: number;
  /** 为什么是这个域：命中的线索词，供人工核对。 */
  cues: string[];
  source: 'inferred';
}

/**
 * 从文本推断工作类别。确定性、可复算、无模型依赖。
 *
 * 只做建议：返回 `undefined` 比返回一个错的域更有用——错域会把条目塞进错的导航，
 * 而空域至少还能靠词面检索找到。
 */
export function inferDomain(text: string): DomainInference {
  const haystack = String(text ?? '').toLowerCase();
  const scored = DOMAINS.map(definition => {
    const cues = definition.cues.filter(cue => haystack.includes(cue.toLowerCase()));
    const penalty = (definition.notWhen ?? []).some(cue => haystack.includes(cue.toLowerCase())) ? 1 : 0;
    return { id: definition.id, score: cues.length - penalty, cues };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < MIN_SCORE) return { score: best?.score ?? 0, runnerUpScore: second?.score ?? 0, cues: [], source: 'inferred' };
  if (second && best.score - second.score < MIN_MARGIN) {
    return { score: best.score, runnerUp: second.id, runnerUpScore: second.score, cues: best.cues, source: 'inferred' };
  }
  return { domain: best.id, score: best.score, runnerUp: second?.id, runnerUpScore: second?.score ?? 0, cues: best.cues, source: 'inferred' };
}

/** 词表校验：写入口只接受已知域，未知域一律拒绝（防止标签垃圾场）。 */
export function isKnownDomain(value: string): boolean {
  return DOMAINS.some(definition => definition.id === value);
}
