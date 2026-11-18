// The waits of the ledger as a graph of tickets: a ticket that waits for another (an explicit dependency, or a same-files wait in force) is an edge.
// Nodes are "repo#n" (the repository in lower case). Only waiting jobs have edges, so the graph is read from the ledger: no forge read.
import type { Job } from '../types.ts';

export type WaitGraph = Map<string, Set<string>>;

// The ticket of a job: its repository and issue number.
export function ticketKey(job: Job): string {
  return job.event.repository.full_name.toLowerCase() + '#' + job.event.issue.number;
}

// The waits of the waiting jobs: the explicit dependencies always, the same-files waits in force when `files` is set.
export function waitGraph(jobs: Job[], files: boolean): WaitGraph {
  const graph: WaitGraph = new Map();
  for (const job of jobs) {
    if (job.status !== 'waiting' || job.waiting_for_run || job.event.bot || job.event.pull_request) continue;
    const targets = [...(job.waiting_for ?? []), ...(files ? job.waiting_for_files ?? [] : [])];
    if (!targets.length) continue;
    const repository = job.event.repository.full_name.toLowerCase();
    const from = ticketKey(job);
    const edges = graph.get(from) ?? new Set<string>();
    for (const number of targets) edges.add(repository + '#' + number);
    graph.set(from, edges);
  }
  return graph;
}

// The cycles of the graph (strongly connected parts with a way back), each as the walk of its tickets that returns to the first one.
export function findCycles(graph: WaitGraph): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || graph.get(node)?.has(node)) components.push(component);
    }
  };
  for (const node of [...graph.keys()].sort()) if (!index.has(node)) connect(node);
  return components.map((component) => walkIn(graph, component));
}

// The shortest walk from the smallest ticket of a component back to it, through the component's tickets only.
function walkIn(graph: WaitGraph, component: string[]): string[] {
  const members = new Set(component);
  const start = [...component].sort()[0];
  if (graph.get(start)?.has(start)) return [start, start];
  const parent = new Map<string, string>();
  const seen = new Set([start]);
  const queue = [start];
  let closing: string | undefined;
  for (let i = 0; i < queue.length && closing === undefined; i += 1) {
    const node = queue[i];
    for (const next of graph.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) { closing = node; break; }
      if (!seen.has(next)) { seen.add(next); parent.set(next, node); queue.push(next); }
    }
  }
  const chain = [closing!];
  while (chain[0] !== start) chain.unshift(parent.get(chain[0])!);
  return [...chain, start];
}

// The line about a cycle: "dependency cycle: #a -> #b -> #a (owner/hello)".
export function cycleText(walk: string[]): string {
  const repository = walk[0].split('#')[0];
  return 'dependency cycle: ' + walk.map((key) => '#' + key.split('#')[1]).join(' -> ') + ' (' + repository + ')';
}
