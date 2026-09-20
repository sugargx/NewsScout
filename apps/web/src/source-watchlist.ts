import type {Source,SourceWatch} from "./types";

export const watchPlatforms:Record<SourceWatch["platform"],string>={
  x:"X",wechat:"微信公众号",podcast:"播客 / 频道",blog:"博客",youtube:"YouTube",
  weibo:"微博",reddit:"Reddit",bilibili:"B站",collection:"资料目录",github:"GitHub 资料",community:"平台关注意向",
};
export const watchStatuses:Record<string,string>={
  active:"原始订阅已采集",registered:"已登记 · 待首次采集",paused:"订阅已暂停",fetch_error:"订阅采集失败",
  source_loading:"订阅状态尚未读取",needs_authorization:"待合规授权接入",needs_connector:"待平台采集适配",
  needs_endpoint:"待确认原始订阅",rate_limited:"平台限流 · 待复核",needs_confirmation:"账号 / 链接待确认",
  needs_selection:"未指定具体账号",reference_only:"资料参考 · 不作为新闻采集",website_feed:"官网 RSS 已接入 · 公众号待授权",
};

export function watchStatus(item:SourceWatch,source?:Source):string {
  if(!item.sourceId)return item.status==="feed_linked"?"needs_endpoint":item.status;
  if(!source)return "source_loading";
  if(source.lifecycleStatus==="paused")return "paused";
  if(source.consecutiveFailures>0||source.lastError)return "fetch_error";
  return source.lastSuccessAt?"active":"registered";
}

export function watchStatusLabel(item:SourceWatch,status:string) {
  if(item.platform==="x"&&item.status==="feed_linked") {
    return status==="active"?"原帖预览":status==="registered"?"原帖预览 · 待首次采集":watchStatuses[status]??status;
  }
  return watchStatuses[status]??status;
}
