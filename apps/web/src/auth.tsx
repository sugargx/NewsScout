import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, FluentProvider, Switch } from "@fluentui/react-components";
import { PersonRegular, ShieldCheckmarkRegular, SignOutRegular } from "@fluentui/react-icons";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError, getDocumentReaderId, isInvitationRequired, SessionChangedError, setSessionCsrfToken, suspendSessionRequests } from "./api";
import { ErrorNotice } from "./components/Feedback";
import { ReaderButton } from "./components/ReaderControls";
import type { ReaderSession } from "./types";
import "./auth.css";

const localAccess = { user: null, capabilities: { manageReadingSettings: true }, telemetryConsent: false, identityVerified: true };
const SessionContext = createContext<Pick<ReaderSession, "capabilities" | "telemetryConsent"> & { user: ReaderSession["user"] | null; identityVerified: boolean }>(localAccess);
export const useReaderSession = () => useContext(SessionContext);

const verificationNoticeDelay = 500;
const verificationRecoveryDelay = 8_000;
const activationBatchDelay = 50;

function SessionShield({ visible, showStatus, returning }: { visible: boolean; showStatus: boolean; returning: boolean }) {
  const brand = <div className="ns-session-brand"><span aria-hidden="true">𝒩</span><strong>NewsScout</strong></div>;
  return <section className="ns-session-shield" hidden={!visible} aria-label="NewsScout 阅读空间">
    <aside className="ns-session-sidebar" aria-hidden="true">
      {brand}
      <div className="ns-session-destinations">
        {["今日精选", "新闻雷达", "深度阅读", "每周回顾", "收藏"].map(label => <div key={label}><span />{label}</div>)}
      </div>
    </aside>
    <header className="ns-session-mobile-header" aria-hidden="true">{brand}</header>
    <div className="ns-session-content">
      {/* Only public geometry: never derive this shield from the accepted reader or cached content. */}
      <div className="ns-session-placeholder-heading" aria-hidden="true" />
      <p className="ns-session-status" role="status" aria-live="polite">
        {showStatus && <><span aria-hidden="true" />{returning ? "正在恢复阅读空间…" : "正在连接阅读空间…"}</>}
      </p>
      <div className="ns-session-placeholders" aria-hidden="true">
        {[0, 1, 2].map(row => <div key={row}><span /><span /></div>)}
      </div>
    </div>
  </section>;
}

function SignInPage() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A replaced account subtree has no surviving dialog trigger to restore focus to.
    heading.current?.focus();
  }, []);
  const returnTo = location.pathname.startsWith("/.auth") ? "/" : `${location.pathname}${location.search}`;
  return <main className="ns-auth-page">
    <section className="ns-auth-card" aria-labelledby="sign-in-title">
      <div className="ns-auth-wordmark">NewsScout <span>邀请测试版</span></div>
      <h1 id="sign-in-title" ref={heading} tabIndex={-1}>把值得读的新闻，留在你的阅读空间。</h1>
      <p>受邀账号登录后可浏览新闻、设置兴趣、管理来源与采集，也可以整理和分享阅读发现。</p>
      <p className="ns-auth-detail">收藏、兴趣主题和分享草稿随账号保存，不与其他用户混用。</p>
      <a className="ns-auth-login" href={`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(returnTo)}`}>使用 Microsoft 账户登录</a>
      <p className="ns-auth-detail">支持工作、学校及个人 Microsoft 账户；组织账户可能需要管理员许可。</p>
      <Link to="/privacy">数据与隐私说明</Link>
    </section>
  </main>;
}

