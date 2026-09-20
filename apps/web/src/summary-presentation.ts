import type { Event, SummaryPresentation } from "./types";

export function summaryPresentation(event:Pick<Event,"summary"|"summaryPoints"|"summaryMaterialLimit"|"summaryLimitations">):SummaryPresentation {
  if(event.summaryPoints?.length) {
    return {points:event.summaryPoints,materialLimit:event.summaryMaterialLimit??null,limitations:event.summaryLimitations??[]};
  }
  // Old snapshots retain their text; only unambiguous acquisition caveats are separated for display.
  const sentences=(event.summary.match(/[^。！？\n]+[。！？]?/gu)??[]).map(text=>text.trim()).filter(Boolean);
  const material:string[]=[],points:string[]=[];
  for(const sentence of sentences) {
    if(/^(由于|但|现有|目前|仅|资料|摘录|未提供|未附|这份|该摘录)/u.test(sentence)
      && /(摘录|片段|材料|标题|资料)/u.test(sentence)
      && /(不足|缺少|缺乏|未提供|未附|无法|尚无法|仅提供|只有)/u.test(sentence))material.push(sentence);
    else points.push(sentence);
  }
  return {points,materialLimit:event.summaryMaterialLimit??(material.join("")||null),limitations:event.summaryLimitations??[]};
}
