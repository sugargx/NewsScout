import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { PageHeader } from "../components/PageHeader";
import "../reader-extras.css";

export function EventPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return <>
    <PageHeader eyebrow="Reading room" title="文章阅读" subtitle="在这里继续阅读来源内容与要点。" />
    {id && <div className="ns-direct-reader"><EventPreviewPane eventId={id} onClose={() => navigate(-1)} editionNote={params.get("readerNote")==="archive"?"历史版收录时的标题与摘要保留在上一层；这里显示该文章的当前版本。":undefined}/></div>}
  </>;
}
