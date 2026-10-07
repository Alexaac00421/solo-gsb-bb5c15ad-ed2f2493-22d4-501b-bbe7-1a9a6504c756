'use strict';

// 单点挂牌失效风险(SPOF)分析 —— 只读诊断, 不触碰数据库。
//
// 操作员关心的问题: “如果某一个已挂牌开关的挂牌失效(不再阻断供电),
// 哪些有效检修许可会重新出现未切断通路?”
//
// 规则(与既有隔离判定完全一致):
//   - 对当前每一个已挂牌开关, 分别假设它不再阻断供电(仅在内存克隆上摘掉挂牌),
//     其余开关状态与供电图保持原状;
//   - 在该假设图上用完整可达性分析(findReachableTarget, 多源 BFS, 无数量/长度
//     上限)判断每个所查许可的目标设备是否重新带电 —— 不受诊断路径展示上限影响;
//   - 带电即记一项风险, 并附 BFS 见证路径(一条真实带电路径)。
//
// 由于有效许可在当前状态下必然隔离(变更保护维持的不变量), 假设图中新出现的
// 带电路径必然经过被假设失效的那个开关, 因此见证路径一定穿过该开关。
//
// 输入的 graph / permits 不会被修改; 路径用传入的当前状态图序列化,
// 节点名称/挂牌标记均为同一次快照下的真实状态。

const { findReachableTarget, serializePath } = require('./graph');

/**
 * 生成单点挂牌失效风险报告的核心数据。
 * @param {Object} graph loadGraph() 风格的完整供电图(同一次当前状态快照)
 * @param {Array} permits 待检查的有效许可(全部或按编号筛选后的子集)
 * @returns {{ switches: Array, riskCount: number }}
 *   switches 按开关编号升序; 每项:
 *     { node_id, name, open_pos, tagged, riskCount, risks }
 *   risks 按许可编号升序; 每项:
 *     { permit_id, device_id, device_name, livePath }
 *   livePath 为 serializePath 后的真实带电路径(假设该开关失效时)。
 *   没有待检查许可时返回空报告({ switches: [], riskCount: 0 })。
 */
function buildSpofReport(graph, permits) {
  const checked = [...permits].sort((a, b) => a.id - b.id);
  if (checked.length === 0) return { switches: [], riskCount: 0 };

  const taggedSwitches = graph.nodes
    .filter((n) => n.kind === 'switch' && n.tagged)
    .sort((a, b) => a.id - b.id);

  let riskCount = 0;
  const switches = taggedSwitches.map((sw) => {
    // 假设该开关不再阻断供电: 只在内存克隆上摘掉挂牌, 真实状态不变。
    const nodeById = new Map(graph.nodes.map((n) => [
      n.id, n.id === sw.id ? { ...n, tagged: false } : n
    ]));
    const hypo = { nodes: [...nodeById.values()], nodeById, outAdj: graph.outAdj };

    const risks = [];
    for (const p of checked) {
      const r = findReachableTarget(hypo, p.device_id);
      if (r.reachable) {
        risks.push({
          permit_id: p.id,
          device_id: p.device_id,
          device_name: p.device_name,
          // 完整可达性分析的 BFS 见证路径: 真实带电路径, 不受诊断展示上限影响
          livePath: serializePath(graph, r.witness)
        });
      }
    }
    riskCount += risks.length;
    return {
      node_id: sw.id,
      name: sw.name,
      open_pos: !!sw.open_pos,
      tagged: true,
      riskCount: risks.length,
      risks
    };
  });

  return { switches, riskCount };
}

module.exports = { buildSpofReport };
