import test from 'node:test';
import assert from 'node:assert/strict';
import {relevantPassages} from '../src/retrieval-excerpt.js';
test('automatic reads locate matching passages beyond unrelated diary prefix',()=>{
  const body='视频制作旧记录。'.repeat(700)+'SQLITE_BUSY requires short write transactions and busy_timeout.';
  const result=relevantPassages(body,'SQLITE_BUSY busy_timeout');
  assert.ok(result.length);assert.match(result.map(p=>p.text).join(''),/SQLITE_BUSY/);
  assert.ok(result[0]!.offset>3000);
  for(const p of result)assert.equal(body.slice(p.offset,p.offset+p.text.length),p.text);
});
test('unknown terms do not manufacture a matching passage',()=>assert.deepEqual(relevantPassages('面包发酵记录','TLS CERT_HAS_EXPIRED'),[]));
