'use strict';

// src/spof.js 的单点挂牌失效风险分析单元测试(不走 HTTP / 数据库)。
// 重点: 假设单个已挂牌开关失效后的完整可达性判定、真实带电见证路径、
// 开关/许可稳定排序、无风险开关同样列出、空许可集 -> 空报告、
// 不依赖诊断枚举的数量/长度上限、输入不被修改。
// 运行: node test/spof.test.js

const assert = require('assert');
const { buildSpofReport } = require('../src/spof');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✔', msg);
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg} (期望 ${b}, 实际 ${a})`);
  pass++;
  console.log('  ✔', msg);
}

// 与 graph.test.js / advisor.test.js 同构的内存图构造。
// nodes: [[id, kind, {enabled?, open_pos?, tagged?}], ...]
// edges: [[id, from, to], ...]
function buildGraph(nodeSpecs, edgeSpecs) {
  const nodes = nodeSpecs.map(([id, kind, extra = {}]) => ({
    id, kind, name: `N${id}`,
    enabled: extra.enabled !== undefined ? !!extra.enabled : true,
    open_pos: !!extra.open_pos,
    tagged: !!extra.tagged
  }));
  const edges = edgeSpecs.map(([id, from, to]) => ({
    id, from, to, from_node: from, to_node: to
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from_node)) outAdj.set(e.from_node, []);
    outAdj.get(e.from_node).push(e);
  }
  return { nodes, edges, nodeById, outAdj };
}

function permit(id, deviceId, name) {
  return { id, device_id: deviceId, device_name: name || `D${deviceId}`, status: 'active' };
}

// 演示网络: S1(1)->K1(3)->K3(5)->D1(6); S2(2)->K2(4)->K3(5); K1(3)->D2(7)
function demoGraph(taggedIds) {
  return buildGraph(
    [[1, 'source'], [2, 'source'],
     [3, 'switch', { open_pos: true, tagged: taggedIds.includes(3) }],
     [4, 'switch', { open_pos: true, tagged: taggedIds.includes(4) }],
     [5, 'switch', { open_pos: true, tagged: taggedIds.includes(5) }],
     [6, 'device'], [7, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 5], [4, 4, 5], [5, 5, 6], [6, 3, 7]]
  );
}

console.log('\n[S1] 演示网络: K1/K2 各挂一牌保护 D1 -> 两个开关各自都是单点风险');
{
  const g = demoGraph([3, 4]);
  const before = JSON.stringify(g);
  const r = buildSpofReport(g, [permit(1, 6)]);
  eq(r.switches.length, 2, '两个已挂牌开关都列出');
  eq(r.switches[0].node_id, 3, '按开关编号升序: 先是 K1');
  eq(r.switches[1].node_id, 4, '再是 K2');
  eq(r.riskCount, 2, '共 2 项风险');
  eq(r.switches[0].risks[0].permit_id, 1, 'K1 失效 -> 许可 #1 失去隔离');
  const p1 = r.switches[0].risks[0].livePath;
  eq(p1.nodes[0].id, 1, 'K1 失效后的带电路径从 1#电源出发');
  eq(p1.nodes[p1.nodes.length - 1].id, 6, '路径到达设备 D1');
  ok(p1.nodes.some((n) => n.id === 3), '路径穿过被假设失效的 K1');
  eq(r.switches[1].risks[0].livePath.nodes[0].id, 2, 'K2 失效后的路径从 2#电源出发');
  eq(JSON.stringify(g), before, '输入图未被修改');
}

console.log('\n[S2] 串联双挂牌: 任一开关单独失效仍被另一开关阻断 -> 均列为无单点风险');
{
  // S1->K1->K3->D1, K1 与 K3 都已挂牌(双保险)
  const g = buildGraph(
    [[1, 'source'],
     [3, 'switch', { open_pos: true, tagged: true }],
     [5, 'switch', { open_pos: true, tagged: true }],
     [6, 'device']],
    [[1, 1, 3], [2, 3, 5], [3, 5, 6]]
  );
  const r = buildSpofReport(g, [permit(1, 6)]);
  eq(r.switches.length, 2, '两个已挂牌开关都列出');
  eq(r.riskCount, 0, '无风险');
  ok(r.switches.every((s) => s.riskCount === 0 && s.risks.length === 0),
    '每项都显式给出空 risks(无单点风险)');
}

console.log('\n[S3] 多许可: 风险按许可编号升序; 开关只影响其下游许可');
{
  const g = demoGraph([3, 4]); // K1,K2 挂牌; D1 由 K1/K2 保护, D2 由 K1 保护
  const r = buildSpofReport(g, [permit(2, 7), permit(1, 6)]); // 乱序传入
  const k1 = r.switches.find((s) => s.node_id === 3);
  const k2 = r.switches.find((s) => s.node_id === 4);
  eq(k1.risks.length, 2, 'K1 失效影响两张许可');
  eq(k1.risks[0].permit_id, 1, '风险按许可编号升序: 先 #1');
  eq(k1.risks[1].permit_id, 2, '再 #2');
  eq(k1.risks[1].device_id, 7, '许可 #2 目标是 D2');
  eq(k2.risks.length, 1, 'K2 失效只影响 D1 的许可');
  eq(k2.risks[0].permit_id, 1, 'K2 -> 许可 #1');
  eq(r.riskCount, 3, '共 3 项风险');
}

console.log('\n[S4] 只检查筛选后的许可子集');
{
  const g = demoGraph([3, 4]);
  const r = buildSpofReport(g, [permit(2, 7)]); // 只查 D2 的许可
  const k1 = r.switches.find((s) => s.node_id === 3);
  const k2 = r.switches.find((s) => s.node_id === 4);
  eq(k1.risks.length, 1, 'K1 失效影响许可 #2');
  eq(k2.riskCount, 0, 'K2 与许可 #2 无关 -> 无单点风险(仍列出)');
}

console.log('\n[S5] 无待检查许可 -> 空报告; 无已挂牌开关 -> 空开关列表');
{
  const g = demoGraph([3, 4]);
  const r = buildSpofReport(g, []);
  eq(r.switches.length, 0, '空许可集 -> 空报告');
  eq(r.riskCount, 0, '风险数为 0');
  const r2 = buildSpofReport(demoGraph([]), [permit(1, 6)]);
  eq(r2.switches.length, 0, '没有已挂牌开关 -> 无开关条目');
  eq(r2.riskCount, 0, '风险数为 0');
}

console.log('\n[S6] 停用电源不产生路径; 分合位不影响判定(隔离只认挂牌)');
{
  // S1 停用, S2->K2->D1, K2 挂牌
  const g = buildGraph(
    [[1, 'source', { enabled: false }], [2, 'source'],
     [4, 'switch', { open_pos: true, tagged: true }], [6, 'device']],
    [[1, 1, 4], [2, 2, 4], [3, 4, 6]]
  );
  const r = buildSpofReport(g, [permit(1, 6)]);
  eq(r.riskCount, 1, 'K2 失效 -> 许可失去隔离');
  eq(r.switches[0].risks[0].livePath.nodes[0].id, 2, '带电路径来自启用电源 S2');
}

console.log('\n[S7] 超长链路(>64 节点): 完整可达性分析不受诊断展示上限影响');
{
  // S -> 70 个串联开关(第 35 个已挂牌) -> D; 假设该挂牌开关失效后,
  // 带电路径长达 72 个节点, 超过诊断展示 64 节点上限, 仍须给出真实见证路径。
  const nodeSpecs = [[1, 'source']];
  const edgeSpecs = [];
  const N = 70;
  for (let i = 0; i < N; i++) {
    nodeSpecs.push([10 + i, 'switch', i === 35 ? { open_pos: true, tagged: true } : {}]);
    edgeSpecs.push([i + 1, i === 0 ? 1 : 10 + i - 1, 10 + i]);
  }
  nodeSpecs.push([999, 'device']);
  edgeSpecs.push([N + 1, 10 + N - 1, 999]);
  const g = buildGraph(nodeSpecs, edgeSpecs);
  const r = buildSpofReport(g, [permit(1, 999)]);
  eq(r.switches.length, 1, '只有 1 个已挂牌开关');
  eq(r.riskCount, 1, '该开关失效 -> 许可失去隔离');
  const path = r.switches[0].risks[0].livePath;
  eq(path.nodes.length, N + 2, `见证路径含全部 ${N + 2} 个节点(超过 64 节点展示上限)`);
  eq(path.nodes[0].id, 1, '路径从电源出发');
  eq(path.nodes[path.nodes.length - 1].id, 999, '路径到达设备');
}

console.log('\n[S8] 含环图: 判定稳定且路径真实');
{
  // S1->K1->M1->D1, S1->K2->M1, M1->K1(环), K1/K2 挂牌
  const g = buildGraph(
    [[1, 'source'],
     [3, 'switch', { open_pos: true, tagged: true }],
     [4, 'switch', { open_pos: true, tagged: true }],
     [8, 'switch'], [6, 'device']],
    [[1, 1, 3], [2, 1, 4], [3, 3, 8], [4, 4, 8], [5, 8, 3], [6, 8, 6]]
  );
  const r = buildSpofReport(g, [permit(1, 6)]);
  eq(r.riskCount, 2, 'K1 或 K2 任一失效都会恢复供电');
  for (const s of r.switches) {
    const p = s.risks[0].livePath;
    eq(p.nodes[0].id, 1, '路径从电源出发');
    eq(p.nodes[p.nodes.length - 1].id, 6, '路径到达设备');
    ok(p.nodes.some((n) => n.id === s.node_id), '路径穿过被假设失效的开关');
  }
}

console.log(`\n结果: ${pass} 项断言全部通过`);
