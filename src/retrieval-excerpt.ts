/** Return original, located passages; never present an unrelated document prefix as a match. */
function rankedPassages(body: string, query: string, maxCount = Infinity) {
  const words=query.toLowerCase().match(/[a-z0-9_.:-]{3,}|[\p{Script=Han}]+/gu)??[];
  const terms=[...new Set(words.flatMap(word=>/\p{Script=Han}/u.test(word)?Array.from({length:Math.max(1,word.length-1)},(_,i)=>word.slice(i,i+2)):[word]))]
    .filter(word=>!['需要','使用','进行','可以','这个','当前','一个','我们','任务','经验','检查','继续','主动'].includes(word));
  if(!terms.length)return [];
  const windows=[];
  for(let offset=0;offset<body.length;offset+=320){
    const text=body.slice(offset,offset+800),lower=text.toLowerCase();
    const matched=terms.filter(term=>lower.includes(term));
    if(matched.length) windows.push({offset,text,score:matched.reduce((n,term)=>n+Math.min(term.length,12),0)});
  }
  windows.sort((a,b)=>b.score-a.score||a.offset-b.offset);
  const selected:typeof windows=[];
  for(const window of windows){
    if(selected.some(other=>Math.abs(other.offset-window.offset)<800))continue;
    selected.push(window);
    if (selected.length >= maxCount) break;
  }
  return selected;
}

export function relevantPassages(body: string, query: string, budget = 2400) {
  return rankedPassages(body, query, Math.max(1, Math.ceil(budget / 800)))
    .sort((a,b)=>a.offset-b.offset).map(({offset,text})=>({offset,text}));
}

/** Pagination is over ranked, non-overlapping windows; not over the whole document. */
export function passagePage(body: string, query: string, offset = 0, limit = 3) {
  const all = rankedPassages(body, query);
  const passages = all.slice(offset, offset + limit).sort((a,b)=>a.offset-b.offset)
    .map(({offset,text})=>({offset,text}));
  const hasMore = offset + passages.length < all.length;
  return { passages, total: all.length, offset, hasMore,
    nextOffset: hasMore ? offset + passages.length : null };
}
