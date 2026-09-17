import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow, CalendarDays, ChevronLeft, FolderPen, Globe2, Info, Layers3, Minus, Palette, Pencil, Plus, Save, Settings2, ShieldCheck, Trash2, X } from "lucide-react";

type BlockedApp = { name: string; path: string };
type Cluster = { id: string; name: string; apps: BlockedApp[]; sites: string[] };
type LockSession = { start_at: number; ends_at: number; app_count: number; site_count: number; targets: string[] };
type LockState = { active: boolean; ends_at: number | null; app_count: number; site_count: number; sessions: LockSession[] };
type Theme = "ember" | "graphite" | "sage";
type RecurringSchedule = { id: string; name: string; groupId: string; days: number[]; time: string; minutes: number; enabled: boolean };

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
const formatDays = (days: number[]) => days.length === 7 ? "Every day" : days.join("") === "12345" ? "Weekdays" : days.join("") === "67" ? "Weekends" : days.map(day => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]).join(", ");
const loadSchedules = (): RecurringSchedule[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("mindless-schedules") ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RecurringSchedule => !!item && typeof item === "object" && typeof (item as RecurringSchedule).id === "string" && typeof (item as RecurringSchedule).groupId === "string" && Array.isArray((item as RecurringSchedule).days)).slice(0, 20);
  } catch { return []; }
};
const loadTheme = (): Theme => {
  const value = localStorage.getItem("mindless-theme");
  return value === "graphite" || value === "sage" ? value : "ember";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"schedules" | "groups" | "themes">("schedules");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [schedules, setSchedules] = useState<RecurringSchedule[]>(loadSchedules);
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleGroup, setScheduleGroup] = useState("");
  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleMinutes, setScheduleMinutes] = useState(60);
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
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
  useEffect(() => { localStorage.setItem("mindless-theme", theme); }, [theme]);
  useEffect(() => { localStorage.setItem("mindless-schedules", JSON.stringify(schedules)); }, [schedules]);
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

  async function saveCluster() {
    const name = clusterName.trim();
    if (!name) return setNotice("Name this cluster first.");
    if (name.length > 32) return setNotice("Cluster names can contain up to 32 characters.");
    if (!editingCluster && clusters.length >= 50) return setNotice("You can save up to 50 clusters.");
    if (resolvedDraft.apps.length + resolvedDraft.sites.length === 0) return setNotice("Add at least one target to the group.");
    const next = editingCluster
      ? clusters.map(item => item.id === editingCluster ? { ...item, name, apps: [...resolvedDraft.apps], sites: [...resolvedDraft.sites] } : item)
      : [...clusters, { id: createId(), name, apps: [...resolvedDraft.apps], sites: [...resolvedDraft.sites] }];
    try {
      if (editingCluster && schedules.some(schedule => schedule.groupId === editingCluster)) {
        setBusy(true);
        await invoke("set_recurring_schedules", { schedules: schedulePayloads(schedules, next) });
      }
      setClusters(next); setShowClusterEditor(false); setEditingCluster(null); setClusterName(""); setNotice("");
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  function deleteCluster(id: string) {
    if (schedules.some(schedule => schedule.groupId === id)) return setNotice("Remove schedules using this group first.");
    if (pendingDelete !== id) { setPendingDelete(id); window.setTimeout(() => setPendingDelete(current => current === id ? null : current), 3000); return; }
    setClusters(clusters.filter(item => item.id !== id)); setSelectedClusters(selectedClusters.filter(clusterId => clusterId !== id)); setPendingDelete(null);
    if (editingCluster === id) { setEditingCluster(null); setShowClusterEditor(false); }
  }

  async function beginLock() {
    if (busy) return;
    if (resolvedDraft.apps.length + resolvedDraft.sites.length === 0) return setNotice("Choose at least one app, website, or group.");
    setBusy(true); setNotice("");
    try {
      const state = await invoke<LockState>("start_lock", { request: { apps: resolvedDraft.apps, sites: resolvedDraft.sites, minutes } });
      setLock(state); setApps([]); setSites([]); setSelectedClusters([]);
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  const schedulePayloads = (items: RecurringSchedule[], sourceGroups: Cluster[] = clusters) => items.filter(item => item.enabled).flatMap(item => {
    const group = sourceGroups.find(cluster => cluster.id === item.groupId);
    if (!group) return [];
    const [hour, minute] = item.time.split(":").map(Number);
    return [{ apps: group.apps, sites: group.sites, days: item.days, start_minute: hour * 60 + minute, minutes: item.minutes }];
  });

  async function persistSchedules(next: RecurringSchedule[]) {
    setBusy(true); setNotice("");
    try {
      await invoke("set_recurring_schedules", { schedules: schedulePayloads(next) });
      setSchedules(next);
    } catch (error) { setNotice(String(error)); throw error; }
    finally { setBusy(false); }
  }

  async function saveSchedule() {
    const group = scheduleGroup || clusters[0]?.id;
    if (!group) return setNotice("Create a group before adding a schedule.");
    if (!scheduleDays.length) return setNotice("Choose at least one day.");
    const item: RecurringSchedule = { id: editingSchedule ?? createId(), name: scheduleName.trim() || clusters.find(entry => entry.id === group)?.name || "Focus", groupId: group, days: [...scheduleDays].sort(), time: scheduleTime, minutes: scheduleMinutes, enabled: true };
    const next = editingSchedule ? schedules.map(entry => entry.id === editingSchedule ? item : entry) : [...schedules, item];
    try { await persistSchedules(next); setEditingSchedule(null); setScheduleName(""); setNotice("Schedule saved."); } catch { /* message is already shown */ }
  }

  function editSchedule(item: RecurringSchedule) {
    setEditingSchedule(item.id); setScheduleName(item.name); setScheduleGroup(item.groupId); setScheduleDays(item.days); setScheduleTime(item.time); setScheduleMinutes(item.minutes);
  }

  async function removeSchedule(id: string) {
    try { await persistSchedules(schedules.filter(item => item.id !== id)); } catch { /* message is already shown */ }
  }

  async function toggleSchedule(item: RecurringSchedule) {
    try { await persistSchedules(schedules.map(entry => entry.id === item.id ? { ...entry, enabled: !entry.enabled } : entry)); } catch { /* message is already shown */ }
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
  const activeRecurring = schedules.filter(schedule => {
    if (!schedule.enabled) return false;
    const [hour, minute] = schedule.time.split(":").map(Number);
    const start = hour * 60 + minute;
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    const day = now.getDay() || 7;
    const end = start + schedule.minutes;
    if (schedule.days.includes(day) && currentMinute >= start && (end > 1440 || currentMinute < end)) return true;
    const previousDay = day === 1 ? 7 : day - 1;
    return end > 1440 && schedule.days.includes(previousDay) && currentMinute < end - 1440;
  });
  const hasLiveLock = lock.sessions.some(session => !session.start_at || session.start_at <= nowEpoch) || activeRecurring.length > 0;
  const hasArmedSchedule = schedules.some(schedule => schedule.enabled);

  return (
    <main className="shell" data-theme={theme}>
      <header className="topbar" data-tauri-drag-region>
        <button className="settings-button" onClick={() => setSettingsOpen(open => !open)}>{settingsOpen ? <ChevronLeft size={13} /> : <Settings2 size={13} />}{settingsOpen ? "BACK" : "SETTINGS"}</button>
        <div className="wordmark">{settingsOpen ? "CONTROL PANEL" : "MINDLESS"}</div>
        <div className="status"><span className={hasLiveLock || hasArmedSchedule || lock.active ? "status-dot active" : "status-dot"} />{hasLiveLock ? "LOCKED" : hasArmedSchedule ? "ARMED" : lock.active ? "SCHEDULED" : "READY"}<button className="window-close" title="Hide Mindless" aria-label="Hide Mindless" onClick={() => getCurrentWindow().hide()}><X size={12} /></button></div>
      </header>

      {settingsOpen ? <section className="settings-view">
        <nav className="settings-tabs" aria-label="Settings sections">
          <button className={settingsTab === "schedules" ? "selected" : ""} onClick={() => setSettingsTab("schedules")}><CalendarDays size={13} /> SCHEDULES</button>
          <button className={settingsTab === "groups" ? "selected" : ""} onClick={() => setSettingsTab("groups")}><Layers3 size={13} /> GROUPS</button>
          <button className={settingsTab === "themes" ? "selected" : ""} onClick={() => setSettingsTab("themes")}><Palette size={13} /> THEMES</button>
        </nav>

        {settingsTab === "schedules" && <div className="settings-content schedules-settings">
          <header><p className="eyebrow">AUTOMATION</p><h1>Recurring schedules</h1><span>Runs through the system guard, even when Mindless is closed.</span></header>
          <div className="schedule-builder">
            <div className="settings-field"><label>NAME</label><input maxLength={32} value={scheduleName} onChange={event => setScheduleName(event.target.value)} placeholder="Morning focus" /></div>
            <div className="settings-field"><label>GROUP</label><select value={scheduleGroup || clusters[0]?.id || ""} onChange={event => setScheduleGroup(event.target.value)}><option value="" disabled>Create a group first</option>{clusters.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
            <div className="schedule-pair"><div className="settings-field"><label>START</label><input type="time" value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} /></div><div className="settings-field"><label>DURATION</label><select value={scheduleMinutes} onChange={event => setScheduleMinutes(Number(event.target.value))}>{[30, 60, 120, 240, 480, 720].map(value => <option value={value} key={value}>{value < 60 ? `${value} min` : `${value / 60} hr`}</option>)}</select></div></div>
            <div className="repeat-presets"><button onClick={() => setScheduleDays([1,2,3,4,5,6,7])}>EVERY DAY</button><button onClick={() => setScheduleDays([1,2,3,4,5])}>WEEKDAYS</button><button onClick={() => setScheduleDays([6,7])}>WEEKENDS</button></div>
            <div className="day-picker">{["M","T","W","T","F","S","S"].map((label, index) => <button key={`${label}-${index}`} className={scheduleDays.includes(index + 1) ? "selected" : ""} onClick={() => setScheduleDays(scheduleDays.includes(index + 1) ? scheduleDays.filter(day => day !== index + 1) : [...scheduleDays, index + 1])}>{label}</button>)}</div>
            <button className="settings-primary" disabled={busy || !clusters.length} onClick={saveSchedule}><Save size={13} /> {editingSchedule ? "UPDATE SCHEDULE" : "ADD SCHEDULE"}</button>
          </div>
          <div className="settings-list">{schedules.length === 0 ? <div className="settings-empty">No recurring schedules</div> : schedules.map(item => <div className={item.enabled ? "schedule-item" : "schedule-item disabled"} key={item.id}><button className="schedule-state" onClick={() => toggleSchedule(item)} aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`}><i /></button><div><strong>{item.name}</strong><span>{item.time} · {formatDays(item.days)} · {clusters.find(group => group.id === item.groupId)?.name ?? "Missing group"}</span></div><button onClick={() => editSchedule(item)} aria-label={`Edit ${item.name}`}><Pencil size={12} /></button><button onClick={() => removeSchedule(item.id)} aria-label={`Delete ${item.name}`}><Trash2 size={12} /></button></div>)}</div>
        </div>}

        {settingsTab === "groups" && <div className="settings-content groups-settings">
          <header><p className="eyebrow">REUSABLE TARGETS</p><h1>Groups</h1><span>Select targets on the main screen, then save them here.</span></header>
          <div className="group-save-bar"><span>{resolvedDraft.apps.length + resolvedDraft.sites.length} selected targets</span><button disabled={!resolvedDraft.apps.length && !resolvedDraft.sites.length} onClick={() => beginCluster()}><Plus size={12} /> SAVE CURRENT</button></div>
          {showClusterEditor && <div className="settings-name-editor"><input autoFocus maxLength={32} value={clusterName} onChange={event => setClusterName(event.target.value)} placeholder="Group name" onKeyDown={event => event.key === "Enter" && saveCluster()} /><button onClick={saveCluster}><Save size={12} /> SAVE</button><button onClick={() => setShowClusterEditor(false)} aria-label="Cancel"><X size={12} /></button></div>}
          <div className="settings-list">{clusters.length === 0 ? <div className="settings-empty">No saved groups</div> : clusters.map(group => <div className="group-item" key={group.id}><Layers3 size={14} /><div><strong>{group.name}</strong><span>{group.apps.length} apps · {group.sites.length} websites</span></div><button onClick={() => beginCluster(group)} aria-label={`Edit ${group.name}`}><Pencil size={12} /></button><button onClick={() => deleteCluster(group.id)} aria-label={`Delete ${group.name}`}><Trash2 size={12} /></button></div>)}</div>
        </div>}

        {settingsTab === "themes" && <div className="settings-content themes-settings">
          <header><p className="eyebrow">APPEARANCE</p><h1>Theme</h1><span>Choose one restrained accent for the control surface.</span></header>
          <div className="theme-options">{([{ id: "ember", label: "Ember", color: "#cf582d" }, { id: "graphite", label: "Graphite", color: "#a8a7a2" }, { id: "sage", label: "Sage", color: "#71977c" }] as const).map(option => <button className={theme === option.id ? "selected" : ""} key={option.id} onClick={() => setTheme(option.id)}><i style={{ background: option.color }} /><span>{option.label}</span>{theme === option.id && <small>ACTIVE</small>}</button>)}</div>
        </div>}
        {notice && <p className="settings-notice" role="status"><Info size={12} />{notice}</p>}
      </section> : <section className="workspace">
        <aside className={lock.active || activeRecurring.length ? "time-panel has-locks" : "time-panel"}>
          <div className="date"><span>{clock.month}</span><strong>{clock.day}</strong></div>
          <div className="time" aria-label={`${clock.hour}:${clock.minute} ${clock.period}`}><span>{clock.hour}</span><span>{clock.minute}</span></div>
          <div className="period">{clock.period}</div>

          {(lock.active || activeRecurring.length > 0) && <section className="left-locks" aria-label="Active locks">
            <div className="left-locks-heading"><span><ShieldCheck size={11} /> SESSIONS</span><strong>{pad(lock.sessions.length + activeRecurring.length)}</strong></div>
            <div className="left-lock-list">{activeRecurring.map((schedule, index) => {
              const group = clusters.find(item => item.id === schedule.groupId);
              return <div className="left-lock recurring" key={schedule.id} title={group ? [...group.apps.map(app => app.name), ...group.sites].join(", ") : schedule.name}><div><span>RECUR {pad(index + 1)}</span><small>{group?.name ?? schedule.name}</small></div><strong>{schedule.time}</strong></div>;
            })}{lock.sessions.map((session, index) => {
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
              <div className="micro-heading"><span><Layers3 size={12} /> GROUPS</span></div>
              <div className="cluster-rack">
                {clusters.length === 0 && <button className="cluster-empty" onClick={() => { setSettingsTab("groups"); setSettingsOpen(true); }}><FolderPen size={14} /> Create in Settings</button>}
                {clusters.map(cluster => <div className={selectedClusters.includes(cluster.id) ? "cluster selected" : "cluster"} key={cluster.id}>
                  <button className="cluster-load" title={`Add ${cluster.name} to Targets`} onClick={() => applyCluster(cluster)}><span>{cluster.name}</span><small>{pad(cluster.apps.length + cluster.sites.length)}</small></button>
                </div>)}
              </div>
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

            {notice && <p className="notice" role="status"><Info size={11} />{notice}</p>}
            <div className="commit-row"><button className="commit" disabled={busy || resolvedDraft.apps.length + resolvedDraft.sites.length === 0} onClick={beginLock}><span className="commit-mark" />{busy ? "UPDATING GUARD…" : lock.active ? "ADD LOCK" : "LOCK NOW"}</button></div>
          </div>
        </section>
      </section>}
    </main>
  );
}

export default App;
