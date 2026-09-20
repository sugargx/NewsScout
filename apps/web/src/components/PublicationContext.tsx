import { formatPublicationDate } from "../reader";
import type { Event } from "../types";

export function PublicationContext({event}:{event:Event}) {
  const earlier=event.freshnessAt&&event.publishedAt&&Date.parse(event.publishedAt)-Date.parse(event.freshnessAt)>3600000;
  const sparse=(event.recommendation?.materialPenalty??0)>0;
  if(!earlier&&!sparse)return null;
  return <aside className="ns-summary-material" aria-label="时效与材料说明">
    {earlier&&<span>同事件最早来源：{formatPublicationDate(event.freshnessAt)}。排序采用这个时间，较晚报道不会重置新鲜度。</span>}
    {sparse&&<span>这条即时 / 榜单式标题目前只有少量来源摘录，已降低推荐权重；文章发布日期不等于事件发生日期，具体增量仍需核验原文。</span>}
  </aside>;
}
