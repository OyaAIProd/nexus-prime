import type { WorkItem } from '../types.js';

export function topologicalSortWorkItems(items: WorkItem[]): WorkItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: WorkItem[] = [];

  function visit(item: WorkItem): void {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) return;
    visiting.add(item.id);
    item.dependsOn.forEach((dependencyId) => {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    });
    visiting.delete(item.id);
    visited.add(item.id);
    result.push(item);
  }

  items.forEach(visit);
  return result;
}
