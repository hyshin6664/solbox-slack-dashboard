// Slack 대시보드 — Tauri 백엔드 v6.10.26 (DM/MPIM unread 동기화)
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, Emitter};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

// ========= 핵심: webview cookies 사용해서 GAS 호출 (CORS/Google인증 우회) =========
#[tauri::command]
async fn gas_call(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let webview = app.get_webview_window("main").ok_or_else(|| "main window 없음".to_string())?;
    let cookies = webview.cookies().map_err(|e| e.to_string())?;

    let cookie_header = cookies.iter()
        .filter(|c| {
            let d = c.domain().unwrap_or_default();
            d.contains("google.com") || d.contains("googleusercontent.com")
        })
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");

    if cookie_header.is_empty() {
        return Err("LOGIN_REQUIRED".to_string());
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .header("Cookie", cookie_header)
        .header("User-Agent", "Mozilla/5.0 SlackDashTauri")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // [v6.10.16] 다양한 Google 로그인 redirect 패턴 모두 검출 (도메인 잠금 GAS의 새 패턴 포함)
    if text.contains("accounts.google.com/v3/signin")
        || text.contains("ServiceLogin")
        || text.contains("AccountChooser")
        || text.contains("Sign in - Google Accounts")
        || text.contains("hd=solbox.com")
        || (text.contains("<title>") && text.contains("Sign in") && text.len() < 100000)
    {
        return Err("LOGIN_REQUIRED".to_string());
    }
    Ok(text)
}

// ========= 첫 로그인 플로우: webview 열고 사용자가 로그인 완료할 때까지 대기 =========
#[tauri::command]
async fn run_login_flow(app: tauri::AppHandle, ping_url: String) -> Result<(), String> {
    // 기존 login 창 닫기
    if let Some(existing) = app.get_webview_window("login") {
        let _ = existing.close();
        std::thread::sleep(Duration::from_millis(200));
        if let Some(stuck) = app.get_webview_window("login") {
            let _ = stuck.destroy();
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    let parsed: url::Url = ping_url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let w = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(parsed))
        .title("Google 로그인 (한 번만)")
        .inner_size(560.0, 720.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    // [v6.10.20] webview cookies로 GAS 호출 직접 시도 → 성공하면 로그인 완료
    //   URL 폴링보다 신뢰성 높음 (실제로 인증 성공했는지 검증)
    let start = Instant::now();
    let test_url = format!("{}", ping_url);
    let client = match reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(5)).timeout(Duration::from_secs(15)).build() {
        Ok(c) => c, Err(_) => { let _ = w.close(); return Err("client build fail".into()); }
    };
    while start.elapsed() < Duration::from_secs(300) {
        std::thread::sleep(Duration::from_millis(2000));
        // 사용자가 창 닫음 → 종료
        if app.get_webview_window("login").is_none() {
            return Ok(());
        }
        // webview 쿠키로 GAS 호출 시도
        let cookies = match w.cookies() { Ok(c) => c, Err(_) => continue };
        let cookie_header = cookies.iter()
            .filter(|c| { let d = c.domain().unwrap_or_default(); d.contains("google.com") || d.contains("googleusercontent.com") })
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; ");
        if cookie_header.is_empty() { continue; }
        match client.get(&test_url).header("Cookie", cookie_header).header("User-Agent", "Mozilla/5.0 SlackDashTauri").send().await {
            Ok(resp) => {
                let text = resp.text().await.unwrap_or_default();
                let looks_login = text.contains("accounts.google.com/v3/signin")
                    || text.contains("ServiceLogin")
                    || text.contains("AccountChooser")
                    || text.contains("Sign in - Google Accounts")
                    || text.contains("hd=solbox.com");
                // [v6.10.21] GAS 정상 응답 패턴 검출 (Unknown action: ping 같은 짧은 응답도 포함)
                let trimmed = text.trim();
                let looks_gas_response = trimmed.starts_with("{")
                    || trimmed.starts_with("[")
                    || text.contains("\"success\"")
                    || text.contains("\"error\"")
                    || text.contains("Unknown action");
                if !looks_login && looks_gas_response {
                    std::thread::sleep(Duration::from_millis(500));
                    let _ = w.close();
                    return Ok(());
                }
            },
            Err(_) => continue,
        }
    }
    let _ = w.close();
    Err("login timeout".into())
}

// ========= 이미지 별도 창으로 보기 (큰 화면) =========
#[tauri::command]
async fn open_image_window(app: tauri::AppHandle, image_url: String, title: String, slack_token: String) -> Result<(), String> {
    let _ = slack_token; // (현재 미사용 — webview cookie로 인증)
    let label = format!("img-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    // [v6.10.9] 서버사이드 fetch 시도 (cookie 있으면 성공)
    let target_url = match fetch_slack_bytes(&app, &image_url, "").await {
        Ok((ct, bytes)) => {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let data = format!("data:{};base64,{}", ct, STANDARD.encode(&bytes));
            let safe_title = title.replace('"', "&quot;").replace('<', "&lt;");
            let html = format!(r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>{t}</title><style>
body{{margin:0;background:#1a202c;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden;font-family:sans-serif;color:#fff}}
img{{max-width:100%;max-height:100vh;object-fit:contain;cursor:zoom-in}}
img.zoomed{{cursor:zoom-out;max-width:none;max-height:none}}
</style></head><body>
<img id="img" src="{u}" />
<script>
var img=document.getElementById('img');
img.addEventListener('click',function(){{ this.classList.toggle('zoomed'); }});
document.addEventListener('keydown',function(e){{ if(e.key==='Escape') window.close(); }});
</script></body></html>"#, t = safe_title, u = data);
            format!("data:text/html;charset=utf-8,{}", urlencoding::encode(&html))
        },
        Err(_) => {
            // cookie 없으면 webview가 직접 image URL 로드 → Slack 로그인 페이지 보여주거나 (첫 사용)
            // 이미 로그인되어 있으면 이미지 자동 표시
            image_url.clone()
        },
    };
    let parsed: url::Url = target_url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let _w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!("🖼 {}", title))
        .inner_size(900.0, 700.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========= 채팅 별도 창으로 열기 — 카톡 PC 스타일 =========
#[tauri::command]
async fn open_chat_window(app: tauri::AppHandle, chat_id: String, chat_type: String, chat_name: String) -> Result<(), String> {
    let label = format!("chat-{}", chat_id.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect::<String>());
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        let _ = existing.unminimize();
        return Ok(());
    }
    let path = format!(
        "index.html?chatWindow=1&id={}&type={}&name={}",
        urlencoding::encode(&chat_id),
        urlencoding::encode(&chat_type),
        urlencoding::encode(&chat_name)
    );
    let display_title = format!("{} — Slack 대시보드", chat_name);
    // [v6.10.24] 메인 창 옆에 명시적 위치 배치 (보이지 않는 곳 방지)
    let (x, y) = if let Some(main) = app.get_webview_window("main") {
        match (main.outer_position(), main.outer_size()) {
            (Ok(pos), Ok(sz)) => (pos.x as f64 + sz.width as f64 + 10.0, pos.y as f64),
            _ => (200.0, 100.0),
        }
    } else { (200.0, 100.0) };
    let w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(path.into()))
        .title(display_title)
        .inner_size(440.0, 700.0)
        .min_inner_size(360.0, 480.0)
        .position(x, y)
        .resizable(true)
        .visible(true)
        .focused(true)
        .always_on_top(false)
        .build()
        .map_err(|e| format!("build fail: {}", e))?;
    // 명시적 표시 + 포커스 + 잠시 always_on_top으로 주의 끌기
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = w.set_always_on_top(true);
    let app2 = app.clone();
    let label2 = label.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        if let Some(w2) = app2.get_webview_window(&label2) {
            let _ = w2.set_always_on_top(false);
        }
    });
    Ok(())
}

// ========= [v6.10.25] Slack API — 자동 재시도 + 지수 백오프 (안정성) =========
#[tauri::command]
async fn slack_api(method: String, token: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = format!("https://slack.com/api/{}", method);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let is_get = matches!(method.as_str(),
        "conversations.members" | "conversations.list" | "conversations.history" |
        "conversations.info" | "conversations.replies" | "conversations.mark" |
        "users.list" | "users.info" | "users.counts" | "users.profile.get" |
        "auth.test" | "rtm.connect" | "api.test" | "files.info" | "search.messages" | "search.files"
    );

    let mut last_err = String::new();
    for attempt in 0..3u32 {
        if attempt > 0 {
            let delay_ms = 500u64 * (1u64 << (attempt - 1)); // 500, 1000, 2000ms
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        let resp_res = if is_get {
            let mut req = client.get(&url).header("Authorization", format!("Bearer {}", token));
            if let serde_json::Value::Object(map) = &params {
                let q: Vec<(String, String)> = map.iter().map(|(k, v)| {
                    let s = match v {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Bool(b) => b.to_string(),
                        serde_json::Value::Number(n) => n.to_string(),
                        serde_json::Value::Null => String::new(),
                        _ => v.to_string(),
                    };
                    (k.clone(), s)
                }).collect();
                req = req.query(&q);
            }
            req.send().await
        } else {
            let mut req = client.post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Content-Type", "application/json; charset=utf-8");
            if !params.is_null() { req = req.json(&params); }
            req.send().await
        };
        match resp_res {
            Ok(resp) => {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => return Ok(json),
                    Err(e) => last_err = format!("json parse: {}", e),
                }
            },
            Err(e) => last_err = format!("net: {}", e),
        }
    }
    Err(format!("slack_api {} failed after 3 retries: {}", method, last_err))
}

// [v6.10.5] Slack 파일/이미지 fetch — Bearer + webview 쿠키 + 수동 redirect
fn slack_cookie_header(app: &tauri::AppHandle) -> String {
    if let Some(webview) = app.get_webview_window("main") {
        if let Ok(cookies) = webview.cookies() {
            return cookies.iter()
                .filter(|c| c.domain().unwrap_or_default().contains("slack.com"))
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ");
        }
    }
    String::new()
}

async fn fetch_slack_bytes(app: &tauri::AppHandle, url: &str, token: &str) -> Result<(String, Vec<u8>), String> {
    let cookie = slack_cookie_header(app);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut current = url.to_string();
    for _ in 0..6 {
        let mut req = client.get(&current)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
        if !token.is_empty() { req = req.header("Authorization", format!("Bearer {}", token)); }
        if !cookie.is_empty() { req = req.header("Cookie", cookie.clone()); }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        if status.is_redirection() {
            if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                if loc.starts_with("http") { current = loc.to_string(); }
                else {
                    let base = url::Url::parse(&current).map_err(|e| e.to_string())?;
                    current = base.join(loc).map_err(|e| e.to_string())?.to_string();
                }
                continue;
            }
            return Err(format!("redirect without location"));
        }
        if !status.is_success() { return Err(format!("HTTP {}", status)); }
        let ct = resp.headers().get("content-type")
            .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        if ct.starts_with("text/html") {
            return Err(format!("got HTML (login page) cookie_len={}", cookie.len()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        return Ok((ct, bytes.to_vec()));
    }
    Err("too many redirects".to_string())
}

#[tauri::command]
async fn slack_fetch_image(app: tauri::AppHandle, url: String, token: String) -> Result<String, String> {
    let (ct, bytes) = fetch_slack_bytes(&app, &url, &token).await?;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(format!("data:{};base64,{}", ct, STANDARD.encode(&bytes)))
}

// [v6.10.5] 외부 브라우저로 URL 열기
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

// [v6.10.8] cookie 진단 — webview에 어떤 slack 쿠키가 있는지 보기
#[tauri::command]
fn diag_slack_cookies(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(webview) = app.get_webview_window("main") {
        if let Ok(cookies) = webview.cookies() {
            let slack: Vec<String> = cookies.iter()
                .filter(|c| c.domain().unwrap_or_default().contains("slack"))
                .map(|c| format!("{}={} (domain={})", c.name(), &c.value().chars().take(8).collect::<String>(), c.domain().unwrap_or_default()))
                .collect();
            let total = cookies.len();
            return Ok(format!("total={} slack_count={} list={:?}", total, slack.len(), slack));
        }
    }
    Ok("no webview".to_string())
}

// [v6.10.9] Slack 이미지 다운로드 후 OS 기본 앱으로 열기 (그림판/사진 등)
#[tauri::command]
async fn download_and_open(app: tauri::AppHandle, url: String, token: String, name_hint: String) -> Result<String, String> {
    let (ct, bytes) = fetch_slack_bytes(&app, &url, &token).await?;
    // 확장자 결정
    let ext = if ct.contains("png") { "png" }
              else if ct.contains("jpeg") || ct.contains("jpg") { "jpg" }
              else if ct.contains("gif") { "gif" }
              else if ct.contains("webp") { "webp" }
              else { "bin" };
    let safe_name: String = name_hint.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.').take(40).collect();
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let filename = if safe_name.is_empty() { format!("slack_{}.{}", ts, ext) } else { format!("{}_{}.{}", ts, safe_name, ext) };
    let temp_dir = std::env::temp_dir().join("slack_dashboard_imgs");
    let _ = fs::create_dir_all(&temp_dir);
    let path = temp_dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    open::that(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// [v6.10.9] Slack 웹 로그인 popup — webview에 cookie 저장용 (한 번만)
#[tauri::command]
async fn open_slack_login(app: tauri::AppHandle) -> Result<(), String> {
    let url: url::Url = "https://app.slack.com/".parse().map_err(|e: url::ParseError| e.to_string())?;
    let _w = WebviewWindowBuilder::new(&app, "slack-login", WebviewUrl::External(url))
        .title("Slack 로그인 (이미지 보려면 한 번만)")
        .inner_size(1000.0, 720.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// [v6.10.7] dataURL이 이미 준비된 이미지를 popup에 표시 (GAS fetch 결과 등)
#[tauri::command]
async fn open_image_window_inline(app: tauri::AppHandle, data_url: String, title: String) -> Result<(), String> {
    let label = format!("img-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let safe_title = title.replace('"', "&quot;").replace('<', "&lt;");
    let html = format!(r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>{t}</title><style>
body{{margin:0;background:#1a202c;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden;font-family:sans-serif;color:#fff}}
img{{max-width:100%;max-height:100vh;object-fit:contain;cursor:zoom-in}}
img.zoomed{{cursor:zoom-out;max-width:none;max-height:none}}
</style></head><body>
<img id="img" src="{u}" />
<script>
var img=document.getElementById('img');
img.addEventListener('click',function(){{ this.classList.toggle('zoomed'); }});
document.addEventListener('keydown',function(e){{ if(e.key==='Escape') window.close(); }});
</script></body></html>"#, t = safe_title, u = data_url);
    let target = format!("data:text/html;charset=utf-8,{}", urlencoding::encode(&html));
    let parsed: url::Url = target.parse().map_err(|e: url::ParseError| e.to_string())?;
    let _w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!("🖼 {}", title))
        .inner_size(900.0, 700.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 토큰 영구 저장/조회 (AppLocalData/token.json)
#[tauri::command]
fn save_slack_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let dir: PathBuf = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("slack_token.json");
    let saved_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64).unwrap_or(0);
    let payload = serde_json::json!({ "token": token, "saved_ms": saved_ms });
    let mut f = fs::File::create(p).map_err(|e| e.to_string())?;
    f.write_all(payload.to_string().as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_slack_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir: PathBuf = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let p = dir.join("slack_token.json");
    if !p.exists() { return Ok(None); }
    let txt = fs::read_to_string(p).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    Ok(v.get("token").and_then(|t| t.as_str()).map(String::from))
}

// ========= [v6.0] xapp 토큰 저장/로드 + Socket Mode 연결 =========
#[tauri::command]
fn save_xapp_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let dir: PathBuf = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("xapp_token.json");
    let payload = serde_json::json!({ "token": token });
    let mut f = fs::File::create(p).map_err(|e| e.to_string())?;
    f.write_all(payload.to_string().as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_xapp_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir: PathBuf = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let p = dir.join("xapp_token.json");
    if !p.exists() { return Ok(None); }
    let txt = fs::read_to_string(p).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    Ok(v.get("token").and_then(|t| t.as_str()).map(String::from))
}

// Socket Mode 연결 시작 — 백그라운드 task에서 WebSocket 연결 + 이벤트 수신 + JS emit
static SOCKET_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
async fn start_socket_mode(app: tauri::AppHandle, xapp_token: String) -> Result<String, String> {
    if SOCKET_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok("already running".to_string());
    }
    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut consecutive_fails: u32 = 0;
        loop {
            match run_socket_loop(&app_clone, &xapp_token).await {
                Ok(_) => {
                    // 정상 종료(서버 disconnect 등) → 즉시 재연결
                    consecutive_fails = 0;
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                },
                Err(e) => {
                    eprintln!("[socket] error: {}", e);
                    let _ = app_clone.emit("socket-status", serde_json::json!({"state": "error", "msg": e, "retry": consecutive_fails}));
                    consecutive_fails += 1;
                    // [v6.10.25] 지수 백오프: 2, 4, 8, 16, 30, 60, 60... (최대 60s 캡)
                    let delay = std::cmp::min(60u64, 2u64.pow(std::cmp::min(consecutive_fails, 6)));
                    tokio::time::sleep(tokio::time::Duration::from_secs(delay)).await;
                },
            }
        }
    });
    Ok("started".to_string())
}

async fn run_socket_loop(app: &tauri::AppHandle, xapp_token: &str) -> Result<(), String> {
    use futures_util::{StreamExt, SinkExt};
    use tokio_tungstenite::tungstenite::Message;

    // 1. apps.connections.open → wss URL (debug=true → ping 받음)
    let client = reqwest::Client::new();
    let resp = client.post("https://slack.com/api/apps.connections.open")
        .header("Authorization", format!("Bearer {}", xapp_token))
        .header("Content-Type", "application/json; charset=utf-8")
        .send().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("apps.connections.open: {}", json));
    }
    let url = json.get("url").and_then(|v| v.as_str()).ok_or("no url")?.to_string();
    let _ = app.emit("socket-status", serde_json::json!({"state": "connecting"}));

    // 2. WebSocket connect
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| e.to_string())?;
    let _ = app.emit("socket-status", serde_json::json!({"state": "connected"}));
    let (mut write, mut read) = ws.split();

    // 3. 주기적 ping (30초마다 — Slack 권장)
    let ping_app = app.clone();
    let ping_handle = tokio::spawn(async move {
        let mut last_emit = std::time::Instant::now();
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
            if last_emit.elapsed() > std::time::Duration::from_secs(120) {
                let _ = ping_app.emit("socket-status", serde_json::json!({"state": "stale"}));
            }
            last_emit = std::time::Instant::now();
        }
    });

    // 4. 수신 루프
    let recv_result: Result<(), String> = async {
        while let Some(msg) = read.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            match msg {
                Message::Text(txt) => {
                    let v: serde_json::Value = match serde_json::from_str(&txt) {
                        Ok(x) => x, Err(_) => continue,
                    };
                    if let Some(envelope_id) = v.get("envelope_id").and_then(|x| x.as_str()) {
                        let ack = serde_json::json!({ "envelope_id": envelope_id });
                        let _ = write.send(Message::Text(ack.to_string())).await;
                    }
                    let _ = app.emit("slack-event", v);
                }
                Message::Ping(p) => { let _ = write.send(Message::Pong(p)).await; }
                Message::Close(_) => return Err("close frame received".to_string()),
                _ => {}
            }
        }
        Err("socket closed".to_string())
    }.await;
    ping_handle.abort();
    recv_result
}

// ========= 작업 표시줄 unread 배지 (Windows taskbar overlay icon) =========
#[tauri::command]
fn set_unread_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    if count > 0 {
        // Windows 전용 overlay icon (macOS는 트레이 tooltip만)
        #[cfg(target_os = "windows")]
        {
            if let Some(w) = app.get_webview_window("main") {
                let icon = tauri::include_image!("icons/badge_red.png");
                let _ = w.set_overlay_icon(Some(icon));
            }
        }
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_tooltip(Some(format!("Slack 대시보드 ({} 안 읽음)", count)));
        }
    } else {
        #[cfg(target_os = "windows")]
        {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_overlay_icon(None);
            }
        }
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_tooltip(Some("Slack 대시보드".to_string()));
        }
    }
    Ok(())
}

// ========= 라벨 prefix로 채팅창 강제 close (테스트/메뉴용) =========
#[tauri::command]
fn close_chats_starting_with(app: tauri::AppHandle, prefix: String) -> Result<u32, String> {
    let labels: Vec<String> = app.webview_windows().keys()
        .filter(|l| l.starts_with(&prefix))
        .cloned().collect();
    let n = labels.len() as u32;
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) { let _ = w.destroy(); }
    }
    Ok(n)
}

