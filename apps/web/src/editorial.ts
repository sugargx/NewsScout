import type { BriefSection, Editorial, Event, NotInterestedReason } from "./types";

export function readingTitle(item:{title:string;displayTitle?:string|null}) {
  return item.displayTitle?.trim() || item.title;
}

const labels:Record<Editorial["contentKind"],string>={
  news:"新闻",release:"产品更新",research:"研究",analysis:"深度分析",tutorial:"实践指南",
  discussion:"社区讨论",question:"社区问答",promotion:"推广",metadata:"资料索引",
};
export function contentLabel(item:{editorial?:Pick<Editorial,"contentKind">;eventType:string}) {
  return item.editorial ? labels[item.editorial.contentKind] :
    ({paper:"研究",release:"产品更新",podcast:"播客",blog:"文章",repository:"开源项目",model:"模型"} as Record<string,string>)[item.eventType] || "文章";
}

export const disinterestReasons:{value:NotInterestedReason;label:string}[]=[
  {value:"topic",label:"主题不相关"},{value:"source",label:"不喜欢此来源"},
  {value:"old",label:"内容太旧"},{value:"low_value",label:"信息价值低"},
];

// Section headings annotate the received order; they never re-rank an edition.
export function editionGroups<T extends {id:string}>(items:T[],sections:BriefSection[]=[]):{section?:BriefSection;key:string;items:T[]}[] {
  const membership=new Map<string,BriefSection>();
  sections.forEach(section=>section.eventIds.forEach(id=>{if(!membership.has(id))membership.set(id,section);}));
  const groups:{section?:BriefSection;key:string;items:T[]}[]=[];
  const seen=new Set<string>();
  for(const item of items) {
    if(seen.has(item.id))continue;
    seen.add(item.id);
    const section=membership.get(item.id),last=groups.at(-1);
    if(last&&last.section===section)last.items.push(item);
    else groups.push({section,key:`${section?.key??"legacy"}-${groups.length}`,items:[item]});
  }
  return groups;
}

type Revision=Pick<Event,"id"|"title"|"summary"|"summarizedAt"> & Partial<Pick<Event,"contentVersion"|"displayTitle"|"summaryPoints"|"coverage">>;
export function refreshOutcome(before:Revision[],after:Revision[]) {
  const revision=(item:Revision)=>JSON.stringify([item.contentVersion??null,readingTitle(item),item.summary,item.summaryPoints,item.summarizedAt,
    item.coverage?.members.map(member=>[member.eventId,member.contentVersion,readingTitle(member),member.summary,member.summarizedAt]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
  const previous=new Map(before.map(item=>[item.id,revision(item)]));
  const added=after.filter(item=>!previous.has(item.id)).length;
  const updated=after.filter(item=>previous.has(item.id)&&previous.get(item.id)!==revision(item)).length;
  if(added||updated)return `新增 ${added} 条 · 更新 ${updated} 条。已应用本次内容，未采集来源。`;
  const currentIds=new Set(after.map(item=>item.id)),removed=before.filter(item=>!currentIds.has(item.id)).length;
  if(removed)return `没有新增内容。当前列表移出 ${removed} 条；已应用筛选与反馈，未采集来源。`;
  if(before.length===after.length&&before.some((item,index)=>item.id!==after[index].id))
    return "没有新增内容。仅推荐顺序发生变化，未采集来源。";
  return "没有新增内容。内容与顺序未变，已应用当前筛选与反馈，未采集来源。";
}
