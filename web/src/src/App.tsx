import type { TFunction } from 'i18next'
import { QRCodeSVG } from 'qrcode.react'
import type { ReactNode } from 'react'
import { FormEvent, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from './api'
import { localeConfig, resolvedLocale } from './i18n'
import type { Config, FrontProxySettings, Node, Protocol, Status, SubscriptionClientInfo, SubscriptionInfo, VersionInfo } from './types'

const protocolLabels: Record<Protocol, string> = {
  openvpn_udp: 'OpenVPN UDP',
  openvpn_tcp: 'OpenVPN TCP',
  softether_https: 'SoftEther TLS',
  sstp: 'SSTP',
  l2tp: 'L2TP/IPsec',
}

type View = 'nodes' | 'subscription' | 'settings'
type Theme = 'light' | 'dark'
type SortKey = 'speedBps' | 'pingMs' | 'score' | 'measuredBps' | 'countryShort'
type NodeViewMode = 'cards' | 'list' | 'table'

const protocolDisplayOrder: Protocol[] = ['openvpn_udp', 'openvpn_tcp', 'softether_https', 'sstp', 'l2tp']
const selectionSort: Record<Config['selectionMode'], { key: SortKey; direction: 'asc' | 'desc' }> = {
  speed: { key: 'speedBps', direction: 'desc' },
  ping: { key: 'pingMs', direction: 'asc' },
  score: { key: 'score', direction: 'desc' },
}

function App() {
  const { t, i18n } = useTranslation()
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [version, setVersion] = useState<VersionInfo>()
  const [view, setView] = useState<View>('nodes')
  const [theme, setTheme] = useState<Theme>(preferredTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem('proxygate:theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = resolvedLocale(i18n.resolvedLanguage)
  }, [i18n.resolvedLanguage])

  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => undefined)
    api.get<Status>('/api/status').then(() => setAuthenticated(true)).catch(() => setAuthenticated(false))
    const unauthorized = () => setAuthenticated(false)
    window.addEventListener('proxygate:unauthorized', unauthorized)
    return () => window.removeEventListener('proxygate:unauthorized', unauthorized)
  }, [])

  if (authenticated === null) return <LoadingScreen />
  if (!authenticated) return <Login version={version} theme={theme} onToggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} onSuccess={() => setAuthenticated(true)} />

  const logout = () => api.post('/api/logout').finally(() => setAuthenticated(false))
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        <div><BrandTitle version={version} /><small>{t('app.subtitle')}</small></div>
      </div>
      <nav className="primary-nav" role="tablist" aria-label={t('app.navigation')}>
        <button role="tab" aria-selected={view === 'nodes'} className={view === 'nodes' ? 'active' : ''} onClick={() => setView('nodes')}><span>{t('app.nodes')}</span><small>{t('app.nodes')}</small></button>
        <button role="tab" aria-selected={view === 'subscription'} className={view === 'subscription' ? 'active' : ''} onClick={() => setView('subscription')}><span>{t('app.subscription')}</span><small>{t('app.subscription')}</small></button>
        <button role="tab" aria-selected={view === 'settings'} className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><span>{t('app.settings')}</span><small>{t('app.settings')}</small></button>
      </nav>
      <div className="topbar-actions">
        <LanguageSelect />
        <button className="quiet-button theme-button" title={t('theme.switch')} onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}><ThemeIcon theme={theme} /><span>{theme === 'dark' ? t('theme.light') : t('theme.dark')}</span></button>
        <button className="quiet-button" onClick={logout}>{t('app.logout')}</button>
      </div>
    </header>
    <main className="workspace">{view === 'nodes' ? <Nodes /> : view === 'subscription' ? <Subscription /> : <Settings />}</main>
  </div>
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="brand-mark large" /><div className="pulse-line" /></div>
}

