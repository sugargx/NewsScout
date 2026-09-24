import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EventPreviewPane } from "../components/EventPreviewPane";
import "../reader-extras.css";

export function EventPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return id ? <div className="ns-direct-reader"><EventPreviewPane eventId={id} titleLevel={1} onClose={() => (window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate("/radar")} editionNote={params.get("readerNote")==="archive"?"历史版收录时的标题与摘要保留在上一层；这里显示该文章的当前版本。":undefined}/></div> : null;
}
