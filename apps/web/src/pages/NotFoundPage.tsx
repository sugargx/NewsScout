import { DocumentSearchRegular } from "@fluentui/react-icons";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

export function NotFoundPage() {
  return <div className="ns-editorial-page">
    <PageHeader eyebrow="Not found" title="找不到这个页面" subtitle="地址可能已经变更，或输入有误。"/>
    <EmptyState icon={<DocumentSearchRegular/>} title="这里没有可读的内容"
      actions={<><Link className="ns-button-link" to="/">返回今日精选</Link><Link className="ns-button-link" to="/radar">打开新闻雷达</Link></>}>
      也可以从导航进入深度阅读、每周回顾或收藏。
    </EmptyState>
  </div>;
}
