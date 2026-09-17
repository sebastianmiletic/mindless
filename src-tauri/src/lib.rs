use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, process::Command, sync::{Mutex, OnceLock}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};

const LABEL: &str = "com.mindless.guard";
const SYSTEM_DIR: &str = "/Library/Application Support/Mindless";
static START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
struct BlockedApp { name: String, path: String }

#[derive(Deserialize)]
struct LockRequest {
    apps: Vec<BlockedApp>,
    sites: Vec<String>,
    minutes: u64,
    #[serde(default)]
    start_at: Option<u64>,
}

#[derive(Deserialize)]
struct RecurringScheduleRequest {
    apps: Vec<BlockedApp>,
    sites: Vec<String>,
    days: Vec<u8>,
    start_minute: u16,
    minutes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredSession {
    #[serde(default)]
    start_at: u64,
    ends_at: u64,
    executables: Vec<String>,
    sites: Vec<String>,
    #[serde(default)]
    targets: Vec<String>,
    app_count: usize,
    site_count: usize,
}

#[derive(Default, Serialize, Deserialize)]
struct StoredLocks { sessions: Vec<StoredSession> }

#[derive(Clone, Serialize, Deserialize)]
struct SessionSummary { start_at: u64, ends_at: u64, app_count: usize, site_count: usize, targets: Vec<String> }

#[derive(Clone, Serialize, Deserialize)]
struct LockState {
    active: bool,
    ends_at: Option<u64>,
    app_count: usize,
    site_count: usize,
    sessions: Vec<SessionSummary>,
}

#[derive(Deserialize)]
struct LegacyState { active: bool, ends_at: Option<u64>, app_count: usize, site_count: usize }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

fn mirror_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("active-lock.json"))
}

fn load_stored(app: &AppHandle) -> Result<StoredLocks, String> {
    let path = mirror_path(app)?;
    let Ok(data) = fs::read_to_string(path) else { return Ok(StoredLocks::default()) };
    if let Ok(mut stored) = serde_json::from_str::<StoredLocks>(&data) {
        stored.sessions.retain(|session| session.ends_at > now());
        return Ok(stored);
    }
    if let Ok(legacy) = serde_json::from_str::<LegacyState>(&data) {
        if legacy.active {
            if let Some(end) = legacy.ends_at.filter(|end| *end > now()) {
                return Ok(StoredLocks { sessions: vec![StoredSession {
                    start_at: 0, ends_at: end, executables: vec![], sites: vec![], targets: vec![],
                    app_count: legacy.app_count, site_count: legacy.site_count,
                }] });
            }
        }
    }
    Ok(StoredLocks::default())
}

fn public_state(stored: &StoredLocks) -> LockState {
    let sessions: Vec<SessionSummary> = stored.sessions.iter().map(|session| {
        let targets = if session.targets.is_empty() {
            session.executables.iter().filter_map(|path| Path::new(path).file_name().and_then(|name| name.to_str()).map(str::to_string)).chain(session.sites.iter().cloned()).collect()
        } else { session.targets.clone() };
        SessionSummary { start_at: session.start_at, ends_at: session.ends_at, app_count: session.app_count, site_count: session.site_count, targets }
    }).collect();
    LockState {
        active: !sessions.is_empty(),
        ends_at: sessions.iter().map(|session| session.ends_at).max(),
        app_count: sessions.iter().map(|session| session.app_count).sum(),
        site_count: sessions.iter().map(|session| session.site_count).sum(),
        sessions,
    }
}

#[tauri::command]
fn get_lock_state(app: AppHandle) -> Result<LockState, String> {
    let stored = load_stored(&app)?;
    if stored.sessions.is_empty() { let _ = fs::remove_file(mirror_path(&app)?); }
    Ok(public_state(&stored))
}

#[tauri::command]
async fn choose_application() -> Result<Option<BlockedApp>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose an app to block")
            .set_directory("/Applications")
            .add_filter("macOS applications", &["app"])
            .pick_file()
    }).await.map_err(|error| error.to_string())?;
    let Some(path) = picked else { return Ok(None) };
    if path.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err("Choose a macOS application bundle.".into());
    }
    let canonical = path.canonicalize().map_err(|_| "The selected application could not be read.".to_string())?;
    let name = canonical.file_stem().and_then(|value| value.to_str()).unwrap_or("Application").to_string();
    Ok(Some(BlockedApp { name, path: canonical.to_string_lossy().to_string() }))
}

