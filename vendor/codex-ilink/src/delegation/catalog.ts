export function selectDelegationTargets(entries:readonly {id:string;title:string}[],selector:string):Array<{id:string;title:string}>{
 const key=selector.toLocaleLowerCase();
 const matches=[...new Map(entries.filter(t=>t.title.toLocaleLowerCase().includes(key)).map(t=>[t.id,t])).values()];
 // A real exact title outranks previews that merely quote a delegation request.
 const exact=matches.filter(t=>t.title.toLocaleLowerCase()===key);
 return exact.length?exact:matches;
}


export type DelegationTarget = { id: string; title: string; updatedAt?: number; createdAt?: number };
type CatalogPage = { data: unknown[]; nextCursor: string | null };
type CatalogReader = (search: string, cursor?: string, cwd?: string) => Promise<CatalogPage>;

/** Project queries are bounded metadata listings; ownership is still enforced by DelegationService. */
export async function resolveDelegationTargets(
  selector: string,
  projects: readonly { name: string; cwd: string }[],
  read: CatalogReader,
  matchTopic = false,
): Promise<DelegationTarget[]> {
  const key = selector.trim().replaceAll("/", "\\").replace(/\\+$/u, "").toLocaleLowerCase();
  const project = key ? projects.filter(p => p.name.toLocaleLowerCase() === key || p.cwd.replaceAll("/", "\\").replace(/\\+$/u, "").toLocaleLowerCase() === key || p.cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1)?.toLocaleLowerCase() === key) : [];
  if (project.length > 1) throw Error("项目名称不唯一，请明确选择项目。");
  const targets: DelegationTarget[] = [];
  const collect = (page: CatalogPage): void => {
    for (const value of page.data) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const t = value as Record<string, unknown>;
      if (typeof t.id !== "string") continue;
      targets.push({ id: t.id, title: String(t.name ?? t.preview ?? ""), ...(typeof t.updatedAt === "number" ? { updatedAt: t.updatedAt } : {}), ...(typeof t.createdAt === "number" ? { createdAt: t.createdAt } : {}) });
    }
  };
  if (project.length === 1) {
    collect(await read("", undefined, project[0]!.cwd));
    return targets;
  }
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await read(selector, cursor); collect(page);
    if (!page.nextCursor) {
      const titleMatches = selectDelegationTargets(targets, selector);
      // Desktop search can match the topic/preview while the saved title is
      // different. Offer those results for inspection, never to select a write
      // target on the basis of the topic alone.
      return titleMatches.length || !matchTopic
        ? titleMatches
        : [...new Map(targets.map(t => [t.id, t])).values()];
    }
    if (seen.has(page.nextCursor)) throw Error("会话列表分页重复，未确认完整结果。");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw Error("会话列表尚未检索完整，请提供目标ID。");
}
