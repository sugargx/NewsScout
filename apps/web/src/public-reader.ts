import type { BriefHistory, BriefSection, Editorial, Event, Evidence, Exploration, NotInterestedReason } from "./types";

export type PublicEditorial = Pick<Editorial, "policyVersion" | "contentKind" | "reason">;
export type PublicArticle = Pick<Event,"id"|"title"|"summary"|"importance"|"primaryTopic"|"topics"|"eventType"|
  "publishedAt"|"freshnessAt"|"publicationPrecision"|"summaryKind"|"summaryModel"|"summaryFormatVersion"|
  "summaryPoints"|"summaryMaterialLimit"|"summaryLimitations"|"summarizedAt"|"coverage"> & {
    contentVersion?: Event["contentVersion"];
    displayTitle?: Event["displayTitle"];
    editorial?: PublicEditorial;
    facets:string[];
    evidence:(Omit<Evidence,"url">&{url:string|null})[];
  };
export interface PublicBrief {localDate:string;generatedAt:string;items:PublicArticle[];sections?:BriefSection[];primaryWindowStart?:string;estimatedMinutes?:number;note:string;isSnapshot?:boolean;windowStart?:string;windowEnd?:string}
export interface PublicReadingSource {id:string;name:string}
export interface PublicReadingPage {items:PublicArticle[];nextOffset:number|null;asOf:string;paginationLimited?:boolean}
export type PublicView = "brief" | "radar" | "reading" | "weekly" | "saved";
export interface PublicSaved {title:string;publisher:string;savedAt:string}
export interface PublicFeedback {saved:Record<string,PublicSaved>;dismissed:string[];opened:string[];openedVersions?:Record<string,number>;reasons?:Record<string,NotInterestedReason>}
export const publicFeedbackKey="newsscout-public-feedback-v1";
const validId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function request<T>(path:string,signal?:AbortSignal):Promise<T> {
  let response:Response;
  try {response=await fetch("/beta/api/"+path,{signal});}
  catch(error) {
    if(signal?.aborted||error instanceof Error&&error.name==="AbortError")throw error;
    throw new Error("无法连接公开阅读服务，请检查网络后重试。");
  }
  if(!response.ok) {
    const body:unknown=await response.json();
    throw new Error(body&&typeof body==="object"&&"error" in body&&typeof body.error==="string"?body.error:"内容读取失败，请重试。");
  }
  return response.json() as Promise<T>;
}
function preferenceQuery(interests:string,asOf?:string):string {
  if(!interests)return "";
  return "?"+new URLSearchParams({interests,...(asOf?{asOf}:{})});
}
export const publicApi={
  brief:(date="latest",signal?:AbortSignal,interests="",asOf?:string)=>request<PublicBrief>(date==="latest"?"brief"+preferenceQuery(interests,asOf):"briefs/"+encodeURIComponent(date),signal),
  briefs:(signal?:AbortSignal)=>request<{items:BriefHistory[]}>("briefs",signal),
  weekly:(signal?:AbortSignal)=>request<PublicBrief>("weekly",signal),
  readingSources:(signal?:AbortSignal)=>request<{items:PublicReadingSource[]}>("reading/sources",signal),
  reading:(params:URLSearchParams,signal?:AbortSignal)=>request<PublicReadingPage>("reading?"+params,signal),
  events:(params:URLSearchParams,signal?:AbortSignal)=>request<{items:PublicArticle[];nextOffset:number|null}>("events?"+params,signal),
  event:(id:string,signal?:AbortSignal,interests="")=>request<PublicArticle>("events/"+encodeURIComponent(id)+preferenceQuery(interests),signal),
  explore:(params:URLSearchParams,signal?:AbortSignal)=>request<Exploration>("explore?"+params,signal),
};

export function publicView(pathname:string,tab:string|null):PublicView {
  if(tab==="brief"||tab==="radar"||tab==="reading"||tab==="weekly"||tab==="saved")return tab;
  const routes:Record<string,PublicView>={"/":"brief","/radar":"radar","/reading":"reading","/weekly":"weekly","/saved":"saved"};
  return routes[pathname]??"brief";
}

