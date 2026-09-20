import { useStyles } from "../styles";
export function PageHeader({ eyebrow, title, subtitle, action, compact=false }: { eyebrow: string; title: string; subtitle?: string; action?: React.ReactNode;compact?:boolean }) {
  const styles = useStyles();
  return <header className={`${styles.header}${compact?" ns-editorial-header":""}`}><div><div className={styles.eyebrow}>{eyebrow}</div><h1 className={styles.title}>{title}</h1>{subtitle&&<div className={styles.subtitle}>{subtitle}</div>}</div>{action}</header>;
}