fn plist_field(info: &Path, key: &str) -> Option<String> {
    if let Ok(value) = plist::Value::from_file(info) {
        if let Some(found) = value.as_dictionary().and_then(|dictionary| dictionary.get(key)).and_then(|value| value.as_string()) {
            return Some(found.to_string());
        }
    }
    let output = Command::new("/usr/bin/plutil").args(["-extract", key, "raw", "-o", "-", &info.to_string_lossy()]).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim_matches(char::from(0)).trim().to_string()).filter(|value| !value.is_empty())
}

fn direct_bundle_executable(bundle: &Path) -> Result<String, String> {
    let info = bundle.join("Contents/Info.plist");
    if plist_field(&info, "CFBundleIdentifier").as_deref() == Some("com.mindless.focus") {
        return Err("Mindless cannot block itself. Close its window instead; active locks continue in the background.".into());
    }
    let macos = bundle.join("Contents/MacOS");
    let executable = plist_field(&info, "CFBundleExecutable").map(|name| macos.join(name)).or_else(|| {
        fs::read_dir(&macos).ok()?.flatten().map(|entry| entry.path()).find(|path| path.is_file())
    }).ok_or_else(|| format!("{} does not contain a runnable macOS executable.", bundle.file_stem().and_then(|name| name.to_str()).unwrap_or("The selected app")))?;
    if !executable.exists() { return Err("The selected app executable was not found.".into()); }
    Ok(executable.to_string_lossy().to_string())
}

fn find_named_bundle(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 { return None; }
    for entry in fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(name) && path.extension().and_then(|value| value.to_str()) == Some("app") { return Some(path); }
        if path.is_dir() {
            if let Some(found) = find_named_bundle(&path, name, depth - 1) { return Some(found); }
        }
    }
    None
}

fn executable_for(bundle_path: &str) -> Result<String, String> {
    let canonical = Path::new(bundle_path).canonicalize().map_err(|_| "A selected application no longer exists.".to_string())?;
    if canonical.extension().and_then(|value| value.to_str()) != Some("app") { return Err("Choose a valid macOS application.".into()); }
    let direct = direct_bundle_executable(&canonical)?;

    // Steam creates tiny launcher bundles in ~/Applications. Resolve those to the
    // actual game bundle so the long-running game process is blocked, not just the launcher.
    let is_small_launcher = fs::metadata(&direct).is_ok_and(|metadata| metadata.len() <= 64 * 1024);
    if is_small_launcher && fs::read_to_string(&direct).is_ok_and(|contents| contents.contains("steam://run/")) {
        if let (Some(home), Some(bundle_name)) = (std::env::var_os("HOME"), canonical.file_name().and_then(|name| name.to_str())) {
            let common = PathBuf::from(home).join("Library/Application Support/Steam/steamapps/common");
            if let Some(actual_bundle) = find_named_bundle(&common, bundle_name, 4) {
                return direct_bundle_executable(&actual_bundle);
            }
        }
    }
    Ok(direct)
}

fn valid_domain(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase().trim_start_matches("www.").to_string();
    if value.len() > 253 || !value.contains('.') || value.starts_with('.') || value.ends_with('.') { return None; }
    value.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-').then_some(value)
}

fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }
fn applescript_quote(value: &str) -> String { value.replace('\\', "\\\\").replace('"', "\\\"") }

