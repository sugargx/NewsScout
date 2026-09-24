import { ArrowRightRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { formatDate } from "../reader";
import { ReaderButton } from "./ReaderButton";

export function SelectionOverview({ date, count, minutes, windowEnd, updateLabel = "应用更新", onLatest }: {
  date: string; count: number; minutes?: number; windowEnd?: string; updateLabel?: string; onLatest: () => void;
}) {
  return <section className="ns-selection-overview" aria-label="本次精选导读">
    <div><span className="ns-section-kicker">{date} · 当前批次</span>
      <h2>{count ? `先读这 ${count} 条` : "看看近期值得读的内容"}</h2>
      <p>重点看截止前 24 小时，当天新进展优先；较早的高价值内容单列补读。</p>
      <span className="ns-selection-duration">{windowEnd?<time dateTime={windowEnd} aria-label="本批选文截止">截至 {formatDate(windowEnd)}（北京时间）</time>:<span>此版本未提供选文截止时间</span>}{!!minutes && ` · 约 ${minutes} 分钟`}</span>
      <span className="ns-selection-duration">阅读中保持固定，点击「{updateLabel}」重新选文，不触发采集。</span>
    </div>
    <button type="button" className="ns-latest-entry" onClick={onLatest}>
      <span><strong>最近 24 小时的新内容</strong><small>按来源时间，查看最新发生了什么</small></span><ArrowRightRegular aria-hidden="true"/>
    </button>
  </section>;
}

export function ReadingInvitation({ onStart }: { onStart: () => void }) {
  return <aside className="ns-reading-invitation">
    <div><span className="ns-section-kicker">继续深入</span><h2>从一篇一手博客开始</h2><p>先看要点，再读已收录材料，按自己的节奏继续下一篇。</p></div>
    <ReaderButton onClick={onStart}>进入深度阅读 <ArrowRightRegular aria-hidden="true"/></ReaderButton>
  </aside>;
}

export function WeeklyTopics({ topics, selected, onSelect, children }: {
  topics: { key: string; title: string; count: number }[];
  selected: string;
  onSelect: (key: string) => void;
  children?: ReactNode;
}) {
  return <section className="ns-weekly-topics" aria-label="本周主题">
    <h2>选择要补课的主题</h2><p>按主题回看本周已收录的变化，保留每篇材料的出处。</p>
    <nav className="ns-weekly-outline" aria-label="本周主题导航">
      {topics.map(topic => <button type="button" key={topic.key} aria-pressed={selected === topic.key} onClick={() => onSelect(topic.key)}>
        {topic.title}<span>{topic.count} 篇</span>
      </button>)}
      <button type="button" aria-pressed={selected === "all"} onClick={() => onSelect("all")}>全部主题</button>
    </nav>
    {children}
  </section>;
}