// ========= 피드백 라이터 =========
#[tauri::command]
fn write_feedback(app: tauri::AppHandle, name: String, content: String) -> Result<String, String> {
    let dir: PathBuf = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let feedback_dir = dir.join("feedback");
    fs::create_dir_all(&feedback_dir).map_err(|e| e.to_string())?;
    let path = feedback_dir.join(format!("{}.json", name));
    let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![gas_call, run_login_flow, write_feedback, open_chat_window, close_chats_starting_with, slack_api, slack_fetch_image, open_external_url, open_image_window_inline, diag_slack_cookies, download_and_open, open_slack_login, save_slack_token, load_slack_token, set_unread_badge, save_xapp_token, load_xapp_token, start_socket_mode, open_image_window])
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            if label == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            } else if label.starts_with("chat-") {
                // 채팅 창 X → hide만 (재사용 → 다시 클릭 즉시 표시)
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "열기", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "숨기기", true, None::<&str>)?;
            let close_chats_item = MenuItem::with_id(app, "close_chats", "채팅창 모두 닫기", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "완전 종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &close_chats_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Slack 대시보드")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.unminimize();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "close_chats" => {
                        // 채팅 창 모두 진짜 close (재사용 해제)
                        let labels: Vec<String> = app.webview_windows().keys()
                            .filter(|l| l.starts_with("chat-"))
                            .cloned().collect();
                        for l in labels {
                            if let Some(w) = app.get_webview_window(&l) {
                                let _ = w.destroy();
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = w.unminimize();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