fn update_system_guard(addition: String, replace_recurring: bool) -> Result<(), String> {
    let temp = std::env::temp_dir().join(format!("mindless-install-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp);
    fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let script_path = temp.join("mindless-guard.sh");
    let addition_path = temp.join("guard-addition.conf");
    let plist_path = temp.join(format!("{LABEL}.plist"));
    fs::write(&script_path, include_str!("../resources/mindless-guard.sh")).map_err(|e| e.to_string())?;
    fs::write(&addition_path, addition).map_err(|e| e.to_string())?;
    fs::write(&plist_path, include_str!("../resources/com.mindless.guard.plist")).map_err(|e| e.to_string())?;

    let merge = if replace_recurring {
        format!("if [ -f {dir}/guard.conf ]; then /usr/bin/grep -vE '^(RAPP|RPROCESS|RSITE)=' {dir}/guard.conf > {dir}/guard.conf.next || true; else : > {dir}/guard.conf.next; fi; cat {addition} >> {dir}/guard.conf.next", dir = shell_quote(SYSTEM_DIR), addition = shell_quote(&addition_path.to_string_lossy()))
    } else {
        format!("if [ -f {dir}/guard.conf ]; then cat {dir}/guard.conf {addition} > {dir}/guard.conf.next; else cat {addition} > {dir}/guard.conf.next; fi", dir = shell_quote(SYSTEM_DIR), addition = shell_quote(&addition_path.to_string_lossy()))
    };
    let privileged_script = format!(
        "mkdir -p {dir}; cp {script} '/Library/PrivilegedHelperTools/com.mindless.guard.sh'; {merge}; mv {dir}/guard.conf.next {dir}/guard.conf; cp {plist} '/Library/LaunchDaemons/{label}.plist'; chown root:wheel '/Library/PrivilegedHelperTools/com.mindless.guard.sh' {dir}/guard.conf '/Library/LaunchDaemons/{label}.plist'; chmod 755 '/Library/PrivilegedHelperTools/com.mindless.guard.sh'; chmod 600 {dir}/guard.conf; chmod 644 '/Library/LaunchDaemons/{label}.plist'; launchctl bootout system/{label} >/dev/null 2>&1 || true; launchctl bootstrap system '/Library/LaunchDaemons/{label}.plist'",
        dir = shell_quote(SYSTEM_DIR), script = shell_quote(&script_path.to_string_lossy()), merge = merge, plist = shell_quote(&plist_path.to_string_lossy()), label = LABEL
    );
    let apple = format!("do shell script \"{}\" with administrator privileges", applescript_quote(&privileged_script));
    let output = Command::new("osascript").args(["-e", &apple]).output().map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&temp);
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(if error.contains("User canceled") { "Administrator approval was cancelled.".into() } else { format!("Could not update the system guard: {}", error.trim()) });
    }
    Ok(())
}

#[tauri::command]
fn start_lock(app: AppHandle, request: LockRequest) -> Result<LockState, String> {
    let _operation = START_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "The lock service is temporarily unavailable.".to_string())?;
    if !(1..=720).contains(&request.minutes) { return Err("Duration must be between 1 minute and 12 hours.".into()); }
    if request.apps.is_empty() && request.sites.is_empty() { return Err("Choose at least one app or website.".into()); }
    if request.apps.len() > 50 || request.sites.len() > 50 { return Err("A lock supports up to 50 apps and 50 websites.".into()); }

    let mut seen_apps = HashSet::new();
    let mut executables = Vec::new();
    for selected in &request.apps {
        let executable = executable_for(&selected.path)?;
        if seen_apps.insert(executable.clone()) { executables.push(executable); }
    }
    let mut seen_domains = HashSet::new();
    let mut domains = Vec::new();
    for site in &request.sites {
        let domain = valid_domain(site).ok_or_else(|| format!("Invalid domain: {site}"))?;
        if seen_domains.insert(domain.clone()) { domains.push(domain); }
    }
    let current = now();
    let start_at = request.start_at.unwrap_or(current);
    if start_at > current + 31 * 24 * 60 * 60 { return Err("Schedules can be created up to 31 days ahead.".into()); }
    if request.start_at.is_some() && start_at < current + 30 { return Err("Choose a schedule time at least 30 seconds from now.".into()); }
    let ends_at = start_at + request.minutes * 60;

    let mut addition = String::new();
    for executable in &executables {
        addition.push_str(&format!("APP={start_at}:{ends_at}:{}\n", STANDARD.encode(executable)));
        if let Some(name) = Path::new(executable).file_name().and_then(|value| value.to_str()) {
            addition.push_str(&format!("PROCESS={start_at}:{ends_at}:{}\n", STANDARD.encode(name)));
        }
    }
    for domain in &domains { addition.push_str(&format!("SITE={start_at}:{ends_at}:{}\n", STANDARD.encode(domain))); }

    update_system_guard(addition, false)?;

    let mut stored = load_stored(&app)?;
    let targets = request.apps.iter().map(|selected| selected.name.chars().take(80).collect::<String>()).chain(domains.iter().cloned()).collect();
    stored.sessions.push(StoredSession {
        start_at, ends_at, targets,
        app_count: executables.len(), site_count: domains.len(),
        executables, sites: domains,
    });
    let mirror = mirror_path(&app)?;
    let next_mirror = mirror.with_extension("json.next");
    if fs::write(&next_mirror, serde_json::to_vec(&stored).map_err(|e| e.to_string())?).is_ok() {
        let _ = fs::rename(next_mirror, mirror);
    }
    Ok(public_state(&stored))
}

