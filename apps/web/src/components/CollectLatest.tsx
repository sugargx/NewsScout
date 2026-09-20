import { Button } from "@fluentui/react-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { invalidateIngestion } from "../reader";
import { ErrorNotice, Notice } from "./Feedback";

export function CollectLatest({ onCollected }: { onCollected?: () => void }) {
  const client=useQueryClient();
  const mutation=useMutation({mutationFn:api.refreshSources,onSuccess:async()=>{
    onCollected?.();
    await invalidateIngestion(client);
    await client.invalidateQueries({queryKey:["explore"]});
  }});
  return <div>
    <Button appearance="primary" disabled={mutation.isPending} onClick={()=>mutation.mutate()}>{mutation.isPending ? "正在采集最新新闻…" : "采集最新新闻"}</Button>
    {mutation.error && <ErrorNotice title="最新新闻采集失败" error={mutation.error} retry={()=>mutation.mutate()} />}
    {mutation.data && <Notice><span role="status">本次新增 {mutation.data.ingested} 条、更新 {mutation.data.updated} 条；来源成功 {mutation.data.succeeded}/{mutation.data.attempted}。{mutation.data.ingested||mutation.data.updated ? "新内容已入库，AI摘要会在后台完成；未覆盖历史晨报。" : "来源未提供新内容，不会把旧新闻的时间改成今天。"}</span>{!!mutation.data.failed && <div>失败 {mutation.data.failed} 个来源：{mutation.data.errors?.map(String).join("；")}</div>}</Notice>}
  </div>;
}