function InvitationPage({ invitationKey, retry, busy }: { invitationKey?: string; retry: () => void; busy: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main className="ns-auth-page">
    <section className="ns-auth-card" aria-labelledby="invitation-title">
      <div className="ns-auth-wordmark">NewsScout <span>邀请测试版</span></div>
      <h1 id="invitation-title" ref={heading} tabIndex={-1}>这个账号还未获邀。</h1>
      <p>你已完成 Microsoft 登录。将下方申请编号发给邀请你试用的维护者，获批后即可进入阅读空间。</p>
      {invitationKey ? <div className="ns-auth-invitation">
        <label htmlFor="invitation-key">申请编号</label>
        <textarea id="invitation-key" readOnly rows={3} value={invitationKey} spellCheck={false} onFocus={event => event.currentTarget.select()} aria-describedby="invitation-detail" />
        <p id="invitation-detail" className="ns-auth-detail">选中编号即可复制。这不是密码；此页面不会自动发送申请。</p>
      </div> : <p role="alert">未能取得申请编号，请重新确认账号。</p>}
      <ReaderButton variant="primary" className="ns-auth-retry" disabled={busy} onClick={retry}>{busy ? "正在确认…" : "已获批准，重新进入"}</ReaderButton>
      <div className="ns-auth-links"><a href="/.auth/logout?post_logout_redirect_uri=/">换一个账号</a><Link to="/privacy">数据与隐私说明</Link></div>
    </section>
  </main>;
}

export function AuthBoundary({ children }: { children: ReactNode }) {
  if (document.documentElement.dataset.deployment !== "azure") return <>{children}</>;
  return <CloudSession>{children}</CloudSession>;
}

function CloudSession({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [expired, setExpired] = useState(false);
  const [validated, setValidated] = useState(false);
  const [verificationStartedAt, setVerificationStartedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<"quiet" | "waiting" | "slow">("quiet");
  const accepted = useRef<ReaderSession | null>(null);
  const activeVerification = useRef<AbortSignal | null>(null);
  const scheduledVerification = useRef<number | null>(null);
  const restarting = useRef(false);
  const verificationDialog = useRef<HTMLDialogElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const rememberFocus = useCallback(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement && element.closest(".ns-session-private")) previousFocus.current = element;
  }, []);
  const restartSession = useCallback(() => {
    if (restarting.current) return;
    restarting.current = true;
    setSessionCsrfToken(null);
    setExpired(true);
    void client.cancelQueries();
    client.clear();
    window.location.reload();
  }, [client]);
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async ({ signal }) => {
      if (restarting.current) throw new DOMException("账号会话已结束。", "AbortError");
      activeVerification.current = signal;
      rememberFocus();
      suspendSessionRequests();
      setValidated(false);
      setProgress("quiet");
      setVerificationStartedAt(performance.now());
      try {
        const value = await api.session(signal);
        signal.throwIfAborted();
        if (!value.user?.id || !value.user.displayName || !value.csrfToken || typeof value.capabilities?.manageReadingSettings !== "boolean" || typeof value.telemetryConsent !== "boolean") {
          throw new Error("账号会话响应不完整，请重新连接。");
        }
        // One document never adopts another identity's credentials, including for paused mutations.
        setSessionCsrfToken(value.csrfToken, value.user.id);
        accepted.current = value;
        setValidated(true);
        return value;
      } catch (error) {
        if (error instanceof SessionChangedError || error instanceof ApiError && (error.status === 401 || isInvitationRequired(error)) && getDocumentReaderId()) {
          restartSession();
        } else if (error instanceof ApiError && (error.status === 401 || isInvitationRequired(error))) {
          setSessionCsrfToken(null);
          client.getMutationCache().clear();
          setExpired(error.status === 401);
        }
        throw error;
      } finally {
        if (activeVerification.current === signal) activeVerification.current = null;
      }
    },
    enabled: !expired,
    retry: false,
    networkMode: "always",
    staleTime: 0,
    refetchOnMount: "always",
    // Capture-phase handlers below gate private traffic before Query resumes it.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (validated || expired || !session.isFetching || verificationStartedAt === null) return;
    const elapsed = performance.now() - verificationStartedAt;
    const notice = window.setTimeout(() => setProgress("waiting"), Math.max(0, verificationNoticeDelay - elapsed));
    const recovery = window.setTimeout(() => setProgress("slow"), Math.max(0, verificationRecoveryDelay - elapsed));
    return () => { window.clearTimeout(notice); window.clearTimeout(recovery); };
  }, [validated, expired, session.isFetching, verificationStartedAt]);
  const showRecovery = !validated && !expired && verificationStartedAt !== null &&
    (progress === "slow" || !!session.error && !session.isFetching);
  useLayoutEffect(() => {
    const dialog = verificationDialog.current;
    if (!dialog) return;
    if (showRecovery && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    }
    else if (!showRecovery && dialog.open) dialog.close();
  }, [showRecovery]);
  useEffect(() => {
    if (!validated || !previousFocus.current?.isConnected) return;
    if (document.activeElement !== previousFocus.current) previousFocus.current.focus({ preventScroll: true });
    previousFocus.current = null;
  }, [validated]);
  useEffect(() => {
    const verify = () => {
      if (expired || restarting.current) return;
      rememberFocus();
      suspendSessionRequests();
      if (activeVerification.current && !activeVerification.current.aborted) return;
      setValidated(false);
      setProgress("quiet");
      setVerificationStartedAt(null);
      // Visibility, focus and online often describe one activation. Batch the request, never the gate.
      if (scheduledVerification.current !== null) return;
      scheduledVerification.current = window.setTimeout(() => {
        scheduledVerification.current = null;
        if (!restarting.current) void session.refetch({ cancelRefetch: false });
      }, activationBatchDelay);
    };
    const conceal = () => {
      if (!accepted.current || restarting.current) return;
      rememberFocus();
      suspendSessionRequests();
      setValidated(false);
      setProgress("quiet");
      setVerificationStartedAt(null);
      if (scheduledVerification.current !== null) window.clearTimeout(scheduledVerification.current);
      scheduledVerification.current = null;
      void client.cancelQueries({ queryKey: ["session"], exact: true });
    };
    const visibility = () => document.visibilityState === "visible" ? verify() : conceal();
    const focus = (event: FocusEvent) => { if (event.target === window) verify(); };
    const blur = (event: FocusEvent) => { if (event.target === window) conceal(); };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) verify(); };
    window.addEventListener("newsscout-session-expired", restartSession);
    window.addEventListener("visibilitychange", visibility, true);
    window.addEventListener("focus", focus, true);
    window.addEventListener("blur", blur, true);
    window.addEventListener("online", verify, true);
    window.addEventListener("pageshow", pageShow, true);
    return () => {
      if (scheduledVerification.current !== null) window.clearTimeout(scheduledVerification.current);
      scheduledVerification.current = null;
      window.removeEventListener("newsscout-session-expired", restartSession);
      window.removeEventListener("visibilitychange", visibility, true);
      window.removeEventListener("focus", focus, true);
      window.removeEventListener("blur", blur, true);
      window.removeEventListener("online", verify, true);
      window.removeEventListener("pageshow", pageShow, true);
    };
  }, [client, expired, rememberFocus, restartSession, session.refetch]);
  const retryVerification = async () => {
    rememberFocus();
    suspendSessionRequests();
    setValidated(false);
    if (scheduledVerification.current !== null) window.clearTimeout(scheduledVerification.current);
    scheduledVerification.current = null;
    await client.cancelQueries({ queryKey: ["session"], exact: true });
    if (!restarting.current) void session.refetch({ cancelRefetch: false });
  };
  if (expired || session.error instanceof ApiError && session.error.status === 401) return <SignInPage />;
  if (isInvitationRequired(session.error)) return <InvitationPage invitationKey={session.error.invitationKey} retry={() => void session.refetch()} busy={session.isFetching} />;
  return <>
    {accepted.current && <FluentProvider className="ns-session-private" inert={!validated} aria-hidden={!validated || undefined}>
      <SessionContext.Provider value={{ ...(session.data ?? accepted.current), identityVerified: validated }}><UsageTelemetry />{children}</SessionContext.Provider>
    </FluentProvider>}
    {createPortal(<>
      <SessionShield visible={!validated} showStatus={progress !== "quiet"} returning={!!accepted.current} />
      <dialog ref={verificationDialog} className="ns-reader-shell ns-session-confirmation" inert={!showRecovery} aria-hidden={!showRecovery || undefined} aria-labelledby="session-confirmation-title" onCancel={event => event.preventDefault()}>
        <h2 id="session-confirmation-title" tabIndex={-1}>{session.error ? "阅读空间暂时无法连接" : "连接时间有些久"}</h2>
        {session.error
          ? <ErrorNotice title="暂时无法确认你的账号" error={session.error} retry={() => void retryVerification()} busy={session.isFetching} />
          : <><p role="status">仍在等待账号确认，阅读内容暂不可见。你可以继续等待，或重新连接。</p>
            <ReaderButton variant="primary" onClick={() => void retryVerification()}>重新连接</ReaderButton></>}
        <p className="ns-auth-detail">同一账号确认完成后，会回到刚才的位置。</p>
        <p><a href="/.auth/logout?post_logout_redirect_uri=/">退出并重新登录</a></p>
      </dialog>
    </>, document.body)}
  </>;
}

