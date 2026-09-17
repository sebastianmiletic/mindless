import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow, CalendarClock, FolderPen, Globe2, Info, Layers3, Minus, Pencil, Plus, Save, ShieldCheck, Trash2, X } from "lucide-react";

type BlockedApp = { name: string; path: string };
type Cluster = { id: string; name: string; apps: BlockedApp[]; sites: string[] };
type LockSession = { start_at: number; ends_at: number; app_count: number; site_count: number; targets: string[] };
type LockState = { active: boolean; ends_at: number | null; app_count: number; site_count: number; sessions: LockSession[] };

const emptyState: LockState = { active: false, ends_at: null, app_count: 0, site_count: 0, sessions: [] };
const pad = (value: number) => String(value).padStart(2, "0");
const loadClusters = (): Cluster[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("mindless-clusters") ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const cluster = item as Partial<Cluster>;
      const valid = typeof cluster.id === "string" && typeof cluster.name === "string" && cluster.name.length <= 32
        && Array.isArray(cluster.apps) && cluster.apps.length <= 50 && cluster.apps.every(app => app && typeof app.name === "string" && typeof app.path === "string")
        && Array.isArray(cluster.sites) && cluster.sites.length <= 50 && cluster.sites.every(site => typeof site === "string");
      if (!valid) return [];
      return [{ id: cluster.id!, name: cluster.name!, apps: cluster.apps!, sites: cluster.sites! }];
    }).slice(0, 50);
  } catch { return []; }
};

const createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const toLocalDateTime = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const defaultScheduleTime = () => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return toLocalDateTime(date);
};
const loadDuration = () => {
  const value = Number(localStorage.getItem("mindless-duration"));
  return Number.isFinite(value) && value >= 15 && value <= 720 && value % 15 === 0 ? value : 60;
};
const loadDraft = () => {
  try {
    const value = JSON.parse(localStorage.getItem("mindless-draft") ?? "{}");
    const apps = Array.isArray(value.apps) ? value.apps.filter((app: unknown): app is BlockedApp => !!app && typeof app === "object" && typeof (app as BlockedApp).name === "string" && typeof (app as BlockedApp).path === "string").slice(0, 50) : [];
    const sites = Array.isArray(value.sites) ? value.sites.filter((site: unknown): site is string => typeof site === "string").slice(0, 50) : [];
    const siteInput = typeof value.siteInput === "string" ? value.siteInput.slice(0, 253) : "";
    const selectedClusters = Array.isArray(value.selectedClusters) ? value.selectedClusters.filter((id: unknown): id is string => typeof id === "string").slice(0, 50) : [];
    return { apps, sites, siteInput, selectedClusters };
  } catch { return { apps: [] as BlockedApp[], sites: [] as string[], siteInput: "", selectedClusters: [] as string[] }; }
};

