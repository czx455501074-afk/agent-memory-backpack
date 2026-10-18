/**
 * 分块读取：让 agent 能把长条目读完，而不是"看到很大就只读开头"。
 *
 * **为什么需要。** 实测：库里正文平均 7459 字符、最长 53117 字符（约 1.8 万 token）。
 * 而 `prepare` 只注入前 400 字符的 excerpt，`amb_read_knowledge` 一次给全文 —— 前者让 agent
 * 以为"就这些"，后者让它面对五万字而只读开头。Lost in the Middle（TACL 2024）实测：关键信息
 * 落在上下文中段时，召回会跌到 30% 以下；同类项目（Basic Memory PR #601）正是因此引入
 * `matched_chunk`，并把 `read_note` 改成按 `start_line`/`end_line` 分段、回执带 `has_more`。
 *
 * **切法为什么按标题。** 结构比长度重要：按字符硬切会把一条规则切成两半，两边都读不懂。
 * 有 Markdown 标题就按标题切；没有才退回字符窗口，并留少量重叠。
 *
 * **为什么不是"必须逐块读完才放行"。** 那会让一次排障变成十几轮往返。这里给的是
 * **带目录的跳读**：回执里带 `outline`（每块的标题与起始行），agent 能判断该读哪一块，
 * 只需确认"与当前问题相关的块已经读过"。这是"防漏"与"不拖垮回合"之间的取舍。
 */

export interface ChunkView {
  /** 本次返回的正文。 */
  text: string;
  /** 本块序号（0 起）与总块数。 */
  chunkIndex: number;
  totalChunks: number;
  /** 是否还有后面的块没给。 */
  hasMore: boolean;
  nextChunkIndex: number | null;
  /** 本块覆盖的行范围（1 起，含两端）与全文总行数。 */
  startLine: number;
  endLine: number;
  totalLines: number;
  /** 目录：每块的标题与起始行，用于跳读。 */
  outline: Array<{ index: number; heading: string; startLine: number }>;
  /** 给调用者的明确下一步（有未读时点名"还有几块"）。 */
  advisory: string;
}

/** 默认块大小：约 2400 字符。实测条目中位数 7459 字符，这个粒度约 3-4 块，跳读够用。 */
const DEFAULT_CHUNK_CHARS = 2400;

interface Segment {
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * 按 Markdown 标题切段；段太长时再按字符窗口切。
 *
 * 标题层级不细分（## 与 ### 同等对待）：目的只是"可跳读的块"，不是重建文档树。
 */
function segment(body: string, maxChars: number): Segment[] {
  const lines = String(body ?? '').split('\n');
  const segments: Segment[] = [];
  let current: { heading: string; startLine: number; lines: string[] } | null = null;
  const flush = (endLine: number) => {
    if (!current) return;
    const text = current.lines.join('\n');
    // 一个标题段落太长时，按字符窗口再切，保留 120 字符重叠以免把一句话拦腰截断。
    if (text.length <= maxChars) {
      segments.push({ heading: current.heading, startLine: current.startLine, endLine, text });
    } else {
      const overlap = 120;
      for (let offset = 0, index = 0; offset < text.length; index++) {
        const slice = text.slice(offset, offset + maxChars);
        const startLine = current.startLine + text.slice(0, offset).split('\n').length - 1;
        const endLineHere = startLine + slice.split('\n').length - 1;
        segments.push({
          heading: index === 0 ? current.heading : `${current.heading}（续 ${index}）`,
          startLine, endLine: endLineHere, text: slice,
        });
        offset += maxChars - overlap;
      }
    }
    current = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const isHeading = /^\s{0,3}#{1,6}\s+\S/.test(line);
    if (isHeading) {
      flush(index); // 上一段在本行之前结束
      current = { heading: line.replace(/^\s{0,3}#{1,6}\s+/, '').trim(), startLine: index + 1, lines: [line] };
      continue;
    }
    if (!current) current = { heading: '(开头)', startLine: index + 1, lines: [] };
    current.lines.push(line);
  }
  flush(lines.length);
  if (!segments.length) segments.push({ heading: '(空)', startLine: 1, endLine: Math.max(1, lines.length), text: '' });
  return segments;
}

/**
 * 取回一条长正文的某一块。
 *
 * 三种定位方式，优先级从高到低：`startLine`/`endLine`（精确行范围）→ `chunkIndex`（按块）
 * → 都不给则给第 0 块。**默认不返回全文**：一次给五万字正是要避免的事。
 */
export function chunkBody(body: string, options: { chunkIndex?: number; startLine?: number; endLine?: number; maxChars?: number } = {}): ChunkView {
  const text = String(body ?? '');
  const totalLines = text.split('\n').length;
  const segments = segment(text, options.maxChars ?? DEFAULT_CHUNK_CHARS);
  const outline = segments.map((item, index) => ({ index, heading: item.heading, startLine: item.startLine }));

  // 精确行范围：直接按行取，不参与分块编号（调用方已经知道要哪几行）。
  if (options.startLine !== undefined) {
    const lines = text.split('\n');
    const from = Math.max(1, Math.floor(options.startLine));
    const to = Math.min(lines.length, Math.floor(options.endLine ?? from + 200));
    const slice = lines.slice(from - 1, to).join('\n');
    return {
      text: slice, chunkIndex: -1, totalChunks: segments.length, hasMore: to < lines.length,
      nextChunkIndex: null, startLine: from, endLine: to, totalLines, outline,
      advisory: to < lines.length
        ? `本次按行返回 ${from}-${to} 行，共 ${lines.length} 行；还有 ${lines.length - to} 行未读，继续用 startLine=${to + 1} 取。`
        : `本次按行返回 ${from}-${to} 行，已到文末。`,
    };
  }

  const index = Math.max(0, Math.min(segments.length - 1, Math.floor(options.chunkIndex ?? 0)));
  const picked = segments[index]!;
  const remaining = segments.length - index - 1;
  return {
    text: picked.text,
    chunkIndex: index,
    totalChunks: segments.length,
    hasMore: remaining > 0,
    nextChunkIndex: remaining > 0 ? index + 1 : null,
    startLine: picked.startLine,
    endLine: picked.endLine,
    totalLines,
    outline,
    /**
     * 有未读就**明说还有几块、下一块是什么**——不写这句，回执看起来就像"已经给全了"，
     * 而这正是"agent 只读开头就动手"的成因之一。同类做法见 Roo Code 的截断提示。
     */
    advisory: remaining > 0
      ? `本次返回第 ${index + 1}/${segments.length} 块（${picked.heading}，${picked.startLine}-${picked.endLine} 行）。还有 ${remaining} 块未读`
        + `（下一块：${segments[index + 1]!.heading}）。上方的 outline 列出全部块，按需用 chunkIndex 取；`
        + `若本条目承载约束或检查项，先把与当前任务相关的块读完再动手。`
      : `本次返回第 ${index + 1}/${segments.length} 块（${picked.heading}），已是最后一块。`,
  };
}
