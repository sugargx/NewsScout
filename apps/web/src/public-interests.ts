import catalog from "../../../shared/reader-interest-topics.json";

export const publicInterestTopics: readonly {id:string;label:string}[] = catalog;
export const publicInterestKey = "newsscout-public-interests-v1";
export const interestPriorities = [
  {weight:50,label:"普通关注"},
  {weight:80,label:"重点关注"},
  {weight:100,label:"优先关注"},
] as const;
export type InterestWeight = typeof interestPriorities[number]["weight"];
export interface PublicInterest {id:string;weight:InterestWeight}
export interface PublicInterestRecord {value:PublicInterest[];raw:string|null;error:string|null}

export class InterestConflict extends Error {
  constructor() {super("另一页面已更新兴趣。你的编辑尚未保存；请先载入最新设置。");}
}
export function isInterestWeight(value:unknown):value is InterestWeight {
  return interestPriorities.some(priority=>priority.weight===value);
}
function validate(value:unknown):PublicInterest[] {
  if(!Array.isArray(value)||value.length>publicInterestTopics.length)throw new Error("Invalid interest list");
  const ids=new Set<string>(),topics:PublicInterest[]=[];
  const entries:unknown[]=value;
  for(const item of entries) {
    if(!item||typeof item!=="object"||!("id" in item)||typeof item.id!=="string"||!("weight" in item)
      ||!publicInterestTopics.some(topic=>topic.id===item.id)||ids.has(item.id)||!isInterestWeight(item.weight))
      throw new Error("Invalid interest topic");
    ids.add(item.id);topics.push({id:item.id,weight:item.weight});
  }
  return topics.sort((a,b)=>a.id.localeCompare(b.id));
}
function decode(raw:string):PublicInterest[] {
  if(raw.length>4096)throw new Error("Interest record is too large");
  const data:unknown=JSON.parse(raw);
  if(!data||typeof data!=="object"||!("version" in data)||data.version!==1||!("topics" in data))
    throw new Error("Invalid interest record");
  return validate(data.topics);
}
export function loadPublicInterests():PublicInterestRecord {
  let raw:string|null;
  try {raw=localStorage.getItem(publicInterestKey);}
  catch {return {value:[],raw:null,error:"无法访问浏览器兴趣记录。请检查存储权限；原有记录未覆盖。"};}
  if(raw===null)return {value:[],raw,error:null};
  try {return {value:decode(raw),raw,error:null};}
  catch {return {value:[],raw,error:"兴趣记录无法读取，原有数据未覆盖。可以重新载入，或明确重置这份兴趣记录。"};}
}
export function interestSignature(topics:readonly PublicInterest[]):string {
  return [...topics].sort((a,b)=>a.id.localeCompare(b.id)).map(topic=>`${topic.id}:${topic.weight}`).join(",");
}
export function withPublicInterests(params:URLSearchParams,interests:string):URLSearchParams {
  const next=new URLSearchParams(params);
  if(interests)next.set("interests",interests);else next.delete("interests");
  return next;
}
export function savePublicInterests(topics:readonly PublicInterest[],expectedRaw:string|null):PublicInterestRecord {
  const existing=localStorage.getItem(publicInterestKey);
  if(existing!==expectedRaw)throw new InterestConflict();
  if(existing!==null)decode(existing);
  const value=validate(topics),raw=JSON.stringify({version:1,topics:value});
  localStorage.setItem(publicInterestKey,raw);
  return {value,raw,error:null};
}
export function resetPublicInterests(expectedRaw:string|null):PublicInterestRecord {
  if(localStorage.getItem(publicInterestKey)!==expectedRaw)throw new InterestConflict();
  localStorage.removeItem(publicInterestKey);
  return {value:[],raw:null,error:null};
}
