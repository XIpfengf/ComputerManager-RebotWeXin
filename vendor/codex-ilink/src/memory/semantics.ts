function normalize(text: string): string { return text.replace(/白米饭|大米饭|大米/u, "米饭").replace(/[\s，。！？,.!?]/gu, ""); }
export function semanticKey(text: string): string {
  const value = normalize(text);
  if (/(?:回复|回答|说话)/u.test(value) && /简短|简洁|简明|少说|短一点|详细|展开|长一点|啰嗦/u.test(value)) return "response-length";
  const preference = /^我(?:不喜欢|喜欢|不爱|偏好)(.+)$/u.exec(value);
  return preference ? `preference:${preference[1]}` : `statement:${value}`;
}
export function semanticValue(text: string): string {
  if (semanticKey(text) === "response-length") return /不(?:要|想|喜欢).*(?:简短|简洁)|详细|展开|长一点/u.test(text) ? "long" : "short";
  return /我不(?:喜欢|爱)/u.test(text) ? "negative" : normalize(text).replace(/^我(?:喜欢|偏好)/u, "");
}
export function relevantMemory(content: string, query?: string): boolean {
  if (query === undefined || /记得|偏好|记忆|约定|以前/u.test(query)) return true;
  query = normalize(query);
  const domains = [/吃|食物|米饭|面条|晚饭|午饭|早餐|餐|菜/u, /回复|回答|简短|简洁|详细|啰嗦|说话|答案/u, /生日|出生|庆生/u];
  for (const domain of domains) if (domain.test(query) && domain.test(content)) return true;
  const normalized = normalize(content).replace(/^我(?:不喜欢|喜欢|偏好|希望|决定|约定|的)/u, "");
  return normalized.length >= 2 && [...query].some((_, i, chars) => i + 1 < chars.length && normalized.includes(chars.slice(i, i + 2).join("")));
}

export function retrievalTerms(query?: string): string[] | null {
  if (query === undefined) return null;
  const value = normalize(query.slice(0, 256));
  const domains = [
    [/吃|食物|米饭|面条|晚饭|午饭|早餐|餐|菜/u, ["吃", "食物", "米饭", "大米", "面条", "饭", "餐", "菜"]],
    [/回复|回答|简短|简洁|详细|啰嗦|说话|答案/u, ["回复", "回答", "简短", "简洁", "详细", "啰嗦", "说话", "答案"]],
    [/生日|出生|庆生/u, ["生日", "出生", "庆生"]],
  ] as const;
  const terms = domains.flatMap(([pattern, words]) => pattern.test(value) ? [...words] : []);
  if (terms.length) return [...new Set(terms)];
  if (!terms.length && /记得|偏好|记忆|约定|以前/u.test(value)) return null;
  const chars = [...value];
  return [...new Set([...terms, ...chars.slice(0, 64).flatMap((_, i) => i + 1 < chars.length ? [chars.slice(i, i + 2).join("")] : [])])];
}

export function semanticFamily(text: string): string {
  const families = [
    ["food", /吃|食物|米饭|大米|面条|饭|菜/u],
    ["expression", /回复|回答|说话|啰嗦|简短|简洁|简明|少说|答案/u],
    ["birthday", /生日|出生|庆生/u],
  ] as const;
  const matches = families.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0]![0] : "unknown";
}
