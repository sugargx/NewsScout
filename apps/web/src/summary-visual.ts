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

export function validSummaryVisual(value: unknown, points: readonly string[]): value is SummaryVisual {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["version", "kind", "items"].includes(key))
    || !("version" in value) || value.version !== 1
    || !("kind" in value) || (value.kind !== "overview" && value.kind !== "comparison")
    || !("items" in value) || !Array.isArray(value.items) || value.items.length < 2 || value.items.length > 4) return false;
  const distinct = new Set<string>();
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
      lines.push(line);
      line = character;
    } else line += character;
  }
  if (line) lines.push(line);
  return lines;
}
