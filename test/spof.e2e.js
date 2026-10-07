'use strict';
// 单点挂牌失效风险报告端到端测试(HTTP)。
// 使用方式: LOTO_DB=/tmp/loto-spof-e2e.db PORT=3106 node server.js 后
//           BASE=http://127.0.0.1:3106 node test/spof.e2e.js
// 基于初始演示网络: S1(1)->K1(3)->K3(5)->D1(6); S2(2)->K2(4)->K3(5); K1(3)->D2(7)
const BASE = process.env.BASE || 'http://127.0.0.1:3106';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`); }

async function call(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const OP = { actor: '风险报告操作员', role: 'operator' };
const S1 = 1, S2 = 2, K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7;

async function spof(body) { return call('POST', '/api/spof/report', body || {}); }

(async () => {
  const rev0 = (await call('GET', '/api/state')).data.revision;
  console.log('初始修订号:', rev0);
  let rev = rev0;

  console.log('\n[P1] 无有效许可 -> 空报告(只读, 携带修订号)');
  let r = await spof();
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.kind, 'spof.report', 'kind 为 spof.report');
  eq(r.data.revision, rev0, '报告携带当前修订号');
  eq(r.data.permitCount, 0, '许可数 0');
  eq(r.data.switchCount, 0, '开关数 0');
  eq(r.data.riskCount, 0, '风险数 0');
  eq(r.data.switches.length, 0, '空开关列表');

  console.log('\n[P2] 筛选集合校验: 空组/重复/非正整数/非数字/非数组/非有效许可 -> 拒绝');
  r = await spof({ permit_ids: [] });
  eq(r.status, 400, '显式空组 -> 400');
  eq(r.data.error.code, 'PERMIT_IDS_REQUIRED', '错误码 PERMIT_IDS_REQUIRED');
  r = await spof({ permit_ids: [1, 1] });
  eq(r.status, 400, '重复编号 -> 400');
  eq(r.data.error.code, 'PERMIT_IDS_DUPLICATE', '错误码 PERMIT_IDS_DUPLICATE');
  eq(r.data.duplicate_ids.join(','), '1', '指出重复编号');
  r = await spof({ permit_ids: [-2] });
  eq(r.status, 400, '非正整数 -> 400');
  eq(r.data.error.code, 'INVALID_PERMIT_ID', '错误码 INVALID_PERMIT_ID');
  r = await spof({ permit_ids: ['x'] });
  eq(r.status, 400, '非数字 -> 400');
  r = await spof({ permit_ids: [1.5] });
  eq(r.status, 400, '非整数 -> 400');
  r = await spof({ permit_ids: 5 });
  eq(r.status, 400, '非数组 -> 400');
  r = await spof({ permit_ids: [999] });
  eq(r.status, 404, '不存在的许可 -> 404');
  eq(r.data.error.code, 'PERMIT_NOT_FOUND', '错误码 PERMIT_NOT_FOUND');
  eq(r.data.invalid_permit_ids.join(','), '999', '指出无效许可编号');

  console.log('\n[P3] 准备: K1/K2 分闸挂牌, 申请 D1/D2 两张许可');
  for (const [action, id] of [['open', K1], ['tag', K1], ['open', K2], ['tag', K2]]) {
    r = await call('POST', `/api/switches/${id}/${action}`, { ...OP, revision: rev });
    eq(r.status, 200, `开关 #${id} ${action} 成功`);
    rev = r.data.revision;
  }
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  eq(r.status, 200, 'D1 许可生效');
  rev = r.data.revision;
  const P1 = r.data.permit_id;
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D2 });
  eq(r.status, 200, 'D2 许可生效');
  rev = r.data.revision;
  const P2 = r.data.permit_id;

  console.log('\n[P4] 全量报告: K1 影响两张许可, K2 影响一张; 排序与真实路径');
  const auditBefore = (await call('GET', '/api/audit?limit=500')).data.logs.length;
  const stateBefore = JSON.stringify((await call('GET', '/api/state')).data);
  r = await spof();
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev, '报告携带当前修订号');
  eq(r.data.permitCount, 2, '检查 2 张许可');
  eq(r.data.permit_ids.join(','), `${P1},${P2}`, '许可编号升序');
  eq(r.data.switchCount, 2, '2 个已挂牌开关');
  eq(r.data.riskCount, 3, '共 3 项风险');
  eq(r.data.switches.map((s) => s.node_id).join(','), `${K1},${K2}`, '按开关编号升序');
  const k1 = r.data.switches[0];
  eq(k1.name, '进线开关K1', 'K1 名称');
  eq(k1.tagged, true, 'K1 当前挂牌');
  eq(k1.risks.map((x) => x.permit_id).join(','), `${P1},${P2}`, 'K1 风险按许可编号升序');
  const path1 = k1.risks[0].livePath;
  eq(path1.nodes[0].id, S1, 'K1 失效后 D1 的带电路径从 1#主电源出发');
  eq(path1.nodes[path1.nodes.length - 1].id, D1, '路径到达 D1');
  ok(path1.nodes.some((n) => n.id === K1), '路径穿过被假设失效的 K1');
  ok(path1.nodes.every((n) => n.kind && n.name), '路径节点含类型与名称');
  const path2 = k1.risks[1].livePath;
  eq(path2.nodes.map((n) => n.id).join(','), `${S1},${K1},${D2}`, 'K1 失效后 D2 路径 S1->K1->D2');
  eq(k1.risks[1].device_name, '2#引风机', '风险携带设备名');
  const k2 = r.data.switches[1];
  eq(k2.risks.length, 1, 'K2 失效只影响 D1 许可');
  eq(k2.risks[0].livePath.nodes[0].id, S2, 'K2 失效后路径从 2#备用电源出发');

  console.log('\n[P5] 报告只读: 修订号/审计/状态均不变');
  let cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev, '报告不推进修订号');
  eq(JSON.stringify(cur.data), stateBefore, '报告前后状态完全一致');
  eq((await call('GET', '/api/audit?limit=500')).data.logs.length, auditBefore, '报告不写审计');

  console.log('\n[P6] 许可筛选: 只查 P2; 显式乱序全集等价于省略');
  r = await spof({ permit_ids: [P2] });
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.permitCount, 1, '只检查 1 张许可');
  eq(r.data.permit_ids.join(','), String(P2), '只含 P2');
  eq(r.data.riskCount, 1, '只有 K1->P2 一项风险');
  eq(r.data.switches[0].risks.map((x) => x.permit_id).join(','), String(P2), 'K1 风险为 P2');
  eq(r.data.switches[1].risks.length, 0, 'K2 仍列出且无单点风险');
  r = await spof({ permit_ids: [P2, P1] });
  eq(r.data.permit_ids.join(','), `${P1},${P2}`, '显式全集在响应中升序');
  eq(r.data.riskCount, 3, '显式全集与省略等价');
  r = await spof({ permit_ids: [P1, 999] });
  eq(r.status, 404, '混入无效编号 -> 404');
  eq(r.data.invalid_permit_ids.join(','), '999', '指出无效编号');

  console.log('\n[P7] K3 也挂牌后: K1 仅对 D2 仍是单点, K2/K3 无单点风险');
  r = await call('POST', `/api/switches/${K3}/open`, { ...OP, revision: rev });
  rev = r.data.revision;
  r = await call('POST', `/api/switches/${K3}/tag`, { ...OP, revision: rev });
  rev = r.data.revision;
  r = await spof();
  eq(r.data.switchCount, 3, '3 个已挂牌开关都列出');
  eq(r.data.switches.map((s) => s.node_id).join(','), `${K1},${K2},${K3}`, '开关编号升序');
  const [s1, s2, s3] = r.data.switches;
  eq(s1.risks.map((x) => x.permit_id).join(','), String(P2), 'K1 失效仍威胁 D2 许可(K3 不保护 D2)');
  eq(s2.riskCount, 0, 'K2 失效被 K1/K3 冗余阻断 -> 无单点风险');
  eq(s3.riskCount, 0, 'K3 失效被 K1/K2 冗余阻断 -> 无单点风险');
  eq(r.data.riskCount, 1, '全报告仅 1 项风险');

  console.log('\n[P8] 结束许可后: 已结束许可编号不再有效; 全部结束 -> 空报告');
  r = await call('POST', `/api/permits/${P1}/end`, { ...OP, revision: rev });
  eq(r.status, 200, '结束 P1');
  rev = r.data.revision;
  r = await spof({ permit_ids: [P1] });
  eq(r.status, 404, '已结束许可 -> 404');
  eq(r.data.error.code, 'PERMIT_NOT_FOUND', '错误码 PERMIT_NOT_FOUND');
  r = await spof();
  eq(r.data.permitCount, 1, '只剩 P2 被检查');
  eq(r.data.riskCount, 1, 'K1->P2 仍是唯一风险');
  r = await call('POST', `/api/permits/${P2}/end`, { ...OP, revision: rev });
  eq(r.status, 200, '结束 P2');
  rev = r.data.revision;
  r = await spof();
  eq(r.data.permitCount, 0, '无有效许可');
  eq(r.data.switches.length, 0, '空报告(开关列表为空)');
  eq(r.data.riskCount, 0, '风险数 0');
  eq(r.data.revision, rev, '仍携带当前修订号');
  cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev, '全程报告未推进修订号');

  console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