function Login({ version, theme, onToggleTheme, onSuccess }: { version?: VersionInfo; theme: Theme; onToggleTheme: () => void; onSuccess: () => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setSubmitting(true)
    try {
      await api.post('/api/login', { username, password })
      onSuccess()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="login-page">
    <div className="login-controls"><LanguageSelect /><button className="quiet-button login-theme" title={t('theme.switch')} onClick={onToggleTheme}><ThemeIcon theme={theme} /><span>{theme === 'dark' ? t('theme.lightMode') : t('theme.darkMode')}</span></button></div>
    <section className="login-intro">
      <div className="brand login-brand"><div className="brand-mark large"><span /></div><div><BrandTitle version={version} /><small>{t('app.subtitle')}</small></div></div>
      <p className="eyebrow">PROXYGATE</p>
      <h1>{t('login.title')}</h1>
      <p className="login-copy">{t('login.description')}</p>
    </section>
    <form className="login-panel" onSubmit={submit}>
      <div><p className="eyebrow">{t('login.panel')}</p><h2>{t('login.heading')}</h2><p>{t('login.prompt')}</p></div>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label={t('login.username')}><input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoFocus /></Field>
      <Field label={t('login.password')}><input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></Field>
      <button className="primary-button wide" disabled={submitting}>{submitting ? <><Spinner />{t('login.checking')}</> : t('login.submit')}</button>
    </form>
  </main>
}

function BrandTitle({ version }: { version?: VersionInfo }) {
  return <strong>ProxyGate{version && <span className="app-version" title={version.release}>v{version.version}</span>}</strong>
}

function Nodes() {
  const { t, i18n } = useTranslation()
  const locale = resolvedLocale(i18n.resolvedLanguage)
  const sortLabels: Record<SortKey, string> = {
    speedBps: t('sort.speedBps'),
    measuredBps: t('sort.measuredBps'),
    pingMs: t('sort.pingMs'),
    score: t('sort.score'),
    countryShort: t('sort.countryShort'),
  }
  const [status, setStatus] = useState<Status>()
  const [nodes, setNodes] = useState<Node[]>([])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('speedBps')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [viewMode, setViewMode] = useState<NodeViewMode>(preferredNodeView)
  const [protocolPriority, setProtocolPriority] = useState<Protocol[]>(protocolDisplayOrder)
  const [page, setPage] = useState(1)
  const [loadingNodes, setLoadingNodes] = useState(true)
  const [reconnecting, setReconnecting] = useState(false)
  const [switchingDirect, setSwitchingDirect] = useState(false)
  const [lastSynced, setLastSynced] = useState<Date>()
  const statusRequest = useRef(false)
  const nodesRequest = useRef(false)
  const nodesReloadPending = useRef(false)
  const refreshWasRunning = useRef(false)
  const previousActiveIP = useRef<string | undefined>(undefined)
  const sortTouched = useRef(false)
  const deferredQuery = useDeferredValue(query)
  const pageSize = 24

  const loadStatus = useCallback(async () => {
    if (statusRequest.current || document.visibilityState === 'hidden') return
    statusRequest.current = true
    try {
      setStatus(await api.get<Status>('/api/status'))
      setError('')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      statusRequest.current = false
    }
  }, [])

  const loadNodes = useCallback(async () => {
    if (document.visibilityState === 'hidden') return
    if (nodesRequest.current) {
      nodesReloadPending.current = true
      return
    }
    nodesRequest.current = true
    try {
      do {
        nodesReloadPending.current = false
        setNodes(await api.get<Node[]>('/api/nodes?limit=240'))
        setLastSynced(new Date())
        setError('')
      } while (nodesReloadPending.current && !document.hidden)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      nodesRequest.current = false
      setLoadingNodes(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus(); void loadNodes()
    const statusTimer = window.setInterval(loadStatus, 4_000)
    const nodesTimer = window.setInterval(loadNodes, 60_000)
    const visible = () => { if (document.visibilityState === 'visible') { void loadStatus(); void loadNodes() } }
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearInterval(statusTimer); window.clearInterval(nodesTimer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [loadNodes, loadStatus])

  useEffect(() => {
    let mounted = true
    void api.get<Config>('/api/config').then(settings => {
      if (!mounted) return
      setProtocolPriority(settings.protocolPriority)
      if (!sortTouched.current) {
        const preferred = selectionSort[settings.selectionMode]
        setSortKey(preferred.key)
        setSortDirection(preferred.direction)
      }
    }).catch(reason => {
      if (mounted) setError(errorMessage(reason))
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (refreshWasRunning.current && status?.refreshRunning === false) void loadNodes()
    refreshWasRunning.current = Boolean(status?.refreshRunning)
  }, [status?.refreshRunning, loadNodes])

  useEffect(() => {
    const activeIP = status?.activeIp
    if (!activeIP) return
    const previous = previousActiveIP.current
    previousActiveIP.current = activeIP
    if (previous && previous !== activeIP) void loadNodes()
  }, [status?.activeIp, loadNodes])

  useEffect(() => { setPage(1) }, [deferredQuery, sortKey, sortDirection, status?.activeIp])
  useEffect(() => { window.localStorage.setItem('proxygate:nodeView', viewMode) }, [viewMode])

  const filteredNodes = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    const result = normalized ? nodes.filter(node => [
      node.ip, node.hostName, node.operator, node.countryShort, node.countryLong, ...node.protocols,
    ].some(value => value.toLowerCase().includes(normalized))) : nodes
    const multiplier = sortDirection === 'asc' ? 1 : -1
    return [...result].sort((left, right) => {
      const leftActive = left.ip === status?.activeIp
      const rightActive = right.ip === status?.activeIp
      if (leftActive !== rightActive) return leftActive ? -1 : 1

      let comparison = 0
      switch (sortKey) {
        case 'speedBps': comparison = left.speedBps - right.speedBps; break
        case 'pingMs': comparison = normalizedPing(left.pingMs) - normalizedPing(right.pingMs); break
        case 'score': comparison = left.score - right.score; break
        case 'measuredBps': comparison = (left.measuredBps || 0) - (right.measuredBps || 0); break
        case 'countryShort': comparison = left.countryShort.localeCompare(right.countryShort, locale); break
      }
      return comparison * multiplier
    })
  }, [nodes, deferredQuery, sortKey, sortDirection, status?.activeIp, locale])

  const pageCount = Math.max(1, Math.ceil(filteredNodes.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visibleNodes = filteredNodes.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const connected = status?.state === 'connected' && !status?.directMode
  const directMode = Boolean(status?.directMode)

  const refresh = async () => {
    try {
      await api.post('/api/refresh')
      setStatus(current => current ? { ...current, refreshRunning: true } : current)
      await loadStatus()
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const reconnect = async () => {
    setError(''); setReconnecting(true)
    try {
      await api.post('/api/nodes/reconnect')
      setStatus(current => current ? { ...current, state: 'connecting', connectingIp: current.activeIp } : current)
      await loadStatus()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setReconnecting(false)
    }
  }

  const toggleDirect = async () => {
    if (!status) return
    setError(''); setSwitchingDirect(true)
    const enabled = !status.connectionPaused
    try {
      await api.post('/api/connection/direct', { enabled })
      setStatus(current => current ? enabled
        ? { ...current, state: 'direct', directMode: true, connectionPaused: true, activeIp: undefined, activeHostName: undefined, activeProtocol: undefined, connectingIp: undefined }
        : { ...current, state: 'connecting', connectionPaused: false }
        : current)
      await loadStatus()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSwitchingDirect(false)
    }
  }

  return <div className="page-stack">
    <header className="page-heading">
      <div><p className="eyebrow">{t('nodes.eyebrow')}</p><h1>{t('nodes.heading')}</h1><p>{t('nodes.description')}</p></div>
      <div className="heading-actions">
        <span className="sync-label">{t('nodes.synced', { time: formatRelativeTime(lastSynced, t) })}</span>
        <button className="secondary-button" disabled={!status?.activeIp || status.state === 'connecting' || reconnecting || switchingDirect} onClick={reconnect}>{reconnecting ? <Spinner /> : <RestartIcon />}{reconnecting ? t('nodes.reconnecting') : t('nodes.reconnectCurrent')}</button>
        <button className="primary-button" disabled={status?.refreshRunning} onClick={refresh}>{status?.refreshRunning ? <Spinner /> : <RefreshIcon />}{status?.refreshRunning ? t('nodes.refreshing') : t('nodes.refreshSource')}</button>
      </div>
    </header>

    {error && <Notice tone="danger">{error}</Notice>}
    {status?.lastError && <Notice tone="warning"><strong>{t('nodes.lastError')}</strong><span>{status.lastError}</span></Notice>}

    <section className="status-grid">
      <article className={`status-card connection ${connected ? 'healthy' : directMode || status?.state === 'connecting' ? 'pending' : 'unhealthy'}`}>
        <div className="status-card-head"><span>{t('status.connection')}</span><i /></div>
        <div className="status-state-row"><strong>{directMode ? t('status.direct') : stateLabel(status?.state, t)}</strong><button className={status?.connectionPaused ? 'resume' : 'direct'} disabled={!status || switchingDirect} onClick={toggleDirect}>{switchingDirect ? <Spinner /> : status?.connectionPaused ? <RestartIcon /> : null}{switchingDirect ? t('nodes.switchingConnection') : status?.connectionPaused ? t('nodes.resumeConnection') : directMode ? t('nodes.pauseReconnect') : t('nodes.enableDirect')}</button></div>
        <p>{directMode ? status?.connectionPaused ? t('status.directPaused') : t('status.directFallback') : status?.selection === 'manual' ? t('status.manual') : t('status.automatic')}</p>
      </article>
      <article className="status-card"><div className="status-card-head"><span>{t('status.currentExit')}</span><small>{status?.activeProtocol ? protocolLabels[status.activeProtocol] : '—'}</small></div><strong className="mono compact">{directMode ? t('status.localNetwork') : status?.activeIp || t('status.notConnected')}</strong><p>{directMode ? t('status.localNetworkHint') : status?.activeHostName || t('status.waiting')}</p></article>
      <article className="status-card"><div className="status-card-head"><span>{t('status.healthCheck')}</span><small>{status?.lastError ? t('status.unhealthy') : t('status.healthy')}</small></div><strong className="compact">{formatRelativeTime(status?.lastHealthCheck, t)}</strong><p>{status?.lastHealthCheck ? formatDateTime(status.lastHealthCheck, locale) : t('status.notChecked')}</p></article>
      <article className="status-card"><div className="status-card-head"><span>{t('status.nodeCount')}</span><small>{t('status.filtered')}</small></div><strong>{nodes.length}</strong><p>{t('status.showing', { count: filteredNodes.length })}</p></article>
    </section>

    <section className="node-panel">
      <div className="node-toolbar">
        <label className="search-box"><SearchIcon /><input type="search" placeholder={t('nodes.search')} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="node-toolbar-right">
          <div className="sort-control"><span>{t('nodes.sort')}</span><select value={sortKey} onChange={event => { sortTouched.current = true; setSortKey(event.target.value as SortKey) }}>{Object.entries(sortLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button title={t('nodes.toggleSort')} onClick={() => { sortTouched.current = true; setSortDirection(direction => direction === 'asc' ? 'desc' : 'asc') }}>{sortDirection === 'asc' ? '↑' : '↓'}</button></div>
          <div className="view-switch" role="group" aria-label={t('nodes.viewMode')}>
            <button type="button" className={viewMode === 'cards' ? 'active' : ''} aria-pressed={viewMode === 'cards'} title={t('nodes.viewCards')} onClick={() => setViewMode('cards')}><GridIcon /><span>{t('nodes.viewCards')}</span></button>
            <button type="button" className={viewMode === 'list' ? 'active' : ''} aria-pressed={viewMode === 'list'} title={t('nodes.viewList')} onClick={() => setViewMode('list')}><ListIcon /><span>{t('nodes.viewList')}</span></button>
            <button type="button" className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} title={t('nodes.viewTable')} onClick={() => setViewMode('table')}><TableIcon /><span>{t('nodes.viewTable')}</span></button>
          </div>
        </div>
      </div>
      <div className="node-panel-meta"><span>{t('nodes.count', { count: filteredNodes.length })}</span><span>{t('nodes.perPage', { count: pageSize })}</span></div>
      {loadingNodes ? <NodeSkeleton /> : visibleNodes.length > 0
        ? viewMode === 'cards'
          ? <div className="node-grid">{visibleNodes.map(node => <NodeCard key={node.ip} node={node} protocolPriority={protocolPriority} active={status?.activeIp === node.ip} activeProtocol={status?.activeIp === node.ip ? status?.activeProtocol : undefined} connecting={status?.connectingIp === node.ip} reloadStatus={loadStatus} reloadNodes={loadNodes} />)}</div>
          : viewMode === 'list'
            ? <div className="node-list">{visibleNodes.map(node => <NodeRow key={node.ip} node={node} protocolPriority={protocolPriority} active={status?.activeIp === node.ip} activeProtocol={status?.activeIp === node.ip ? status?.activeProtocol : undefined} connecting={status?.connectingIp === node.ip} reloadStatus={loadStatus} />)}</div>
            : <NodeTable nodes={visibleNodes} protocolPriority={protocolPriority} status={status} reloadStatus={loadStatus} />
        : <EmptyState query={deferredQuery} />}
      {pageCount > 1 && <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} />}
    </section>
  </div>
}

const NodeCard = memo(function NodeCard({ node, protocolPriority, active, activeProtocol, connecting, reloadStatus, reloadNodes }: {
  node: Node
  protocolPriority: Protocol[]
  active: boolean
  activeProtocol?: Protocol
  connecting: boolean
  reloadStatus: () => Promise<void>
  reloadNodes: () => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const locale = resolvedLocale(i18n.resolvedLanguage)
  const [testing, setTesting] = useState(false)
  const [startingTest, setStartingTest] = useState(false)
  const [cancelingTest, setCancelingTest] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [speedTestError, setSpeedTestError] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selectedProtocol, setSelectedProtocol] = useState<Protocol | ''>(activeProtocol || '')
  const speedTestRun = useRef(0)
  const availableProtocols = useMemo(() => orderedProtocols(node.protocols, protocolPriority), [node.protocols, protocolPriority])

  useEffect(() => {
    if (active && activeProtocol) setSelectedProtocol(activeProtocol)
  }, [active, activeProtocol])

  const select = async () => {
    setConnectionError(''); setSelecting(true)
    try {
      await api.post('/api/nodes/select', { ip: node.ip, protocol: selectedProtocol })
      await reloadStatus()
    } catch (reason) {
      setConnectionError(errorMessage(reason))
    } finally {
      setSelecting(false)
    }
  }

  const test = async () => {
    const run = ++speedTestRun.current
    setSpeedTestError(''); setTesting(true); setStartingTest(true)
    try {
      await api.post(`/api/nodes/${encodeURIComponent(node.ip)}/speed-test`)
      if (speedTestRun.current !== run) return
      setStartingTest(false)
      while (speedTestRun.current === run) {
        await delay(1_500)
        if (speedTestRun.current !== run) return
        const result = await api.get<{ state: string; error?: string }>(`/api/nodes/${encodeURIComponent(node.ip)}/speed-test`)
        if (result.state === 'failed') throw new Error(result.error || t('node.speedTestFailed'))
        if (result.state === 'canceled') return
        if (result.state === 'complete') { await reloadNodes(); return }
      }
    } catch (reason) {
      if (speedTestRun.current === run) setSpeedTestError(errorMessage(reason))
    } finally {
      if (speedTestRun.current === run) { setTesting(false); setStartingTest(false) }
    }
  }

  const cancelTest = async () => {
    const run = speedTestRun.current
    setCancelingTest(true)
    try {
      const result = await api.delete<{ state: string; error?: string }>(`/api/nodes/${encodeURIComponent(node.ip)}/speed-test`)
      if (speedTestRun.current !== run) return
      speedTestRun.current++
      if (result.state === 'complete') await reloadNodes()
      setSpeedTestError(result.state === 'failed' ? result.error || t('node.speedTestFailed') : '')
      setTesting(false)
      setStartingTest(false)
    } catch (reason) {
      if (speedTestRun.current === run) setSpeedTestError(errorMessage(reason))
    } finally {
      setCancelingTest(false)
    }
  }

  return <article className={`node-card ${active ? 'active' : ''}`}>
    <div className="node-identity">
      <div className="country-mark" aria-label={node.countryLong}>{countryFlag(node.countryShort)}</div>
      <div><div className="node-title"><strong>{node.countryShort || '—'}</strong>{active && <span className="live-badge">{t('node.active')}</span>}{connecting && <span className="pending-badge">{t('node.connecting')}</span>}</div><span className="mono">{node.ip}</span></div>
    </div>
    <p className="node-operator" title={node.message}>{node.operator || node.hostName || t('node.unknownOperator')}</p>
    <div className="protocol-list">{availableProtocols.map(protocol => <span key={protocol}>{protocolLabels[protocol]}</span>)}</div>
    <dl className="node-metrics">
      <div><dt>{t('node.vpnGate')}</dt><dd>{formatRate(node.speedBps)}</dd></div>
      <div><dt>{t('node.measured')}</dt><dd className={speedTestError || node.speedTestFailed ? 'failed' : node.measuredBps ? 'accent' : ''}>{speedTestError ? <ErrorTooltip label={t('node.failed')} message={speedTestError} /> : node.speedTestFailed ? t('node.failed') : formatRate(node.measuredBps)}</dd></div>
      <div><dt>{t('node.latency')}</dt><dd>{node.pingMs > 0 ? `${node.pingMs} ms` : '—'}</dd></div>
      <div><dt>{t('node.score')}</dt><dd>{formatNumber(node.score, locale)}</dd></div>
    </dl>
    <label className="connection-protocol"><span>{t('node.protocol')}</span><select value={selectedProtocol} disabled={connecting || selecting} onChange={event => { setSelectedProtocol(event.target.value as Protocol | ''); setConnectionError('') }}><option value="">{t('node.priority')}</option>{availableProtocols.map(protocol => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}</select></label>
    <div className="node-actions"><button className={`secondary-button ${connectionError ? 'error-tooltip' : ''}`} data-tooltip={connectionError || undefined} aria-label={connectionError ? t('node.connectFailedLabel', { error: connectionError }) : undefined} disabled={connecting || selecting} onClick={select}>{connecting || selecting ? <><Spinner />{t('node.connectingAction')}</> : connectionError ? t('node.connectFailed') : active ? selectedProtocol === '' ? t('node.reconnectPriority') : selectedProtocol === activeProtocol ? t('node.reconnect') : t('node.reconnectProtocol') : t('node.switch')}</button><button className={`icon-button ${testing ? 'cancel-button' : ''}`} title={testing ? t('node.cancelSpeedTestTitle') : t('node.speedTestTitle')} disabled={startingTest || cancelingTest} onClick={testing ? cancelTest : test}>{startingTest || cancelingTest ? <Spinner /> : testing ? <StopIcon /> : <SpeedIcon />}<span>{cancelingTest ? t('node.cancelingTest') : startingTest ? t('node.testing') : testing ? t('node.cancelTest') : t('node.speedTest')}</span></button></div>
  </article>
})

function ErrorTooltip({ label, message }: { label: string; message: string }) {
  return <span className="error-tooltip" tabIndex={0} data-tooltip={message} aria-label={`${label}: ${message}`}>{label}</span>
}

function NodeStateBadge({ active, connecting, activeProtocol }: { active: boolean; connecting: boolean; activeProtocol?: Protocol }) {
  const { t } = useTranslation()
  if (active) return <span className="live-badge">{t('node.active')}{activeProtocol ? ` · ${protocolLabels[activeProtocol]}` : ''}</span>
  if (connecting) return <span className="pending-badge">{t('node.connecting')}</span>
  return <span className="idle-badge">—</span>
}

function NodeSelectButton({ node, active, connecting, reloadStatus }: { node: Node; active: boolean; connecting: boolean; reloadStatus: () => Promise<void> }) {
  const { t } = useTranslation()
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState('')

  const select = async () => {
    setError(''); setSelecting(true)
    try {
      await api.post('/api/nodes/select', { ip: node.ip, protocol: '' })
      await reloadStatus()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSelecting(false)
    }
  }

  return <button type="button" className={`secondary-button compact-action ${error ? 'error-tooltip' : ''}`} data-tooltip={error || undefined} aria-label={error ? t('node.connectFailedLabel', { error }) : undefined} disabled={connecting || selecting} onClick={select}>{connecting || selecting ? <><Spinner />{t('node.connectingAction')}</> : error ? t('node.connectFailed') : active ? t('node.reconnectPriority') : t('node.switch')}</button>
}

const NodeRow = memo(function NodeRow({ node, protocolPriority, active, activeProtocol, connecting, reloadStatus }: {
  node: Node
  protocolPriority: Protocol[]
  active: boolean
  activeProtocol?: Protocol
  connecting: boolean
  reloadStatus: () => Promise<void>
}) {
  const { t } = useTranslation()
  const availableProtocols = orderedProtocols(node.protocols, protocolPriority)
  return <article className={`node-row ${active ? 'active' : ''}`}>
    <div className="node-row-identity">
      <span className="country-mark small" aria-label={node.countryLong}>{countryFlag(node.countryShort)}</span>
      <div><strong>{node.countryShort || '—'} <span className="mono">{node.ip}</span></strong><small title={node.message}>{node.operator || node.hostName || t('node.unknownOperator')}</small></div>
    </div>
    <div className="protocol-list compact">{availableProtocols.map(protocol => <span key={protocol}>{protocolLabels[protocol]}</span>)}</div>
    <div className="node-row-metrics">
      <span><small>{t('node.vpnGate')}</small><b>{formatRate(node.speedBps)}</b></span>
      <span><small>{t('node.measured')}</small><b className={node.speedTestFailed ? 'failed' : node.measuredBps ? 'accent' : ''}>{node.speedTestFailed ? t('node.failed') : formatRate(node.measuredBps)}</b></span>
      <span><small>{t('node.latency')}</small><b>{node.pingMs > 0 ? `${node.pingMs} ms` : '—'}</b></span>
      <span><small>{t('node.score')}</small><b>{Math.round(node.score)}</b></span>
    </div>
    <div className="node-row-state"><NodeStateBadge active={active} connecting={connecting} activeProtocol={activeProtocol} /></div>
    <NodeSelectButton node={node} active={active} connecting={connecting} reloadStatus={reloadStatus} />
  </article>
})

function NodeTable({ nodes, protocolPriority, status, reloadStatus }: {
  nodes: Node[]
  protocolPriority: Protocol[]
  status?: Status
  reloadStatus: () => Promise<void>
}) {
  const { t } = useTranslation()
  return <div className="node-table-wrap">
    <table className="node-table">
      <thead><tr>
        <th>{t('nodes.tableNode')}</th>
        <th>{t('nodes.tableOperator')}</th>
        <th>{t('nodes.tableProtocols')}</th>
        <th className="num">{t('node.vpnGate')}</th>
        <th className="num">{t('node.measured')}</th>
        <th className="num">{t('node.latency')}</th>
        <th className="num">{t('node.score')}</th>
        <th>{t('nodes.tableState')}</th>
        <th />
      </tr></thead>
      <tbody>
        {nodes.map(node => {
          const active = status?.activeIp === node.ip
          const connecting = status?.connectingIp === node.ip
          return <tr key={node.ip} className={active ? 'active' : ''}>
            <td><div className="table-node"><span className="country-mark small">{countryFlag(node.countryShort)}</span><div><strong>{node.countryShort || '—'}</strong><span className="mono">{node.ip}</span></div></div></td>
            <td><span className="table-operator" title={node.message}>{node.operator || node.hostName || t('node.unknownOperator')}</span></td>
            <td><div className="protocol-list compact">{orderedProtocols(node.protocols, protocolPriority).map(protocol => <span key={protocol}>{protocolLabels[protocol]}</span>)}</div></td>
            <td className="num">{formatRate(node.speedBps)}</td>
            <td className={`num ${node.speedTestFailed ? 'failed' : node.measuredBps ? 'accent' : ''}`}>{node.speedTestFailed ? t('node.failed') : formatRate(node.measuredBps)}</td>
            <td className="num">{node.pingMs > 0 ? `${node.pingMs} ms` : '—'}</td>
            <td className="num">{Math.round(node.score)}</td>
            <td><NodeStateBadge active={active} connecting={connecting} activeProtocol={active ? status?.activeProtocol : undefined} /></td>
            <td><NodeSelectButton node={node} active={active} connecting={connecting} reloadStatus={reloadStatus} /></td>
          </tr>
        })}
      </tbody>
    </table>
  </div>
}

function GridIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg> }
function ListIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg> }
function TableIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11M15 9v11" /></svg> }

function Pagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  const { t } = useTranslation()
  const pages = Array.from({ length: Math.min(5, pageCount) }, (_, index) => {
    const start = Math.max(1, Math.min(page - 2, pageCount - 4))
    return start + index
  })
  return <nav className="pagination" aria-label={t('pagination.label')}><button disabled={page === 1} onClick={() => onChange(page - 1)}>{t('pagination.previous')}</button>{pages.map(value => <button className={value === page ? 'active' : ''} key={value} onClick={() => onChange(value)}>{value}</button>)}<button disabled={page === pageCount} onClick={() => onChange(page + 1)}>{t('pagination.next')}</button></nav>
}

function NodeSkeleton() {
  return <div className="node-grid">{Array.from({ length: 6 }, (_, index) => <div className="node-card skeleton-card" key={index}><i /><i /><i /><i /></div>)}</div>
}

function EmptyState({ query }: { query: string }) {
  const { t } = useTranslation()
  return <div className="empty-state"><SearchIcon /><h3>{query ? t('nodes.noMatches') : t('nodes.noNodes')}</h3><p>{query ? t('nodes.shortenSearch') : t('nodes.refreshFirst')}</p></div>
}

type SubscriptionTab = 'links' | 'clients' | 'builder' | 'front'

function Subscription() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<SubscriptionInfo>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState('')
  const [tab, setTab] = useState<SubscriptionTab>('links')

  const load = useCallback(() => {
    setLoading(true)
    api.get<SubscriptionInfo>('/api/subscription')
      .then(value => { setInfo(value); setError('') })
      .catch(reason => setError(errorMessage(reason)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const copy = async (key: string, value: string) => {
    if (!value) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const field = document.createElement('textarea')
        field.value = value
        field.style.position = 'fixed'
        field.style.opacity = '0'
        document.body.appendChild(field)
        field.select()
        document.execCommand('copy')
        field.remove()
      }
      setCopied(key)
      window.setTimeout(() => setCopied(current => current === key ? '' : current), 1600)
    } catch { /* clipboard unavailable */ }
  }

  return <div className="page-stack settings-page">
    <header className="page-heading">
      <div><p className="eyebrow">{t('subscription.eyebrow')}</p><h1>{t('subscription.heading')}</h1><p>{t('subscription.description')}</p></div>
      <button className="quiet-button" disabled={loading} onClick={load}>{loading ? <Spinner /> : <RefreshIcon />}{t('subscription.refresh')}</button>
    </header>
    <nav className="sub-tabs" role="tablist" aria-label={t('subscription.tabs.label')}>
      {(['links', 'clients', 'builder', 'front'] as SubscriptionTab[]).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{t(`subscription.tabs.${value}`)}</button>)}
    </nav>
    {error && <Notice tone="danger">{error}</Notice>}
    {info && !info.enabled && <Notice tone="warning">{t('subscription.disabled')}</Notice>}
    {info && info.enabled && tab === 'links' && <SubscriptionLinks info={info} copy={copy} copied={copied} />}
    {info && tab === 'clients' && <SubscriptionClients info={info} copy={copy} copied={copied} onChanged={load} />}
    {info && tab === 'builder' && <SubscriptionBuilder info={info} copy={copy} copied={copied} />}
    {info && tab === 'front' && <FrontProxyPanel initial={info.frontProxy} onSaved={load} />}
  </div>
}

function LinkField({ fieldKey, label, hint, value, copied, copy }: { fieldKey: string; label: string; hint: string; value: string; copied: string; copy: (key: string, value: string) => void }) {
  const { t } = useTranslation()
  return <Field label={label} hint={hint} wide>
    <div className="link-copy">
      <input readOnly value={value} placeholder="—" onFocus={event => event.currentTarget.select()} />
      <button type="button" className="quiet-button" disabled={!value} onClick={() => copy(fieldKey, value)}>{copied === fieldKey ? t('subscription.copied') : t('subscription.copy')}</button>
    </div>
  </Field>
}

function SubscriptionLinks({ info, copy, copied }: { info: SubscriptionInfo; copy: (key: string, value: string) => void; copied: string }) {
  const { t } = useTranslation()
  const qrValues = [
    { key: 'v2ray', label: t('subscription.v2rayLabel'), value: info.v2rayUrl },
    { key: 'clash', label: t('subscription.clashLabel'), value: info.clashUrl },
    { key: 'auto', label: t('subscription.autoLabel'), value: info.autoUrl },
  ].filter(entry => entry.value)
  return <>
    <SettingsSection index="01" title={t('subscription.linksTitle')} description={t('subscription.linksDescription')}>
      <LinkField fieldKey="v2ray" label={t('subscription.v2rayLabel')} hint={t('subscription.v2rayHint')} value={info.v2rayUrl} copied={copied} copy={copy} />
      <LinkField fieldKey="clash" label={t('subscription.clashLabel')} hint={t('subscription.clashHint')} value={info.clashUrl} copied={copied} copy={copy} />
      <LinkField fieldKey="auto" label={t('subscription.autoLabel')} hint={t('subscription.autoHint')} value={info.autoUrl} copied={copied} copy={copy} />
    </SettingsSection>
    {qrValues.length > 0 && <SettingsSection index="02" title={t('subscription.qrTitle')} description={t('subscription.qrHint')}>
      <div className="qr-grid wide">
        {qrValues.map(entry => <article className="qr-card" key={entry.key}>
          <QRCodeSVG value={entry.value} size={132} level="M" marginSize={2} bgColor="#ffffff" fgColor="#111827" />
          <strong>{entry.label}</strong>
          <button type="button" className="quiet-button" onClick={() => copy(`qr-${entry.key}`, entry.value)}>{copied === `qr-${entry.key}` ? t('subscription.copied') : t('subscription.copy')}</button>
        </article>)}
      </div>
    </SettingsSection>}
    <SettingsSection index={qrValues.length > 0 ? '03' : '02'} title={t('subscription.detailTitle')} description={t('subscription.detailDescription')}>
      <Field label={t('subscription.protocol')}><input readOnly value={`Trojan · WebSocket · TLS${info.udp ? ' · UDP' : ''}`} /></Field>
      <Field label={t('subscription.wsPath')}><input readOnly value={info.trojanPath} /></Field>
      <Field label={t('subscription.publicHost')}><input readOnly value={info.publicHost || '—'} /></Field>
      <Field label={t('subscription.token')}><input readOnly value={info.token} onFocus={event => event.currentTarget.select()} /></Field>
    </SettingsSection>
    <section className="status-grid">
      <article className="status-card"><div className="status-card-head"><span>{t('subscription.slotsReady')}</span><small>{t('subscription.slotsTotal', { count: info.slots.total })}</small></div><strong>{info.slots.ready}</strong><p>{t('subscription.readyHint')}</p></article>
      <article className="status-card"><div className="status-card-head"><span>{t('subscription.slotsSwitching')}</span><i /></div><strong>{info.slots.switching}</strong><p>{t('subscription.switchingHint')}</p></article>
      <article className="status-card"><div className="status-card-head"><span>{t('subscription.slotsError')}</span></div><strong>{info.slots.error}</strong><p>{t('subscription.errorHint')}</p></article>
      <article className="status-card"><div className="status-card-head"><span>{t('subscription.nodesInProfile')}</span><small>{t('subscription.nodesUnit')}</small></div><strong>{info.slots.ready}</strong><p>{t('subscription.nodesHint')}</p></article>
    </section>
  </>
}

type SubscriptionOptions = { count: number; countries: string[]; exclude: string[]; shuffle: boolean; group: boolean; sort: string }

function buildSubscriptionUrl(base: string, options: SubscriptionOptions) {
  if (!base) return ''
  const params = new URLSearchParams()
  if (options.count > 0) params.set('count', String(options.count))
  if (options.countries.length > 0) params.set('countries', options.countries.join(','))
  if (options.exclude.length > 0) params.set('exclude', options.exclude.join(','))
  if (options.shuffle) params.set('shuffle', '1')
  if (options.group) params.set('group', 'country')
  if (options.sort) params.set('sort', options.sort)
  const query = params.toString()
  if (!query) return base
  return `${base}${base.includes('?') ? '&' : '?'}${query}`
}

function SubscriptionBuilder({ info, copy, copied }: { info: SubscriptionInfo; copy: (key: string, value: string) => void; copied: string }) {
  const { t } = useTranslation()
  const [count, setCount] = useState(0)
  const [countries, setCountries] = useState<string[]>([])
  const [exclude, setExclude] = useState<string[]>([])
  const [shuffle, setShuffle] = useState(false)
  const [group, setGroup] = useState(false)
  const [sort, setSort] = useState('')

  const countryEntries = useMemo(() => Object.entries(info.countries).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])), [info.countries])
  const options: SubscriptionOptions = { count, countries, exclude, shuffle, group, sort }
  const v2rayUrl = buildSubscriptionUrl(info.v2rayUrl, options)
  const clashUrl = buildSubscriptionUrl(info.clashUrl, options)
  const available = useMemo(() => info.nodes.filter(node => {
    if (node.country && exclude.includes(node.country)) return false
    if (countries.length === 0) return true
    return Boolean(node.country && countries.includes(node.country))
  }), [info.nodes, countries, exclude])
  const preview = count > 0 ? available.slice(0, count) : available

  const toggleInclude = (code: string) => {
    setExclude(current => current.filter(item => item !== code))
    setCountries(current => current.includes(code) ? current.filter(item => item !== code) : [...current, code])
  }
  const toggleExclude = (code: string) => {
    setCountries(current => current.filter(item => item !== code))
    setExclude(current => current.includes(code) ? current.filter(item => item !== code) : [...current, code])
  }

  return <>
    <SettingsSection index="01" title={t('subscription.builderTitle')} description={t('subscription.builderDescription')}>
      <Field label={t('subscription.builderCount')} hint={t('subscription.builderCountHint')}><input type="number" min={0} max={info.nodes.length} value={count} onChange={event => setCount(Math.max(0, Number(event.target.value) || 0))} /></Field>
      <Field label={t('subscription.builderSort')} hint={t('subscription.builderSortHint')}><select value={sort} onChange={event => setSort(event.target.value)}><option value="">{t('subscription.builderSortDefault')}</option><option value="country">{t('subscription.builderSortCountry')}</option><option value="name">{t('subscription.builderSortName')}</option></select></Field>
      <label className="toggle-field"><input type="checkbox" checked={shuffle} onChange={event => setShuffle(event.target.checked)} /><span><strong>{t('subscription.builderShuffle')}</strong><small>{t('subscription.builderShuffleHint')}</small></span></label>
      <label className="toggle-field"><input type="checkbox" checked={group} onChange={event => setGroup(event.target.checked)} /><span><strong>{t('subscription.builderGroup')}</strong><small>{t('subscription.builderGroupHint')}</small></span></label>
      <div className="country-picker wide">
        <div className="country-picker-head"><strong>{t('subscription.builderCountries')}</strong><small>{t('subscription.builderCountriesHint')}</small><button type="button" className="quiet-button" disabled={countries.length === 0} onClick={() => setCountries([])}>{t('subscription.builderClear')}</button></div>
        <div className="chip-grid">{countryEntries.map(([code, total]) => <button type="button" key={code} className={`chip ${countries.includes(code) ? 'active' : ''}`} aria-pressed={countries.includes(code)} onClick={() => toggleInclude(code)}><span>{countryFlag(code)} {code}</span><small>{total}</small></button>)}</div>
      </div>
      <div className="country-picker wide exclude">
        <div className="country-picker-head"><strong>{t('subscription.builderExclude')}</strong><small>{t('subscription.builderExcludeHint')}</small><button type="button" className="quiet-button" disabled={exclude.length === 0} onClick={() => setExclude([])}>{t('subscription.builderClear')}</button></div>
        <div className="chip-grid">{countryEntries.map(([code, total]) => <button type="button" key={code} className={`chip exclude ${exclude.includes(code) ? 'active' : ''}`} aria-pressed={exclude.includes(code)} onClick={() => toggleExclude(code)}><span>{countryFlag(code)} {code}</span><small>{total}</small></button>)}</div>
      </div>
    </SettingsSection>
    <SettingsSection index="02" title={t('subscription.builderPreview')} description={t('subscription.builderPreviewHint')}>
      <div className="builder-preview wide">
        <div className="builder-preview-head"><strong>{t('subscription.builderPreviewCount', { count: preview.length, total: info.nodes.length })}</strong>{shuffle && <span className="mini-badge">{t('subscription.builderShuffled')}</span>}</div>
        {preview.length === 0 ? <p className="muted-line">{t('subscription.builderEmpty')}</p> : <div className="preview-list">{preview.slice(0, 60).map(node => <div className="preview-item" key={node.slotId}><span>{countryFlag(node.country || '')}</span><span title={node.asnOrg}>{node.name}</span>{node.chained && <em>{t('subscription.chained')}</em>}</div>)}</div>}
        {preview.length > 60 && <small>{t('subscription.builderMore', { count: preview.length - 60 })}</small>}
      </div>
    </SettingsSection>
    <SettingsSection index="03" title={t('subscription.builderGenerate')} description={t('subscription.builderGenerateHint')}>
      <LinkField fieldKey="builder-v2ray" label={t('subscription.v2rayLabel')} hint={t('subscription.builderUrlHint')} value={v2rayUrl} copied={copied} copy={copy} />
      <LinkField fieldKey="builder-clash" label={t('subscription.clashLabel')} hint={t('subscription.builderUrlHint')} value={clashUrl} copied={copied} copy={copy} />
      <p className="section-note wide">{t('subscription.builderNote')}</p>
    </SettingsSection>
  </>
}

type ClientDraft = {
  name: string
  token: string
  count: number
  countries: string
  exclude: string
  shuffle: boolean
  group: string
  sort: string
}

function randomClientToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')
}

function clientDraftFrom(client: SubscriptionClientInfo): ClientDraft {
  return {
    name: client.name,
    token: client.token,
    count: client.count,
    countries: (client.countries ?? []).join(','),
    exclude: (client.exclude ?? []).join(','),
    shuffle: client.shuffle,
    group: client.group || 'country',
    sort: client.sort,
  }
}

function splitCountryCodes(raw: string) {
  return raw.split(/[\s,;|]+/).map(code => code.trim().toUpperCase()).filter(code => code.length === 2)
}

function SubscriptionClients({ info, copy, copied, onChanged }: { info: SubscriptionInfo; copy: (key: string, value: string) => void; copied: string; onChanged: () => void }) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState<ClientDraft[]>(() => info.clients.map(clientDraftFrom))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setDrafts(info.clients.map(clientDraftFrom))
  }, [info.clients])

  const savedByToken = useMemo(() => new Map(info.clients.map(client => [client.token, client])), [info.clients])
  const update = (index: number, patch: Partial<ClientDraft>) => setDrafts(current => current.map((draft, position) => position === index ? { ...draft, ...patch } : draft))
  const add = () => setDrafts(current => [...current, { name: `client-${current.length + 1}`, token: randomClientToken(), count: 0, countries: '', exclude: '', shuffle: false, group: 'country', sort: '' }])
  const remove = (index: number) => setDrafts(current => current.filter((_, position) => position !== index))

  const save = async () => {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await api.put('/api/subscription/clients', {
        clients: drafts.map(draft => ({
          name: draft.name.trim(),
          token: draft.token.trim(),
          count: Math.max(0, draft.count),
          countries: splitCountryCodes(draft.countries),
          exclude: splitCountryCodes(draft.exclude),
          shuffle: draft.shuffle,
          group: draft.group,
          sort: draft.sort,
        })),
      })
      setMessage(t('subscription.clientSaved'))
      onChanged()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return <>
    <SettingsSection index="01" title={t('subscription.clientsTitle')} description={t('subscription.clientsDescription')}>
      {drafts.length === 0 && <p className="muted-line wide">{t('subscription.clientEmpty')}</p>}
      <div className="client-grid wide">
        {drafts.map((draft, index) => {
          const saved = savedByToken.get(draft.token.trim())
          return <article className="client-card" key={`${draft.token}-${index}`}>
            <div className="client-card-head">
              <strong>{draft.name || t('subscription.clientName')}</strong>
              <button type="button" className="quiet-button danger" onClick={() => remove(index)}>{t('subscription.clientRemove')}</button>
            </div>
            <Field label={t('subscription.clientName')}><input value={draft.name} onChange={event => update(index, { name: event.target.value })} /></Field>
            <Field label={t('subscription.clientToken')}>
              <div className="link-copy">
                <input value={draft.token} onChange={event => update(index, { token: event.target.value })} />
                <button type="button" className="quiet-button" onClick={() => update(index, { token: randomClientToken() })}>{t('subscription.clientGenerate')}</button>
              </div>
            </Field>
            <div className="client-card-row">
              <Field label={t('subscription.clientCount')}><input type="number" min={0} max={256} value={draft.count} onChange={event => update(index, { count: Math.max(0, Number(event.target.value) || 0) })} /></Field>
              <Field label={t('subscription.clientGroup')}><select value={draft.group} onChange={event => update(index, { group: event.target.value })}><option value="country">{t('subscription.builderGroup')}</option><option value="none">{t('subscription.clientDefault')}</option></select></Field>
              <Field label={t('subscription.clientSort')}><select value={draft.sort} onChange={event => update(index, { sort: event.target.value })}><option value="">{t('subscription.builderSortDefault')}</option><option value="country">{t('subscription.builderSortCountry')}</option><option value="name">{t('subscription.builderSortName')}</option></select></Field>
            </div>
            <div className="client-card-row">
              <Field label={t('subscription.clientCountries')}><input placeholder="JP,KR" value={draft.countries} onChange={event => update(index, { countries: event.target.value })} /></Field>
              <Field label={t('subscription.clientExclude')}><input placeholder="US,RU" value={draft.exclude} onChange={event => update(index, { exclude: event.target.value })} /></Field>
            </div>
            <label className="toggle-field compact"><input type="checkbox" checked={draft.shuffle} onChange={event => update(index, { shuffle: event.target.checked })} /><span><strong>{t('subscription.clientShuffle')}</strong><small>{t('subscription.builderShuffleHint')}</small></span></label>
            {saved && saved.v2rayUrl && <div className="client-urls">
              <div className="client-qr"><QRCodeSVG value={saved.autoUrl || saved.v2rayUrl} size={104} level="M" marginSize={2} bgColor="#ffffff" fgColor="#111827" /></div>
              <div className="client-url-list">
                <LinkField fieldKey={`client-${index}-v2ray`} label={t('subscription.v2rayLabel')} hint={t('subscription.clientUrls')} value={saved.v2rayUrl} copied={copied} copy={copy} />
                <LinkField fieldKey={`client-${index}-clash`} label={t('subscription.clashLabel')} hint={t('subscription.clientUrls')} value={saved.clashUrl} copied={copied} copy={copy} />
              </div>
            </div>}
          </article>
        })}
      </div>
      <p className="section-note wide">{t('subscription.clientHint')}</p>
    </SettingsSection>
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="settings-actions">
      <div><strong>{message || t('subscription.clientsTitle')}</strong><small>{t('subscription.clientsDescription')}</small></div>
      <div className="client-actions">
        <button className="quiet-button" type="button" onClick={add}>{t('subscription.clientAdd')}</button>
        <button className="primary-button" type="button" disabled={saving} onClick={save}>{saving ? <Spinner /> : null}{t('subscription.clientSave')}</button>
      </div>
    </div>
  </>
}

function FrontProxyPanel({ initial, onSaved }: { initial: FrontProxySettings; onSaved: () => void }) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<FrontProxySettings>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => { setSettings(initial) }, [initial])

  const update = <Key extends keyof FrontProxySettings>(key: Key, value: FrontProxySettings[Key]) => setSettings(current => ({ ...current, [key]: value }))
  const needsURL = ['socks5', 'socks5h', 'http', 'https', 'list'].includes(settings.type)

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setMessage(''); setSaving(true)
    try {
      const saved = await api.put<FrontProxySettings>('/api/matrix/front-proxy', settings)
      setSettings(saved)
      setMessage(t('subscription.front.saved'))
      onSaved()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return <form onSubmit={submit}>
    <SettingsSection index="01" title={t('subscription.front.title')} description={t('subscription.front.description')}>
      <label className="toggle-field wide"><input type="checkbox" checked={settings.enabled} onChange={event => update('enabled', event.target.checked)} /><span><strong>{t('subscription.front.enable')}</strong><small>{t('subscription.front.enableHint')}</small></span></label>
      <Field label={t('subscription.front.type')} hint={t('subscription.front.typeHint')}>
        <select value={settings.type} onChange={event => update('type', event.target.value)}>
          <option value="socks5">SOCKS5</option>
          <option value="socks5h">SOCKS5 (remote DNS)</option>
          <option value="http">HTTP CONNECT</option>
          <option value="https">HTTPS CONNECT</option>
          <option value="list">{t('subscription.front.typeList')}</option>
          <option value="slot">{t('subscription.front.typeSlot')}</option>
          <option value="api">{t('subscription.front.typeApi')}</option>
        </select>
      </Field>
      {needsURL && <Field label={t('subscription.front.url')} hint={t('subscription.front.urlHint')} wide><input placeholder="socks5://user:pass@HOST:1080" value={settings.url} onChange={event => update('url', event.target.value)} /></Field>}
      {settings.type === 'slot' && <Field label={t('subscription.front.slot')} hint={t('subscription.front.slotHint')}><input type="number" min={1} value={settings.slot} onChange={event => update('slot', Number(event.target.value) || 0)} /></Field>}
      {settings.type === 'api' && <Field label={t('subscription.front.api')} hint={t('subscription.front.apiHint')} wide><input placeholder="https://API/proxies" value={settings.api} onChange={event => update('api', event.target.value)} /></Field>}
      <Field label={t('subscription.front.timeout')} hint={t('subscription.front.timeoutHint')}><input placeholder="15s" value={settings.timeout} onChange={event => update('timeout', event.target.value)} /></Field>
      <p className="section-note wide">{t('subscription.front.compatHint')}</p>
    </SettingsSection>
    {error && <Notice tone="danger">{error}</Notice>}
    {message && <Notice tone="success">{message}</Notice>}
    <div className="settings-actions"><div><strong>{t('subscription.front.applies')}</strong><small>{t('subscription.front.appliesHint')}</small></div><button className="primary-button" disabled={saving}>{saving ? <Spinner /> : null}{t('subscription.front.save')}</button></div>
  </form>
}

function Settings() {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<Config>()
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [restartRequired, setRestartRequired] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const load = useCallback(async () => {
    try { setSettings(await api.get<Config>('/api/config')); setError('') }
    catch (reason) { setError(errorMessage(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const update = <Key extends keyof Config>(key: Key, value: Config[Key]) => setSettings(current => current ? { ...current, [key]: value } : current)
  const moveProtocol = (index: number, offset: number) => {
    if (!settings) return
    const target = index + offset
    if (target < 0 || target >= settings.protocolPriority.length) return
    const protocols = [...settings.protocolPriority]
    ;[protocols[index], protocols[target]] = [protocols[target], protocols[index]]
    update('protocolPriority', protocols)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setMessage('')
    if (!settings) return
    setSaving(true)
    try {
      const result = await api.put<{ restartRequired: boolean }>('/api/config', { config: settings, newPassword })
      setRestartRequired(result.restartRequired)
      setMessage(result.restartRequired ? t('settings.savedRestart') : t('settings.saved'))
      setNewPassword('')
      await load()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const restart = async () => {
    if (!window.confirm(t('settings.restartConfirm'))) return
    setError(''); setMessage(t('settings.restarting')); setRestarting(true)
    try {
      await api.post('/api/restart')
      window.setTimeout(() => window.location.reload(), 2_500)
    } catch (reason) {
      setError(errorMessage(reason)); setMessage(''); setRestarting(false)
    }
  }

  if (!settings) return <div className="panel-loading"><Spinner />{t('settings.loading')}</div>
  return <form className="page-stack settings-page" onSubmit={submit}>
    <header className="page-heading"><div><p className="eyebrow">{t('settings.eyebrow')}</p><h1>{t('settings.heading')}</h1><p>{t('settings.description')}</p></div></header>
    {error && <Notice tone="danger">{error}</Notice>}
    {message && <Notice tone={restartRequired ? 'warning' : 'success'}>{message}</Notice>}

    <SettingsSection index="01" title={t('settings.sourceTitle')} description={t('settings.sourceDescription')}>
      <Field label={t('settings.sourceUrl')} wide><input value={settings.sourceUrl} onChange={event => update('sourceUrl', event.target.value)} /></Field>
      <Field label={t('settings.refreshInterval')} hint={t('settings.durationExample')}><input value={settings.refreshInterval} onChange={event => update('refreshInterval', event.target.value)} /></Field>
      <Field label={t('settings.connectTimeout')} hint={t('settings.connectTimeoutHint')}><input value={settings.connectTimeout} onChange={event => update('connectTimeout', event.target.value)} /></Field>
      <Field label={t('settings.automaticSort')}><select value={settings.selectionMode} onChange={event => update('selectionMode', event.target.value as Config['selectionMode'])}><option value="speed">{t('settings.sortSpeed')}</option><option value="ping">{t('settings.sortPing')}</option><option value="score">{t('settings.sortScore')}</option></select></Field>
      <label className="toggle-field"><input type="checkbox" checked={settings.followRankingOnRefresh} onChange={event => update('followRankingOnRefresh', event.target.checked)} /><span><strong>{t('settings.followRanking')}</strong><small>{t('settings.followRankingHint')}</small></span></label>
      <label className="toggle-field"><input type="checkbox" checked={settings.fallbackToDirect} onChange={event => update('fallbackToDirect', event.target.checked)} /><span><strong>{t('settings.fallbackToDirect')}</strong><small>{t('settings.fallbackToDirectHint')}</small></span></label>
      <Field label={t('settings.filter')} hint={t('settings.filterHint')} wide><textarea rows={6} spellCheck={false} value={settings.filterExpression} onChange={event => update('filterExpression', event.target.value)} /></Field>
      <FilterHelp />
    </SettingsSection>

    <SettingsSection index="02" title={t('settings.protocolTitle')} description={t('settings.protocolDescription')}>
      <div className="protocol-order">{settings.protocolPriority.map((protocol, index) => <div key={protocol}><b>{String(index + 1).padStart(2, '0')}</b><span>{protocolLabels[protocol]}</span><button type="button" disabled={index === 0} onClick={() => moveProtocol(index, -1)}>↑</button><button type="button" disabled={index === settings.protocolPriority.length - 1} onClick={() => moveProtocol(index, 1)}>↓</button></div>)}</div>
      <div className="settings-grid nested"><Field label={t('settings.vpnUsername')}><input value={settings.vpnGateUsername} onChange={event => update('vpnGateUsername', event.target.value)} /></Field><Field label={t('settings.vpnPassword')}><input type="password" value={settings.vpnGatePassword} onChange={event => update('vpnGatePassword', event.target.value)} /></Field><Field label={t('settings.psk')}><input type="password" value={settings.vpnGatePreSharedKey} onChange={event => update('vpnGatePreSharedKey', event.target.value)} /></Field></div>
    </SettingsSection>

    <SettingsSection index="03" title={t('settings.socksTitle')} description={t('settings.socksDescription')}>
      <Field label={t('settings.listenAddress')}><input value={settings.socks5.listenAddress} onChange={event => update('socks5', { ...settings.socks5, listenAddress: event.target.value })} /></Field>
      <Field label={t('settings.username')} hint={t('settings.noAuthHint')}><input value={settings.socks5.username} onChange={event => update('socks5', { ...settings.socks5, username: event.target.value })} /></Field>
      <Field label={t('settings.password')}><input type="password" value={settings.socks5.password} onChange={event => update('socks5', { ...settings.socks5, password: event.target.value })} /></Field>
      <Field label={t('settings.socksIdleTimeout')} hint={t('settings.socksIdleTimeoutHint')}><input placeholder="5m" value={settings.socks5.idleTimeout} onChange={event => update('socks5', { ...settings.socks5, idleTimeout: event.target.value })} /></Field>
      <Field label={t('settings.socksHalfCloseTimeout')} hint={t('settings.socksHalfCloseTimeoutHint')}><input placeholder="1m" value={settings.socks5.halfCloseTimeout} onChange={event => update('socks5', { ...settings.socks5, halfCloseTimeout: event.target.value })} /></Field>
    </SettingsSection>

    <SettingsSection index="04" title={t('settings.probeTitle')} description={t('settings.probeDescription')}>
      <Field label={t('settings.dnsServers')} hint={t('settings.dnsHint')} wide><input value={settings.dnsServers.join(', ')} onChange={event => update('dnsServers', event.target.value.split(',').map(value => value.trim()))} /></Field>
      <Field label={t('settings.speedUrl')} hint={t('settings.speedUrlHint')} wide><input type="url" value={settings.speedTestUrl} onChange={event => update('speedTestUrl', event.target.value)} /></Field>
      <Field label={t('settings.speedTimeout')} hint={t('settings.speedTimeoutHint')}><input value={settings.speedTestTimeout} onChange={event => update('speedTestTimeout', event.target.value)} /></Field>
      <Field label={t('settings.healthUrl')} wide><input value={settings.monitor.url} onChange={event => update('monitor', { ...settings.monitor, url: event.target.value })} /></Field>
      <Field label={t('settings.checkInterval')}><input value={settings.monitor.interval} onChange={event => update('monitor', { ...settings.monitor, interval: event.target.value })} /></Field>
      <Field label={t('settings.requestTimeout')}><input value={settings.monitor.timeout} onChange={event => update('monitor', { ...settings.monitor, timeout: event.target.value })} /></Field>
    </SettingsSection>

    <SettingsSection index="05" title={t('settings.adminTitle')} description={t('settings.adminDescription')}>
      <Field label={t('settings.databasePath')}><input value={settings.databasePath} onChange={event => update('databasePath', event.target.value)} /></Field>
      <Field label={t('settings.webListen')}><input value={settings.web.listenAddress} onChange={event => update('web', { ...settings.web, listenAddress: event.target.value })} /></Field>
      <Field label={t('settings.webUsername')}><input value={settings.web.username} onChange={event => update('web', { ...settings.web, username: event.target.value })} /></Field>
      <Field label={t('settings.newPassword')} hint={t('settings.newPasswordHint')}><input type="password" minLength={8} value={newPassword} onChange={event => setNewPassword(event.target.value)} /></Field>
    </SettingsSection>

    <div className="settings-actions"><div><strong>{restartRequired ? t('settings.restartPending') : t('settings.writesLocal')}</strong><small>{t('settings.sensitiveHint')}</small></div><button type="button" className="danger-button" disabled={restarting} onClick={restart}>{restarting ? <Spinner /> : <RestartIcon />}{t('settings.restart')}</button><button className="primary-button" disabled={saving}>{saving ? <Spinner /> : null}{t('settings.save')}</button></div>
  </form>
}

function SettingsSection({ index, title, description, children }: { index: string; title: string; description: string; children: ReactNode }) {
  return <section className="settings-section"><header><span>{index}</span><div><h2>{title}</h2><p>{description}</p></div></header><div className="settings-grid">{children}</div></section>
}

function FilterHelp() {
  const { t } = useTranslation()
  return <aside className="filter-help">
    <div className="filter-help-intro"><strong>{t('filter.rules')}</strong><p>{t('filter.intro')}</p></div>
    <div className="filter-help-grid">
      <section><strong>{t('filter.textFields')}</strong><code>hostName</code><code>ip</code><code>countryLong</code><code>countryShort</code><code>logType</code><code>operator</code><code>operatorMessage</code></section>
      <section><strong>{t('filter.numberFields')}</strong><code>score</code><code>pingMs</code><code>speedBps</code><code>sessions</code><code>uptimeMs</code><code>totalUsers</code><code>totalTraffic</code></section>
      <section><strong>{t('filter.protocols')}</strong><code>protocols</code><p>{t('filter.protocolsHint')}</p></section>
      <section><strong>{t('filter.helpers')}</strong><code>cidrContains(cidr, ip)</code><code>includesIgnoreCase(value, search)</code><p>{t('filter.helpersHint')}</p></section>
    </div>
    <div className="filter-units"><span><code>pingMs</code>: {t('filter.milliseconds')}</span><span><code>speedBps</code>: bit/s</span><span><code>uptimeMs</code>: {t('filter.milliseconds')}</span><span><code>totalTraffic</code>: bytes</span></div>
    <strong className="filter-example-title">{t('filter.example')}</strong>
    <pre><code>{`node.countryShort === "JP" &&
node.pingMs > 0 && node.pingMs < 100 &&
node.protocols.includes("openvpn_udp") &&
!includesIgnoreCase(node.operatorMessage, "academic use only")`}</code></pre>
    <p className="filter-help-note">{t('filter.operators')} <code>cidrContains("219.100.0.0/16", node.ip)</code></p>
  </aside>
}

function LanguageSelect() {
  const { t, i18n } = useTranslation()
  const locale = resolvedLocale(i18n.resolvedLanguage)

  return <select
    className="locale-select"
    aria-label={t('language.label')}
    value={locale}
    onChange={event => void i18n.changeLanguage(event.target.value)}
  >
    {Object.entries(localeConfig.resources).map(([value, resource]) => <option value={value} key={value}>{resource.label}</option>)}
  </select>
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

function Notice({ tone, children }: { tone: 'danger' | 'warning' | 'success'; children: ReactNode }) {
  return <div className={`notice ${tone}`}><i />{children}</div>
}

function Spinner() { return <span className="spinner" aria-hidden="true" /> }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" /></svg> }
function RestartIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6M20 20v-6h-6M5.5 15a8 8 0 0 0 13-3M18.5 9A8 8 0 0 0 5.5 6" /></svg> }
function SearchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg> }
function SpeedIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17a8 8 0 1 1 16 0M12 17l4-6" /><path d="M7 17h10" /></svg> }
function StopIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> }
function ThemeIcon({ theme }: { theme: Theme }) { return theme === 'dark' ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /></svg> }

function delay(milliseconds: number) { return new Promise(resolve => window.setTimeout(resolve, milliseconds)) }
function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
function orderedProtocols(protocols: Protocol[], priority: Protocol[]) {
  const order = [...priority, ...protocolDisplayOrder.filter(protocol => !priority.includes(protocol))]
  return order.filter(protocol => protocols.includes(protocol))
}
function preferredTheme(): Theme {
  const saved = window.localStorage.getItem('proxygate:theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
function preferredNodeView(): NodeViewMode {
  const saved = window.localStorage.getItem('proxygate:nodeView')
  return saved === 'cards' || saved === 'list' || saved === 'table' ? saved : 'cards'
}
function normalizedPing(value: number) { return value > 0 ? value : Number.MAX_SAFE_INTEGER }
function stateLabel(state: string | undefined, t: TFunction) {
  const labels: Record<string, string> = {
    connected: t('status.connected'),
    connecting: t('status.connecting'),
    error: t('status.error'),
    idle: t('status.idle'),
  }
  return labels[state || ''] || state || t('status.loading')
}
function formatDateTime(value: string, locale: string) { return new Date(value).toLocaleString(locale, { hour12: false }) }
function formatRelativeTime(value: string | Date | undefined, t: TFunction) {
  if (!value) return t('time.never')
  const milliseconds = Date.now() - new Date(value).getTime()
  if (milliseconds < 10_000) return t('time.now')
  if (milliseconds < 60_000) return t('time.secondsAgo', { count: Math.floor(milliseconds / 1_000) })
  if (milliseconds < 3_600_000) return t('time.minutesAgo', { count: Math.floor(milliseconds / 60_000) })
  return t('time.hoursAgo', { count: Math.floor(milliseconds / 3_600_000) })
}
function formatNumber(value: number, locale: string) { return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value) }
function formatRate(bitsPerSecond: number) {
  if (!bitsPerSecond) return '—'
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps']
  let value = bitsPerSecond; let unit = 0
  while (value >= 1_000 && unit < units.length - 1) { value /= 1_000; unit++ }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}
function countryFlag(code: string) {
  const normalized = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(normalized)) return '◎'
  return String.fromCodePoint(...[...normalized].map(character => 127397 + character.charCodeAt(0)))
}

export default App