export function hasPublicOpened(feedback:PublicFeedback,item:Pick<PublicArticle,"id"|"contentVersion">) {
  const version=feedback.openedVersions?.[item.id];
  return version!==undefined&&item.contentVersion!==undefined
    ?version>=item.contentVersion:feedback.opened.includes(item.id);
}

export function recordPublicOpen(feedback:PublicFeedback,item:Pick<PublicArticle,"id"|"contentVersion">):PublicFeedback {
  const opened=[...new Set([...feedback.opened,item.id])].slice(-2000);
  const versions={...feedback.openedVersions};
  if(item.contentVersion!==undefined)versions[item.id]=Math.max(versions[item.id]??0,item.contentVersion);
  return {...feedback,opened,openedVersions:Object.fromEntries(opened.filter(id=>versions[id]!==undefined).map(id=>[id,versions[id]]))};
}

export function loadPublicFeedback():{value:PublicFeedback;error:string|null} {
  const empty:PublicFeedback={saved:{},dismissed:[],opened:[]};
  try {
    const raw=localStorage.getItem(publicFeedbackKey);
    if(!raw)return {value:empty,error:null};
    const parsed:unknown=JSON.parse(raw);
    if(!parsed||typeof parsed!=="object"||!("saved" in parsed)||!parsed.saved||typeof parsed.saved!=="object"||Array.isArray(parsed.saved)
      ||!("dismissed" in parsed)||!Array.isArray(parsed.dismissed)||!parsed.dismissed.every(id=>typeof id==="string"&&validId.test(id)))throw new Error("Invalid reader state");
    const opened="opened" in parsed?parsed.opened:[];
    if(!Array.isArray(opened)||!opened.every(id=>typeof id==="string"&&validId.test(id)))throw new Error("Invalid opened articles");
    const saved:Record<string,PublicSaved>={};
    for(const [id,item] of Object.entries(parsed.saved)) {
      if(!validId.test(id)||!item||typeof item!=="object"||!("title" in item)||typeof item.title!=="string"
        ||!("publisher" in item)||typeof item.publisher!=="string"||!("savedAt" in item)||typeof item.savedAt!=="string")throw new Error("Invalid saved article");
      saved[id]={title:item.title,publisher:item.publisher,savedAt:item.savedAt};
    }
    const reasons:Record<string,NotInterestedReason>={};
    if("reasons" in parsed&&parsed.reasons!==undefined) {
      if(!parsed.reasons||typeof parsed.reasons!=="object"||Array.isArray(parsed.reasons))throw new Error("Invalid reasons");
      for(const [id,reason] of Object.entries(parsed.reasons)) {
        if(!validId.test(id)||!["topic","source","old","low_value"].includes(reason as string))throw new Error("Invalid reason");
        reasons[id]=reason as NotInterestedReason;
      }
    }
    const openedVersions:Record<string,number>={};
    if("openedVersions" in parsed&&parsed.openedVersions!==undefined) {
      if(!parsed.openedVersions||typeof parsed.openedVersions!=="object"||Array.isArray(parsed.openedVersions))throw new Error("Invalid opened versions");
      for(const [id,version] of Object.entries(parsed.openedVersions)) {
        if(!validId.test(id)||typeof version!=="number"||!Number.isSafeInteger(version)||version<0||!opened.includes(id))throw new Error("Invalid opened version");
        openedVersions[id]=version;
      }
    }
    return {value:{saved,dismissed:parsed.dismissed,opened:[...new Set<string>(opened)],reasons,...("openedVersions" in parsed?{openedVersions}:{})},error:null};
  } catch {
    return {value:empty,error:"无法读取本浏览器的收藏记录。原有数据未覆盖；请检查浏览器存储权限后重新载入。"};
  }
}
export function savePublicFeedback(value:PublicFeedback) {
  localStorage.setItem(publicFeedbackKey,JSON.stringify(value));
}
export function publicDate(value?:string|null,precision?:"day"|"time"|null) {
  if(!value)return "时间未提供";
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return "时间未提供";
  if(precision==="day")return date.toLocaleDateString("zh-CN",{timeZone:"UTC",year:"numeric",month:"numeric",day:"numeric"});
  return date.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
export function publicHref(value?:string|null) {
  if(!value)return undefined;
  try {const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password?url.href:undefined;}
  catch {return undefined;}
}
