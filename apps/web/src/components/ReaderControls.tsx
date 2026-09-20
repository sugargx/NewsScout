import { Tab, TabList } from "@fluentui/react-components";
import { BookOpenRegular } from "@fluentui/react-icons";
import { useId, type ReactNode } from "react";
import { ReaderButton } from "./ReaderButton";
export { ReaderButton };
export { ReaderProblem } from "./ReaderProblem";

interface ReaderTabBarProps<T extends string> {
  id: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
}

export function ReaderTabBar<T extends string>({ id, label, value, onChange, options }: ReaderTabBarProps<T>) {
  return <TabList className="ns-reader-tabs" aria-label={label} selectedValue={value} size="small"
      onTabSelect={(_, data) => { const selected = options.find(option => option.value === data.value); if (selected) onChange(selected.value); }}>
      {options.map(option => <Tab key={option.value} value={option.value} id={`${id}-${option.value}`}
        aria-controls={`${id}-panel`}>{option.label}</Tab>)}
    </TabList>;
}

export function ReaderTabs<T extends string>({ children, ...props }: Omit<ReaderTabBarProps<T>, "id"> & { children: ReactNode }) {
  const id = useId();
  return <>
    <ReaderTabBar {...props} id={id}/>
    <div className="ns-reader-tab-panel" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${props.value}`}>{children}</div>
  </>;
}

export function ReaderProgress({ index, count, hasMore = false }: { index: number; count: number; hasMore?: boolean }) {
  return <span className="ns-reader-position" aria-label={`当前队列已载入 ${count} 篇，正在阅读第 ${index + 1} 篇${hasMore ? "，还有更多文章" : ""}`}>
    第 {index + 1} / {count}{hasMore ? "+" : ""} 篇
  </span>;
}

export function ReaderStart({ disabled, onStart }: { disabled: boolean; onStart: () => void }) {
  return <aside className="ns-reader-start" aria-label="选择文章开始深读">
    <BookOpenRegular aria-hidden="true"/>
    <div><h2>选择一篇文章开始深读</h2><p>先看完整摘要，再读已收录的原始材料。已打开不代表读完。</p></div>
    <ReaderButton variant="primary" disabled={disabled} onClick={onStart}>从第 1 篇开始</ReaderButton>
  </aside>;
}
