import type { SummaryVisual } from "./types";

export function literalVisualClause(point: string, text: string): boolean {
  const boundary = (character: string | undefined) => character === undefined || "，。！？；：,.!?;:".includes(character);
  let start = point.indexOf(text);
  while (start >= 0) {
    if (boundary(Array.from(point.slice(0,start).trimEnd()).at(-1))
      && boundary(Array.from(point.slice(start+text.length).trimStart())[0])) return true;
    start = point.indexOf(text,start+text.length);
  }
  return false;
}

export function literalVisualSequence(quote: string, labels: readonly string[]): boolean {
  let rest = quote;
  const distinct = new Set<string>();
  return labels.every((label, index) => {
    const start = rest.indexOf(label);
    if (start < 0 || distinct.has(label)) return false;
    const prefix = rest.slice(0, start);
    if (!(index === 0 ? /首先|先/ : /然后|随后|接着|最后|接下来|再/).test(prefix)) return false;
    distinct.add(label);
    rest = rest.slice(start + label.length);
    return true;
  });
}

export function validVisualDate(label: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label) || label.startsWith("0000")) return false;
  const date = new Date(`${label}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === label;
}

export function validSummaryVisual(value: unknown, points: readonly string[]): value is SummaryVisual {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["version", "kind", "items", "basis"].includes(key))
    || !("version" in value) || (value.version !== 1 && value.version !== 2)
    || !("kind" in value) || typeof value.kind !== "string"
    || !["overview", "comparison", ...(value.version === 2 ? ["flow", "timeline"] : [])].includes(value.kind)
    || !("items" in value) || !Array.isArray(value.items) || value.items.length < 2 || value.items.length > 4) return false;
  const distinct = new Set<string>();
  const labels: string[] = [];
  const items: unknown[] = value.items;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["label", "detail", "point"].includes(key))
      || !("label" in item) || typeof item.label !== "string"
      || !("detail" in item) || typeof item.detail !== "string"
      || !("point" in item) || typeof item.point !== "number"
      || !Number.isInteger(item.point) || item.point < 1 || item.point > points.length
      || Array.from(item.label).length < 2 || Array.from(item.label).length > 32
      || Array.from(item.detail).length < 4 || Array.from(item.detail).length > 96
      || /[\u0000-\u001f\u007f-\u009f]/u.test(item.label + item.detail)
      || !item.detail.includes(item.label) || !literalVisualClause(points[item.point - 1],item.detail)
      || distinct.has(item.detail)) return false;
    distinct.add(item.detail);
    labels.push(item.label);
  }
  if (value.kind === "timeline" && (!labels.every(validVisualDate)
    || labels.some((label,index) => index > 0 && label <= labels[index - 1]))) return false;
  const basis = "basis" in value ? value.basis : null;
  if (value.kind !== "flow") return basis == null;
  if (!basis || typeof basis !== "object" || Array.isArray(basis)
    || Object.keys(basis).some(key => !["point", "quote"].includes(key))
    || !("point" in basis) || typeof basis.point !== "number" || !Number.isInteger(basis.point)
    || basis.point < 1 || basis.point > points.length
    || !("quote" in basis) || typeof basis.quote !== "string"
    || Array.from(basis.quote).length < 4 || Array.from(basis.quote).length > 600
    || /[\u0000-\u001f\u007f-\u009f]/u.test(basis.quote)
    || points[basis.point - 1] !== basis.quote
    || !literalVisualSequence(basis.quote, labels)) {
    return false;
  }
  return true;
}

export function summaryLineCount(list: HTMLElement): number {
  return Array.from(list.children).reduce((total, item) => {
    const range = document.createRange();
    range.selectNodeContents(item);
    const lines = new Set(Array.from(range.getClientRects())
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => Math.round(rect.top * 2)));
    return total + lines.size;
  }, 0);
}

export function wrapVisualText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const character of Array.from(text)) {
    if (line && measure(line + character) > width) {
      const characters = Array.from(line);
      let split = characters.length;
      if (/^[，。！？；：、,.!?;:%）)\]】》」』”’]$/u.test(character)) {
        split--;
        while (split > 0 && /^[，。！？；：、,.!?;:%）)\]】》」』”’]$/u.test(characters[split])) split--;
      }
      while (split > 0 && /^[（(\[【《「『“‘]$/u.test(characters[split - 1])) split--;
      if (split > 0) {
        lines.push(characters.slice(0, split).join(""));
        line = characters.slice(split).join("") + character;
      } else {
        lines.push(line);
        line = character;
      }
    } else line += character;
  }
  if (line) lines.push(line);
  return lines;
}
