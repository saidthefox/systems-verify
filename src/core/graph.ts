import type { CoreState } from "./types"

/**
 * Law 11e — the ladder, not the leap. Kind-of is transitive: a direct INSTANCE_OF whose
 * target is already reachable through other accepted INSTANCE_OF edges is redundant. The
 * DOOR refuses such a leap at filing; the EATING retires existing leaps when a new rung
 * completes a ladder. Deterministic: adjacency built in sorted act-id order, BFS queue FIFO.
 */

export type Adjacency = Map<string, { to: string; edgeId: string }[]>

export function instanceAdjacency(state: CoreState, skipEdgeId?: string): Adjacency {
  const adj: Adjacency = new Map()
  for (const id of Object.keys(state.acts).sort()) {
    const a = state.acts[id]
    if (a.kind !== "EDGE" || a.edgeType !== "INSTANCE_OF" || a.status !== "ACCEPTED" || a.id === skipEdgeId) continue
    const list = adj.get(a.fromEntryId!) ?? []
    list.push({ to: a.toEntryId!, edgeId: a.id })
    adj.set(a.fromEntryId!, list)
  }
  return adj
}

/** Remove one edge from an adjacency in place, preserving the order of every other entry —
 *  which is what keeps a maintained graph identical to a freshly rebuilt one. Used when an edge
 *  stops being a rung mid-pass (Law 11e subsumption). */
export function dropEdge(adj: Adjacency, fromEntryId: string, edgeId: string) {
  const list = adj.get(fromEntryId)
  if (!list) return
  const i = list.findIndex(l => l.edgeId === edgeId)
  if (i >= 0) list.splice(i, 1)
}

/** First intermediate entry ("the via rung") on a path start→target, or null when the leap
 *  is the best available claim. Cycle-guarded BFS, mirroring prod's findVia.
 *
 *  `skipEdgeId` excludes one edge from the walk. A caller asking "is my own edge redundant?"
 *  must not answer with itself, and it used to get that by rebuilding the whole adjacency
 *  without it — which is the same graph minus one entry, so skipping it here is equivalent and
 *  costs nothing. Omitting an edge at build time and refusing to traverse it are the same walk. */
export function ladderVia(adj: Adjacency, start: string, target: string, skipEdgeId?: string): string | null {
  const parent = new Map<string, string>()
  const queue = [start]
  const seen = new Set([start])
  while (queue.length) {
    const node = queue.shift()!
    for (const { to, edgeId } of adj.get(node) ?? []) {
      if (edgeId === skipEdgeId) continue
      if (seen.has(to)) continue
      parent.set(to, node)
      seen.add(to)
      if (to === target) {
        let hop = to
        while (parent.get(hop) !== start) hop = parent.get(hop)!
        return hop
      }
      queue.push(to)
    }
  }
  return null
}