export function SettingsAccess({ children }: { children: ReactNode }) {
  const { capabilities } = useReaderSession();
  return capabilities.manageReadingSettings ? children : <section className="ns-auth-restricted">
    <h1>这项设置由服务维护者管理</h1>
    <p>阅读与模型设置不对试用账号开放。新闻阅读、兴趣主题、来源与采集和分享工作台均可正常使用。</p>
    <Link to="/">返回晨间简报</Link>
  </section>;
}

export function AccountControls() {
  const session = useReaderSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const consent = useMutation({
    mutationFn: api.telemetryConsent,
    onSuccess: value => client.setQueryData<ReaderSession>(["session"], previous => previous ? { ...previous, telemetryConsent: value.enabled } : previous),
  });
  const download = useMutation({
    mutationFn: api.exportData,
    onSuccess: data => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `newsscout-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  if (!session.user) return null;
  return <div className="ns-account-controls">
    <div className="ns-account-name"><PersonRegular aria-hidden="true" /><span title={session.user.displayName}>{session.user.displayName}</span></div>
    <Dialog open={open} modalType={session.identityVerified ? "modal" : "non-modal"} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogTrigger disableButtonEnhancement><button type="button" className="ns-reader-nav-item" aria-haspopup="dialog"><span className="ns-reader-nav-icon" aria-hidden="true"><ShieldCheckmarkRegular /></span><span>隐私与使用统计</span></button></DialogTrigger>
      <DialogSurface><DialogBody>
        <DialogTitle>隐私与使用统计</DialogTitle>
        <DialogContent>
          <p>可选择提供去标识化的页面访问和操作类别，帮助改进产品。不会记录搜索词、新闻正文、邮箱、密码或登录令牌。</p>
          <Switch label="允许可选的使用统计" checked={session.telemetryConsent} disabled={consent.isPending} onChange={(_, data) => consent.mutate(data.checked)} />
          <p>关闭后仍会保留运行和安全日志，以及实现收藏、兴趣和阅读记录所需的账号数据。</p>
          <a href="/privacy">查看数据说明</a>
          {consent.error && <ErrorNotice title="隐私偏好未保存" error={consent.error} retry={() => consent.variables !== undefined && consent.mutate(consent.variables)} />}
          <p><ReaderButton disabled={download.isPending} onClick={() => download.mutate()}>{download.isPending ? "正在准备导出…" : "导出我的数据"}</ReaderButton></p>
          {download.isSuccess && <p role="status">已生成导出文件。</p>}
          {download.error && <ErrorNotice title="数据导出失败" error={download.error} retry={() => download.mutate()} />}
        </DialogContent>
        <DialogActions><ReaderButton onClick={() => setOpen(false)}>完成</ReaderButton></DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>
    <a className="ns-reader-nav-item" href="/.auth/logout?post_logout_redirect_uri=/"><span className="ns-reader-nav-icon" aria-hidden="true"><SignOutRegular /></span><span>退出登录</span></a>
  </div>;
}

function pageCategory(path: string) {
  if (path === "/") return "brief";
  const section = path.split("/")[1];
  return ["radar", "reading", "weekly", "saved", "topics", "sources", "shares", "share"].includes(section) ? section : "other";
}

function UsageTelemetry() {
  const { telemetryConsent } = useReaderSession();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!telemetryConsent) return;
    void api.telemetry([{ name: "page_view", page: pageCategory(pathname) }]).catch(error => {
      console.warn("Optional usage telemetry was not delivered.", error instanceof ApiError ? error.status : "network");
    });
  }, [telemetryConsent, pathname]);
  return null;
}

export function PrivacyPage() {
  return <main className="ns-privacy-page">
    <Link to="/">NewsScout</Link>
    <h1>数据与隐私</h1>
    <p>这是供受邀用户体验和反馈的测试环境，不承诺生产级持续可用性。请勿输入敏感、保密内容或第三方凭据。</p>
    <h2>随账号保存的内容</h2>
    <p>登录身份标识、显示名称、兴趣主题、收藏、阅读记录、个人来源设置和分享草稿用于提供服务。其他用户不能读取或修改你的这些数据。只有主动发布的分享内容可通过分享链接访问；你可以撤回分享。</p>
    <h2>运行与安全日志</h2>
    <p>服务记录请求结果、耗时、采集任务状态和必要的安全事件，用于排错与防止滥用。不把密码、令牌、搜索内容或新闻正文写入 telemetry。</p>
    <h2>可选择的使用统计</h2>
    <p>默认关闭。你可以在“隐私与使用统计”中决定是否提供去标识化的页面类型和操作类别，并随时关闭。这与实现阅读偏好所需的收藏、打开和曝光记录不同。</p>
    <h2>管理你的数据</h2>
    <p>云端测试服务的账号数据在维护者的 Azure 环境中保存，本地运行的数据保存在本机配置的数据库。登录云端后可从“隐私与使用统计”导出自己的数据；导出时生成的私有临时副本在 7 天后自动清理。需要删除账号数据时，请联系邀请你试用的维护者。</p>
  </main>;
}