#[tauri::command]
fn set_recurring_schedules(schedules: Vec<RecurringScheduleRequest>) -> Result<(), String> {
    let _operation = START_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "The lock service is temporarily unavailable.".to_string())?;
    if schedules.len() > 20 { return Err("You can create up to 20 recurring schedules.".into()); }
    let mut config = String::new();
    for schedule in schedules {
        if schedule.apps.len() > 50 || schedule.sites.len() > 50 || schedule.apps.is_empty() && schedule.sites.is_empty() { return Err("Each schedule needs 1 to 100 valid targets.".into()); }
        if !(1..=720).contains(&schedule.minutes) || schedule.start_minute >= 1440 { return Err("A schedule has an invalid time or duration.".into()); }
        let mut days = schedule.days;
        days.sort_unstable(); days.dedup();
        if days.is_empty() || days.iter().any(|day| !(1..=7).contains(day)) { return Err("Choose at least one valid weekday.".into()); }
        let day_string: String = days.iter().map(|day| char::from_digit(*day as u32, 10).unwrap()).collect();
        let mut seen_apps = HashSet::new();
        for selected in schedule.apps {
            let executable = executable_for(&selected.path)?;
            if !seen_apps.insert(executable.clone()) { continue; }
            config.push_str(&format!("RAPP={day_string}:{}:{}:{}\n", schedule.start_minute, schedule.minutes, STANDARD.encode(&executable)));
            if let Some(name) = Path::new(&executable).file_name().and_then(|value| value.to_str()) {
                config.push_str(&format!("RPROCESS={day_string}:{}:{}:{}\n", schedule.start_minute, schedule.minutes, STANDARD.encode(name)));
            }
        }
        let mut seen_sites = HashSet::new();
        for site in schedule.sites {
            let domain = valid_domain(&site).ok_or_else(|| format!("Invalid domain: {site}"))?;
            if seen_sites.insert(domain.clone()) { config.push_str(&format!("RSITE={day_string}:{}:{}:{}\n", schedule.start_minute, schedule.minutes, STANDARD.encode(domain))); }
        }
    }
    update_system_guard(config, true)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        let _ = window.set_visible_on_all_workspaces(true);
        if let (Ok(cursor), Ok(monitors)) = (app.cursor_position(), app.available_monitors()) {
            if let Some(target) = monitors.iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                cursor.x >= position.x as f64 && cursor.x < (position.x as f64 + size.width as f64)
                    && cursor.y >= position.y as f64 && cursor.y < (position.y as f64 + size.height as f64)
            }) {
                let current_position = window.current_monitor().ok().flatten().map(|monitor| *monitor.position());
                if current_position != Some(*target.position()) {
                    if let Ok(size) = window.outer_size() {
                        let x = target.position().x + (target.size().width.saturating_sub(size.width) / 2) as i32;
                        let y = target.position().y + (target.size().height.saturating_sub(size.height) / 2) as i32;
                        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                }
            }
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::{image::Image, menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}};

            #[cfg(target_os = "macos")]
            app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            let show = MenuItem::with_id(app, "show", "Show Mindless", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide Mindless", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Mindless", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
            let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

            TrayIconBuilder::with_id("mindless")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Mindless")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "hide" => if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); },
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            show_main_window(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_lock_state, choose_application, start_lock, set_recurring_schedules])
        .run(tauri::generate_context!())
        .expect("error while running Mindless");
}