function App() {
  const initialDraft = useMemo(loadDraft, []);
  const [now, setNow] = useState(new Date());
  const [apps, setApps] = useState<BlockedApp[]>(initialDraft.apps);
  const [sites, setSites] = useState<string[]>(initialDraft.sites);
  const [siteInput, setSiteInput] = useState(initialDraft.siteInput);
  const [selectedClusters, setSelectedClusters] = useState<string[]>(initialDraft.selectedClusters);
  const [minutes, setMinutes] = useState(loadDuration);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => localStorage.getItem("mindless-schedule-at") ?? defaultScheduleTime());
  const [lock, setLock] = useState<LockState>(emptyState);
  const [clusters, setClusters] = useState<Cluster[]>(loadClusters);
  const [clusterName, setClusterName] = useState("");
  const [editingCluster, setEditingCluster] = useState<string | null>(null);
  const [showClusterEditor, setShowClusterEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appPickerBusy, setAppPickerBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const dialDrag = useRef<{ pointerId: number; startX: number; startMinutes: number } | null>(null);

  useEffect(() => {
    const refresh = () => invoke<LockState>("get_lock_state").then(setLock).catch(() => undefined);
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    const sync = window.setInterval(refresh, 3000);
    refresh();
    return () => { window.clearInterval(tick); window.clearInterval(sync); };
  }, []);

  useEffect(() => { localStorage.setItem("mindless-clusters", JSON.stringify(clusters)); }, [clusters]);
  useEffect(() => { localStorage.setItem("mindless-duration", String(minutes)); }, [minutes]);
  useEffect(() => { localStorage.setItem("mindless-schedule-at", scheduleAt); }, [scheduleAt]);
  useEffect(() => { localStorage.setItem("mindless-draft", JSON.stringify({ apps, sites, siteInput, selectedClusters })); }, [apps, sites, siteInput, selectedClusters]);
  useEffect(() => {
    if (lock.active && lock.ends_at && Math.floor(Date.now() / 1000) >= lock.ends_at) setLock(emptyState);
  }, [now, lock]);

  const clock = useMemo(() => {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(now);
    return {
      hour: parts.find(p => p.type === "hour")?.value ?? "00",
      minute: parts.find(p => p.type === "minute")?.value ?? "00",
      period: parts.find(p => p.type === "dayPeriod")?.value ?? "",
      month: new Intl.DateTimeFormat("en-US", { month: "short" }).format(now).toUpperCase(),
      day: pad(now.getDate())
    };
  }, [now]);

  const selectedGroupData = useMemo(() => clusters.filter(cluster => selectedClusters.includes(cluster.id)), [clusters, selectedClusters]);
  const resolvedDraft = useMemo(() => {
    const groupedApps = selectedGroupData.flatMap(cluster => cluster.apps);
    const groupedSites = selectedGroupData.flatMap(cluster => cluster.sites);
    return {
      apps: [...new Map([...apps, ...groupedApps].map(app => [app.path, app])).values()],
      sites: [...new Set([...sites, ...groupedSites])]
    };
  }, [apps, sites, selectedGroupData]);
  const draftUnitCount = apps.length + sites.length + selectedGroupData.length;

  async function chooseApp() {
    if (appPickerBusy || apps.length >= 50) return;
    setNotice(""); setAppPickerBusy(true);
    try {
      const app = await invoke<BlockedApp | null>("choose_application");
      if (!app) return;
      if (apps.some(item => item.path === app.path)) setNotice(`${app.name} is already selected.`);
      else setApps([...apps, app]);
    } catch (error) { setNotice(String(error)); }
    finally { setAppPickerBusy(false); }
  }

  function addSite() {
    const normalized = siteInput.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    if (!normalized || !normalized.includes(".")) return setNotice("Enter a domain such as youtube.com.");
    if (normalized.length > 253 || !/^[a-z0-9.-]+$/.test(normalized)) return setNotice("That domain is not valid.");
    if (sites.includes(normalized)) return setNotice(`${normalized} is already selected.`);
    if (sites.length >= 50) return setNotice("A lock can contain up to 50 websites.");
    setSites([...sites, normalized]); setSiteInput(""); setNotice("");
  }

  function applyCluster(cluster: Cluster) {
    if (selectedClusters.includes(cluster.id)) return setNotice(`${cluster.name} is already in Targets.`);
    setSelectedClusters([...selectedClusters, cluster.id]); setNotice(`${cluster.name} added to Targets.`);
  }

  function beginCluster(cluster?: Cluster) {
    if (cluster) {
      setApps(cluster.apps); setSites(cluster.sites); setSelectedClusters([]); setClusterName(cluster.name);
      setEditingCluster(cluster.id);
    } else {
      if (resolvedDraft.apps.length + resolvedDraft.sites.length === 0) return setNotice("Select apps or websites before saving a group.");
      setClusterName(""); setEditingCluster(null);
    }
    setShowClusterEditor(true); setNotice("");
  }

  function saveCluster() {
    const name = clusterName.trim();
    if (!name) return setNotice("Name this cluster first.");
    if (name.length > 32) return setNotice("Cluster names can contain up to 32 characters.");
    if (!editingCluster && clusters.length >= 50) return setNotice("You can save up to 50 clusters.");
    if (resolvedDraft.apps.length + resolvedDraft.sites.length === 0) return setNotice("Add at least one target to the group.");
    if (editingCluster) {
      setClusters(clusters.map(item => item.id === editingCluster ? { ...item, name, apps: [...resolvedDraft.apps], sites: [...resolvedDraft.sites] } : item));
    } else {
      setClusters([...clusters, { id: createId(), name, apps: [...resolvedDraft.apps], sites: [...resolvedDraft.sites] }]);
    }
    setShowClusterEditor(false); setEditingCluster(null); setClusterName(""); setNotice("");
  }

  function deleteCluster(id: string) {
    if (pendingDelete !== id) { setPendingDelete(id); window.setTimeout(() => setPendingDelete(current => current === id ? null : current), 3000); return; }
    setClusters(clusters.filter(item => item.id !== id)); setSelectedClusters(selectedClusters.filter(clusterId => clusterId !== id)); setPendingDelete(null);
    if (editingCluster === id) { setEditingCluster(null); setShowClusterEditor(false); }
  }

  async function beginLock() {
    if (busy) return;
    if (resolvedDraft.apps.length + resolvedDraft.sites.length === 0) return setNotice("Choose at least one app, website, or group.");
    const startAt = scheduleMode ? Math.floor(new Date(scheduleAt).getTime() / 1000) : null;
    if (scheduleMode && (!startAt || startAt < Math.floor(Date.now() / 1000) + 30)) return setNotice("Choose a schedule time at least 30 seconds from now.");
    setBusy(true); setNotice("");
    try {
      const state = await invoke<LockState>("start_lock", { request: { apps: resolvedDraft.apps, sites: resolvedDraft.sites, minutes, start_at: startAt } });
      setLock(state); setApps([]); setSites([]); setSelectedClusters([]);
      if (scheduleMode) { setNotice(`Scheduled for ${new Date(scheduleAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}.`); setScheduleAt(defaultScheduleTime()); }
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  function beginDialDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dialDrag.current = { pointerId: event.pointerId, startX: event.clientX, startMinutes: minutes };
  }

  function moveDial(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dialDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const steps = Math.round((event.clientX - drag.startX) / 5);
    setMinutes(Math.min(720, Math.max(15, drag.startMinutes + steps * 15)));
  }

  function endDialDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dialDrag.current?.pointerId === event.pointerId) dialDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const dialStyle = { "--dial-angle": `${(minutes - 15) / 705 * 360}deg` } as CSSProperties;
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const hasLiveLock = lock.sessions.some(session => !session.start_at || session.start_at <= nowEpoch);

  return (
    <main className="shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="signal" aria-label={hasLiveLock ? "Lock active" : lock.active ? "Lock scheduled" : "Ready"}><i /><i /><i /><i /><i /></div>
        <div className="wordmark">MINDLESS</div>
        <div className="status"><span className={lock.active ? "status-dot active" : "status-dot"} />{hasLiveLock ? "LOCKED" : lock.active ? "SCHEDULED" : "READY"}<button className="window-close" title="Hide Mindless" aria-label="Hide Mindless" onClick={() => getCurrentWindow().hide()}><X size={12} /></button></div>
      </header>

      <section className="workspace">
        <aside className={lock.active ? "time-panel has-locks" : "time-panel"}>
          <div className="date"><span>{clock.month}</span><strong>{clock.day}</strong></div>
          <div className="time" aria-label={`${clock.hour}:${clock.minute} ${clock.period}`}><span>{clock.hour}</span><span>{clock.minute}</span></div>
          <div className="period">{clock.period}</div>

          {lock.active && <section className="left-locks" aria-label="Active locks">
            <div className="left-locks-heading"><span><ShieldCheck size={11} /> SESSIONS</span><strong>{pad(lock.sessions.length)}</strong></div>
            <div className="left-lock-list">{lock.sessions.map((session, index) => {
              const scheduled = session.start_at > nowEpoch;
              const left = Math.max(0, (scheduled ? session.start_at : session.ends_at) - nowEpoch);
              return <div className={scheduled ? "left-lock scheduled" : "left-lock"} key={`${session.ends_at}-${index}`} title={session.targets.join(", ")}><div><span>{scheduled ? "SCHEDULE" : "LOCK"} {pad(index + 1)}</span><small>{session.targets.length ? session.targets.join(" · ") : `${session.app_count + session.site_count} targets`}</small></div><strong>{scheduled ? "IN " : ""}{pad(Math.floor(left / 3600))}:{pad(Math.floor((left % 3600) / 60))}:{pad(left % 60)}</strong></div>;
            })}</div>
          </section>}

          <div className="ticks" aria-hidden="true">{Array.from({ length: 16 }).map((_, i) => <i key={i} className={i < (now.getMinutes() / 60) * 16 ? "lit" : ""} />)}</div>
          <p className="time-caption">LOCAL TIME</p>
        </aside>

        <section className="control-panel">
          <div className="setup-view">
            <div className="cluster-section">
              <div className="micro-heading"><span><Layers3 size={12} /> GROUPS</span><button disabled={resolvedDraft.apps.length + resolvedDraft.sites.length === 0} onClick={() => beginCluster()}><Plus size={13} /> SAVE SET</button></div>
              <div className="cluster-rack">
                {clusters.length === 0 && <div className="cluster-empty"><FolderPen size={14} /> Select targets, then save</div>}
                {clusters.map(cluster => <div className={selectedClusters.includes(cluster.id) ? "cluster selected" : "cluster"} key={cluster.id}>
                  <button className="cluster-load" title={`Add ${cluster.name} to Targets`} onClick={() => applyCluster(cluster)}><span>{cluster.name}</span><small>{pad(cluster.apps.length + cluster.sites.length)}</small></button>
                  <button title={`Edit ${cluster.name}`} aria-label={`Edit ${cluster.name}`} onClick={() => beginCluster(cluster)}><Pencil size={12} /></button>
                  <button className={pendingDelete === cluster.id ? "delete-confirm" : ""} title={pendingDelete === cluster.id ? "Click again to delete" : `Delete ${cluster.name}`} aria-label={pendingDelete === cluster.id ? `Confirm deletion of ${cluster.name}` : `Delete ${cluster.name}`} onClick={() => deleteCluster(cluster.id)}>{pendingDelete === cluster.id ? <span>?</span> : <Trash2 size={12} />}</button>
                </div>)}
              </div>
              {showClusterEditor && <div className="cluster-editor"><input autoFocus maxLength={32} aria-label="Cluster name" placeholder="Cluster name" value={clusterName} onChange={e => setClusterName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveCluster(); if (e.key === "Escape") setShowClusterEditor(false); }} /><button onClick={saveCluster}><Save size={13} /> {editingCluster ? "UPDATE" : "SAVE"}</button><button title="Cancel" aria-label="Close cluster editor" onClick={() => setShowClusterEditor(false)}><X size={13} /></button></div>}
            </div>

            <div className="section-heading"><div><p className="eyebrow">01 / TARGETS</p><h1>What goes quiet?</h1></div><span>{pad(draftUnitCount)}</span></div>
            <div className="target-list" aria-live="polite">
              {selectedGroupData.map(group => <div className="target-row group-target" key={group.id}><Layers3 size={15} /><span>{group.name}<small>{group.apps.length + group.sites.length} targets</small></span><button aria-label={`Remove ${group.name}`} onClick={() => setSelectedClusters(selectedClusters.filter(id => id !== group.id))}><X size={14} /></button></div>)}
              {apps.map(app => <div className="target-row" key={app.path}><AppWindow size={15} /><span>{app.name}</span><button aria-label={`Remove ${app.name}`} onClick={() => setApps(apps.filter(a => a.path !== app.path))}><X size={14} /></button></div>)}
              {sites.map(site => <div className="target-row" key={site}><Globe2 size={15} /><span>{site}</span><button aria-label={`Remove ${site}`} onClick={() => setSites(sites.filter(s => s !== site))}><X size={14} /></button></div>)}
              {draftUnitCount === 0 && <div className="empty-targets">Choose targets or add a group</div>}
            </div>

            <div className="add-controls">
              <button className="add-app" disabled={appPickerBusy} onClick={chooseApp}><Plus size={14} /> {appPickerBusy ? "Choosing…" : "Choose app"}</button>
              <form onSubmit={event => { event.preventDefault(); addSite(); }}><input maxLength={253} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Website domain" value={siteInput} onChange={event => setSiteInput(event.target.value)} placeholder="website.com" /><button title="Add website" aria-label="Add website" type="submit"><Plus size={14} /></button></form>
            </div>

            <div className="duration-block">
              <div className="duration-title"><span>02 / DURATION</span><small>15 MIN · 12 H MAX</small></div>
              <div className="dial-row">
                <button className="dial-step" aria-label="Subtract 15 minutes" onClick={() => setMinutes(Math.max(15, minutes - 15))}><Minus size={14} /></button>
                <div className="duration-dial" style={dialStyle} role="group" aria-label="Duration dial. Hold and drag left or right." onPointerDown={beginDialDrag} onPointerMove={moveDial} onPointerUp={endDialDrag} onPointerCancel={endDialDrag} onWheel={event => { event.preventDefault(); setMinutes(current => Math.min(720, Math.max(15, current + (event.deltaY > 0 ? -15 : 15)))); }}>
                  <div className="dial-ticks" aria-hidden="true">{Array.from({ length: 24 }).map((_, index) => <i key={index} style={{ transform: `rotate(${index * 15}deg)` }} />)}</div>
                  <div className="dial-hand" aria-hidden="true" />
                  <div className="dial-value"><strong>{pad(Math.floor(minutes / 60))}</strong><span>H</span><strong>{pad(minutes % 60)}</strong><span>M</span></div>
                  <input type="range" min="15" max="720" step="15" value={minutes} aria-label="Lock duration in minutes" onChange={event => setMinutes(Number(event.target.value))} />
                </div>
                <button className="dial-step" aria-label="Add 15 minutes" onClick={() => setMinutes(Math.min(720, minutes + 15))}><Plus size={14} /></button>
              </div>
            </div>

            <div className="launch-controls">
              <div className="launch-mode" aria-label="Lock start mode"><button className={!scheduleMode ? "selected" : ""} onClick={() => setScheduleMode(false)}>NOW</button><button className={scheduleMode ? "selected" : ""} onClick={() => setScheduleMode(true)}><CalendarClock size={11} /> SCHEDULE</button></div>
              {scheduleMode && <input className="schedule-input" type="datetime-local" value={scheduleAt} min={toLocalDateTime(new Date(Date.now() + 30_000))} max={toLocalDateTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))} onChange={event => setScheduleAt(event.target.value)} aria-label="Schedule start date and time" />}
            </div>
            {notice && <p className="notice" role="status"><Info size={11} />{notice}</p>}
            <div className="commit-row"><button className="commit" disabled={busy || resolvedDraft.apps.length + resolvedDraft.sites.length === 0} onClick={beginLock}><span className="commit-mark" />{busy ? "UPDATING GUARD…" : scheduleMode ? "SCHEDULE LOCK" : lock.active ? "ADD LOCK" : "LOCK NOW"}</button></div>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
