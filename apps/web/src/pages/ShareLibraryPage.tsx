import { Spinner } from "@fluentui/react-components";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PageHeader } from "../components/PageHeader";
import { ErrorNotice } from "../components/Feedback";
import { useStyles } from "../styles";

export function ShareLibraryPage() {
  const styles=useStyles(),query=useQuery({queryKey:["share-drafts"],queryFn:api.shareDrafts});
  return <>
    <PageHeader eyebrow="YOUR CREATIVE DESK" title="从阅读，到分享。" subtitle="最近50份本地分享草稿。编辑封面、选文和文案，导出一套图文素材；不会自动发布到小红书。"/>
    {query.error&&<ErrorNotice error={query.error} retry={()=>void query.refetch()}/>}
    {query.isLoading&&<Spinner label="正在打开草稿库…" />}
    <div className={styles.grid}>{query.data?.items.map(item=><article className={styles.card} key={item.id}><p className={styles.muted}>{item.date} · {item.kind==="event"?"文章":item.kind==="brief"?"简报":"周报"} · {item.edited?"已保存排版":"新草稿"}</p><h2><Link to={"/share/"+item.id}>{item.title}</Link></h2><p>继续编辑与导出 →</p></article>)}</div>
    {query.data&&!query.data.items.length&&<div className={styles.empty}><h2>第一份分享，从一篇好文章开始。</h2><p>在文章、晨间简报或每周回顾里点击“制作分享卡片”，就可以开始。</p><Link to="/radar">去新闻雷达选一篇 →</Link></div>}
  </>;
}
