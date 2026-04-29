<script>
    // ============================================================
    // [v3.2] google.script.run → JSONP 어댑터 (GitHub Pages용)
    // ============================================================
    // GitHub Pages는 Apps Script HtmlService 외부이므로 google.script.run이 없음.
    // 동일한 호출 문법 그대로 JSONP로 변환해서 /exec 호출.
    // 기존 클라이언트 코드(아래)는 한 줄도 수정하지 않아도 됨.
    // ============================================================
    (function() {
        var APPS_SCRIPT_URL = 'https://script.google.com/a/macros/solbox.com/s/AKfycbw8fLY8VSJLmYZJ1rcPtcDgQ3j-fJSci8PuYwX12U_fg52atFWaXsmIGZHiV2gWnjRCrg/exec';

        // [Tauri] JSONP가 Google 리다이렉트를 못 따라가므로 fetch()로 직접 호출
        var __isTauriEnv = (typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_INTERNALS__ !== 'undefined');

        function fetchCall(action, args, onSuccess, onFailure) {
            var url = APPS_SCRIPT_URL +
                '?action=' + encodeURIComponent(action) +
                '&args=' + encodeURIComponent(JSON.stringify(args || []));
            // [Tauri] Rust invoke로 직접 fetch (CORS 완전 우회)
            var T = window.__TAURI__;
            var invoke = T && T.core && T.core.invoke;
            if (invoke) {
                invoke('rust_fetch', { url: url })
                    .then(function(txt) {
                        // Google 로그인 페이지가 돌아왔는지 감지
                        if (typeof txt === 'string' && /accounts\.google\.com|signin|OpenIDConnect/i.test(txt.slice(0, 800))) {
                            console.warn('[fetchCall] Google 로그인 필요 — 로그인 창 띄움');
                            // 로그인 창 띄우고 사용자가 닫으면 자동 재시도
                            invoke('open_login_window', { url: APPS_SCRIPT_URL + '?action=ping' });
                            if (onFailure) onFailure('Google 로그인 필요 — 새 창에서 본인 @solbox.com 계정으로 로그인 후 창 닫고 다시 시도해주세요');
                            return;
                        }
                        var parsed;
                        try { parsed = JSON.parse(txt); }
                        catch(e) {
                            var m = txt.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
                            if (m) { try { parsed = JSON.parse(m[1]); } catch(e2) { parsed = txt; } }
                            else { parsed = txt; }
                        }
                        if (onSuccess) { try { onSuccess(parsed); } catch(e) { console.error('[invoke cb]', action, e); } }
                    })
                    .catch(function(err) {
                        if (onFailure) onFailure('rust_fetch error: ' + action + ' (' + (err.message || err) + ')');
                    });
                return;
            }
            // 폴백: 일반 fetch
            var ctl = new AbortController();
            var timeoutId = setTimeout(function() { ctl.abort(); }, 30000);
            window.fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, cache: 'no-store' })
                .then(function(r) { return r.text(); })
                .then(function(txt) {
                    clearTimeout(timeoutId);
                    // GAS가 JSONP 형태(callback_name({...})) 또는 순수 JSON으로 응답 가능
                    var parsed;
                    try { parsed = JSON.parse(txt); }
                    catch(e) {
                        // JSONP 래퍼 제거 시도: xxx({...})
                        var m = txt.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
                        if (m) { try { parsed = JSON.parse(m[1]); } catch(e2) { parsed = txt; } }
                        else { parsed = txt; }
                    }
                    if (onSuccess) { try { onSuccess(parsed); } catch(e) { console.error('[fetch cb]', action, e); } }
                })
                .catch(function(err) {
                    clearTimeout(timeoutId);
                    if (onFailure) onFailure('network error: ' + action + ' (' + (err.message || err) + ')');
                });
        }

        // [Tauri] 메인 webview 쿠키 추출 → Rust reqwest로 GAS 호출 (CORS/Google인증 우회)
        //   첫 호출이 LOGIN_REQUIRED면 자동으로 로그인 창 띄워서 사용자 로그인 → 쿠키 저장 후 재시도
        var __loginPromise = null;
        function tauriGasCall(action, args, onSuccess, onFailure, _retried) {
            var T = window.__TAURI__;
            var inv = T && T.core && T.core.invoke;
            if (!inv) { if (onFailure) onFailure('invoke 불가'); return; }
            var url = APPS_SCRIPT_URL +
                '?action=' + encodeURIComponent(action) +
                '&args=' + encodeURIComponent(JSON.stringify(args || []));
            inv('gas_call', { url: url })
                .then(function(txt) {
                    var parsed;
                    try { parsed = JSON.parse(txt); }
                    catch(e) {
                        var m = String(txt).match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
                        if (m) { try { parsed = JSON.parse(m[1]); } catch(e2) { parsed = txt; } }
                        else { parsed = txt; }
                    }
                    if (onSuccess) { try { onSuccess(parsed); } catch(e) { console.error('[gas]', action, e); } }
                })
                .catch(function(err) {
                    var msg = String(err && err.message || err);
                    if (msg.indexOf('LOGIN_REQUIRED') >= 0 && !_retried) {
                        // 동시 다발 호출이 모두 LOGIN_REQUIRED → 로그인은 1번만 진행
                        if (!__loginPromise) {
                            __loginPromise = inv('run_login_flow', { pingUrl: APPS_SCRIPT_URL + '?action=ping' })
                                .finally(function() { __loginPromise = null; });
                        }
                        __loginPromise
                            .then(function() {
                                tauriGasCall(action, args, onSuccess, onFailure, true);
                            })
                            .catch(function(e) {
                                if (onFailure) onFailure('login 실패: ' + e);
                            });
                        return;
                    }
                    if (onFailure) onFailure('gas error: ' + action + ' (' + msg + ')');
                });
        }

        function jsonpCall(action, args, onSuccess, onFailure) {
            // [v4.0] Tauri면 webview 쿠키 추출 → Rust reqwest 호출 (안정/빠름)
            if (__isTauriEnv) return tauriGasCall(action, args, onSuccess, onFailure);
            // PWA는 JSONP
            var cbName = '_gsr_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
            var timeoutId = setTimeout(function() {
                cleanup();
                if (onFailure) onFailure('timeout: ' + action);
            }, 30000);
            function cleanup() {
                clearTimeout(timeoutId);
                try { delete window[cbName]; } catch(e) { window[cbName] = undefined; }
                var s = document.getElementById(cbName);
                if (s && s.parentNode) s.parentNode.removeChild(s);
            }
            window[cbName] = function(result) {
                cleanup();
                if (onSuccess) {
                    try { onSuccess(result); } catch(e) { console.error('[gsr success cb]', action, e); }
                }
            };
            var script = document.createElement('script');
            script.id = cbName;
            script.onerror = function() {
                cleanup();
                // [Tauri] 로그인 안 된 webview면 GAS가 HTML(로그인 페이지) 응답 → script 실행 실패 → onerror
                //   사용자에게 로그인 창 띄워서 한 번 본인 Google 계정으로 로그인 받기
                if (__isTauriEnv && !window.__gasLoggedIn) {
                    var T = window.__TAURI__;
                    var inv = T && T.core && T.core.invoke;
                    if (inv) {
                        window.__gasLoggedIn = 'pending';
                        inv('open_login_window', { url: APPS_SCRIPT_URL + '?action=ping' });
                        if (onFailure) onFailure('Google 로그인 필요 — 새 창에서 본인 @solbox.com 계정 선택 → 로그인 → 창 닫기 → 다시 시도');
                        return;
                    }
                }
                if (onFailure) onFailure('network error: ' + action);
            };
            // 성공 시 로그인 표시 캐시
            var origCb = window[cbName];
            window[cbName] = function(result) {
                window.__gasLoggedIn = true;
                if (origCb) origCb(result);
            };
            try {
                script.src = APPS_SCRIPT_URL +
                    '?action=' + encodeURIComponent(action) +
                    '&args=' + encodeURIComponent(JSON.stringify(args || [])) +
                    '&callback=' + cbName;
            } catch(e) {
                cleanup();
                if (onFailure) onFailure('arg encode fail: ' + e.message);
                return;
            }
            document.body.appendChild(script);
        }

        function makeRunner(success, failure) {
            return new Proxy({}, {
                get: function(_, prop) {
                    if (prop === 'withSuccessHandler') {
                        return function(cb) { return makeRunner(cb, failure); };
                    }
                    if (prop === 'withFailureHandler') {
                        return function(cb) { return makeRunner(success, cb); };
                    }
                    if (prop === 'withUserObject') {
                        return function() { return makeRunner(success, failure); };
                    }
                    // terminal call: google.script.run.fnName(arg1, arg2)
                    return function() {
                        var args = Array.prototype.slice.call(arguments);
                        jsonpCall(prop, args, success, failure);
                    };
                }
            });
        }

        // HtmlService 안에서 진짜 google.script.run이 있으면 그대로 사용,
        // 외부(GitHub Pages)면 JSONP 어댑터 주입.
        if (typeof window.google === 'undefined' || !window.google.script || !window.google.script.run) {
            window.google = window.google || {};
            window.google.script = window.google.script || {};
            window.google.script.run = makeRunner(null, null);
            console.log('[v3.2] google.script.run JSONP 어댑터 활성화 (GitHub Pages 모드)');
        }
    })();

    // ============================================================
    // [v0.2] 개인대시보드 Slack - 카카오톡 스타일 UI
    // ============================================================
    // OAuth 연동 전 UI 확인용. 더미 데이터 기반.
    // 추후 OAuth 연동 시 이 더미 데이터를 실제 Slack API 응답으로 교체.
    // ============================================================

    // ============================================================
    // 상태
    // ============================================================
    var currentSlackTab = 'dm';           // 'dm' | 'channel' | 'canvas'
    var slackSearchQuery = '';
    var openSlackPopups = [];             // [{ id, type, name, data, minimized, el }]
    var MAX_SLACK_POPUPS = 5;
    var nextSlackPopupZ = 500100;
    var toastTimeout;
    // [v0.5] 추가 상태
    var myUserName = '나';
    var popupUnreadMap = {};              // { popupId: unreadCount } - 최소화 상태에서 받은 새 메시지 수
    var EMOJI_PICKER_LIST = ['👍','❤️','😂','😮','😢','🙏','👏','🎉','🔥','💯','✨','✅','❌','⚠️','🤔','👀','🙌','💪','😊','☕'];
    var emojiPickerCallback = null;
    var activeMentionState = null;        // { popupId, startPos, members }
    // [v2.9] Delta 폴링 상태
    var focusedPopupId = '';              // 현재 포커스된 (대화 중인) 팝업 ID
    var slackDeltaInterval = null;        // 포커스 팝업 전용 1초 타이머
    var slackCacheInterval = null;        // 나머지 3초 타이머

    // ============================================================
    // [v0.8] 실제 데이터용 빈 배열 (더미 데이터 전부 제거)
    // Slack API에서 채워짐. 연결 안 된 상태에선 빈 목록 + 연동 버튼 표시.
    // ============================================================
    var dummyFriends = [];  // [v2.6] 친구 목록 (전체 멤버)
    var dummyDMs = [];
    var dummyChannels = [];
    var dummyCanvases = [];
    var dummyMessagesMap = {};

    // ============================================================
    // 공통 유틸
    // ============================================================
    function showToast(m) {
        var t = document.getElementById("toastMsg");
        if (!t) return;
        t.innerText = m;
        t.classList.add("show");
        if (toastTimeout) clearTimeout(toastTimeout);
        var duration = (m.indexOf("실패") !== -1 || m.indexOf("오류") !== -1) ? 5000 : 2500;
        toastTimeout = setTimeout(function() { t.classList.remove("show"); }, duration);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function avatarColorFromName(name) {
        var palette = ['#fbbf24', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f59e0b'];
        var h = 0;
        for (var i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
        return palette[Math.abs(h) % palette.length];
    }

    function firstCharOf(name) {
        if (!name) return '?';
        return name.charAt(0).toUpperCase();
    }

    // ============================================================
    // [v3.4] 메인↔자식 창 데이터 공유 (localStorage)
    // ============================================================
    // 자식 창은 별도 JS 컨텍스트라 dummyDMs/slackUsersMap을 못 봄.
    // 메인 창이 데이터 받으면 localStorage에 저장 → 자식 창이 즉시 읽기.
    // 메시지 캐시도 공유해서 자식 창에서 즉시 표시 (낙관적 UI 효과).
    // ============================================================
    var LS_KEY_SLACK = 'slack_dashboard_cache_v1';
    var LS_KEY_MSGS = 'slack_dashboard_msgs_v1';

    // ============================================================
    // [v3.6] 바탕화면 설치 도우미 (Windows/Mac/모바일 모두)
    // ============================================================
    var __deferredPwaPrompt = null;
    window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        __deferredPwaPrompt = e;
        // 버튼 있으면 활성화 표시
        var btn = document.getElementById('installPwaBtn');
        if (btn) btn.disabled = false;
    });
    window.addEventListener('appinstalled', function() {
        try { showToast('✅ 설치 완료! 바탕화면/시작 메뉴에서 실행하세요'); } catch(e) {}
        __deferredPwaPrompt = null;
        try { localStorage.setItem('slack_dashboard_installed', '1'); } catch(e) {}
    });

    function detectPlatform() {
        var ua = navigator.userAgent;
        var isMac = /Mac|iPhone|iPad|iPod/.test(ua) && !/Windows/.test(ua);
        var isWindows = /Windows/.test(ua);
        var isMobile = /Mobi|Android|iPhone|iPad/.test(ua);
        var isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
        var isChrome = /Chrome|Chromium/.test(ua) && !/Edg/.test(ua);
        var isEdge = /Edg/.test(ua);
        var isWhale = /Whale/.test(ua);
        return {
            isMac: isMac, isWindows: isWindows, isMobile: isMobile,
            isSafari: isSafari, isChrome: isChrome, isEdge: isEdge, isWhale: isWhale,
            pwaSupported: isChrome || isEdge || isWhale  // Chromium 기반만 beforeinstallprompt 지원
        };
    }

    // [v3.8] 원클릭 설치 — 플랫폼 감지해서 최적 방식 자동 실행
    function quickInstall() {
        var p = detectPlatform();
        // 1) 알림 권한 먼저 요청 (사용자 제스처 있을 때)
        if ('Notification' in window && Notification.permission === 'default') {
            try { Notification.requestPermission(); } catch(e) {}
        }
        // 2) Mac/Chrome/Edge/웨일 PWA: install prompt가 있으면 그걸 먼저
        if (__deferredPwaPrompt) {
            __deferredPwaPrompt.prompt();
            __deferredPwaPrompt.userChoice.then(function(result) {
                __deferredPwaPrompt = null;
                if (result.outcome === 'accepted') {
                    showToast('✅ 앱으로 설치됨! 시작 메뉴/Launchpad에서 실행하세요');
                    // Windows는 추가로 .bat 다운로드도 (바탕화면 바로가기 자동 생성용)
                    if (p.isWindows) {
                        setTimeout(function() {
                            if (confirm('바탕화면에 바로가기도 만들까요?\n\n"확인" 누르면 설치 파일이 다운로드돼요. 더블클릭 한 번이면 바탕화면에 바로가기 생성!')) {
                                downloadBatShortcut();
                            }
                        }, 800);
                    }
                } else {
                    showToast('설치 취소됨');
                }
            });
            return;
        }
        // 3) PWA prompt 없음 → 플랫폼별 대체
        if (p.isMac) {
            // Mac Chrome/Edge: PWA install 권장 (주소창 ⊕)
            if (p.isSafari) {
                alert('Safari에서는 자동 설치 불가능해요.\n\nChrome 또는 Edge로 접속하면 원클릭 설치 됩니다.\n\n또는: Safari 상단 공유(□↑) → "Dock에 추가"');
                return;
            }
            alert('Chrome/Edge에서:\n주소창 오른쪽 ⊕ 아이콘을 클릭하면 바로 설치돼요!\n\n이미 설치된 경우: Launchpad에서 "Slack 대시보드" 실행');
            return;
        }
        if (p.isWindows) {
            // 바로 .bat 다운로드 + 실행 안내
            downloadBatShortcut();
            return;
        }
        if (p.isMobile) {
            alert('모바일:\nChrome 우측 상단 ⋮ → "홈 화면에 추가"\n또는 Safari 공유 → "홈 화면에 추가"');
            return;
        }
        alert('Chrome/Edge 브라우저에서 접속해주세요.\n주소창 옆 ⊕ 아이콘으로 원클릭 설치됩니다.');
    }
    window.quickInstall = quickInstall;

    function openInstallModal() {
        var modal = document.getElementById('installModal');
        if (!modal) return;
        modal.classList.add('visible');
        // 플랫폼에 따라 UI 조정
        var p = detectPlatform();
        var pwaBtn = document.getElementById('installPwaBtn');
        var pwaHint = document.getElementById('installPwaHint');
        if (pwaBtn) {
            if (!p.pwaSupported) {
                // Safari 등 PWA install prompt 미지원
                pwaBtn.disabled = true;
                pwaBtn.textContent = '🍎 Safari에선 아래 방법 사용';
                if (pwaHint) {
                    pwaHint.style.display = 'block';
                    pwaHint.innerHTML = '⚠️ Safari는 자동 설치 미지원. <b>Chrome/Edge로 열거나</b> 아래 "Safari용" 방법 사용';
                }
            } else if (!__deferredPwaPrompt) {
                // beforeinstallprompt 아직 안 발생
                pwaBtn.textContent = '📦 설치 시도 (또는 주소창 ⊕ 아이콘)';
                if (pwaHint) {
                    pwaHint.style.display = 'block';
                    pwaHint.innerHTML = '💡 이미 설치되어 있으면 이 버튼 비활성. 주소창 우측의 <b>⊕ 또는 설치 아이콘</b>을 클릭해서 설치하세요';
                }
            } else {
                pwaBtn.textContent = '📦 지금 설치';
                if (pwaHint) pwaHint.style.display = 'none';
            }
        }
    }
    window.openInstallModal = openInstallModal;

    function closeInstallModal() {
        var modal = document.getElementById('installModal');
        if (modal) modal.classList.remove('visible');
    }
    window.closeInstallModal = closeInstallModal;

    function triggerPwaInstall() {
        // 1. 알림 권한도 겸사 요청 (사용자 제스처 필요)
        if ('Notification' in window && Notification.permission === 'default') {
            try { Notification.requestPermission(); } catch(e) {}
        }
        // 2. PWA install prompt
        if (__deferredPwaPrompt) {
            __deferredPwaPrompt.prompt();
            __deferredPwaPrompt.userChoice.then(function(result) {
                if (result.outcome === 'accepted') {
                    showToast('✅ 설치 진행 중...');
                } else {
                    showToast('설치 취소됨');
                }
                __deferredPwaPrompt = null;
            });
        } else {
            // prompt 없으면 수동 안내
            var p = detectPlatform();
            if (p.isChrome || p.isEdge || p.isWhale) {
                showToast('주소창 우측 ⊕ 아이콘 클릭해서 설치하세요 (이미 설치됐다면 비활성)');
            } else if (p.isSafari && p.isMac) {
                showToast('Safari: 공유(□↑) → Dock에 추가');
            } else if (p.isSafari && p.isMobile) {
                showToast('iOS Safari: 공유 → 홈 화면에 추가');
            } else {
                showToast('Chrome 또는 Edge에서 접속해주세요');
            }
        }
    }
    window.triggerPwaInstall = triggerPwaInstall;

    function downloadBatShortcut() {
        var p = detectPlatform();
        var url = 'https://hyshin6664.github.io/slack-dashboard/';
        if (p.isMac) {
            // Mac: .command 파일 다운로드 + 실행 권한 부여 안내
            var script = '#!/bin/bash\n' +
                'open -na "Google Chrome" --args --app=' + url + '\n';
            _downloadFile('Slack대시보드.command', script, 'text/plain');
            showToast('✅ .command 다운로드! 아래 안내 참고');
            alert(
                '맥 설치 방법:\n\n' +
                '1. Finder → 다운로드 폴더\n' +
                '2. Slack대시보드.command 를 /Applications 폴더로 이동\n' +
                '3. 터미널 열고 실행: chmod +x "/Applications/Slack대시보드.command"\n' +
                '4. 더블클릭 → Chrome 앱 모드로 열림\n\n' +
                '💡 더 간편: Chrome에서 ⋮ → 캐스트, 저장, 공유 → 바로가기 만들기'
            );
        } else {
            // [v3.7.1] Windows: 설치 .bat — 한 번 실행하면 바탕화면에 .lnk 자동 생성
            //   - PowerShell이 .lnk 파일을 Desktop에 만듦
            //   - 이후 사용자는 바탕화면의 .lnk 더블클릭 → Chrome 앱 모드 실행
            //   - 이 .bat는 한 번만 실행하면 됨 (설치 후 삭제 OK)
            var bat =
                '@echo off\r\n' +
                'chcp 65001 >nul\r\n' +
                'setlocal\r\n' +
                'set APP_URL=' + url + '\r\n' +
                'set SHORTCUT_NAME=Slack 대시보드\r\n' +
                'set DESKTOP=%USERPROFILE%\\Desktop\r\n' +
                'set LNK_PATH=%DESKTOP%\\%SHORTCUT_NAME%.lnk\r\n' +
                '\r\n' +
                'rem Chrome 경로 자동 감지\r\n' +
                'set CHROME_EXE=\r\n' +
                'if exist "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" set CHROME_EXE=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n' +
                'if "%CHROME_EXE%"=="" if exist "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" set CHROME_EXE=C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe\r\n' +
                'if "%CHROME_EXE%"=="" if exist "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" set CHROME_EXE=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe\r\n' +
                '\r\n' +
                'if "%CHROME_EXE%"=="" (\r\n' +
                '  echo [!] Chrome을 찾을 수 없어요. Chrome 설치 후 다시 실행하세요.\r\n' +
                '  pause\r\n' +
                '  exit /b 1\r\n' +
                ')\r\n' +
                '\r\n' +
                'rem PowerShell로 바탕화면에 .lnk 바로가기 생성\r\n' +
                'powershell -NoProfile -ExecutionPolicy Bypass -Command ^\r\n' +
                '  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(\'%LNK_PATH%\'); $s.TargetPath = \'%CHROME_EXE%\'; $s.Arguments = \'--app=%APP_URL%\'; $s.IconLocation = \'%CHROME_EXE%,0\'; $s.WorkingDirectory = \'%USERPROFILE%\'; $s.Description = \'Slack 대시보드\'; $s.Save()"\r\n' +
                '\r\n' +
                'if exist "%LNK_PATH%" (\r\n' +
                '  echo.\r\n' +
                '  echo [O] 바탕화면에 "Slack 대시보드" 바로가기를 만들었어요!\r\n' +
                '  echo     더블클릭으로 실행하세요.\r\n' +
                '  echo.\r\n' +
                '  timeout /t 3 >nul\r\n' +
                ') else (\r\n' +
                '  echo [!] 바로가기 생성 실패\r\n' +
                '  pause\r\n' +
                ')\r\n' +
                'endlocal\r\n';
            _downloadFile('설치_Slack대시보드.bat', bat, 'application/octet-stream');
            showToast('✅ 설치 파일 다운로드! 더블클릭 → 바탕화면에 바로가기 자동 생성');
            setTimeout(function() {
                alert(
                    '✨ 바탕화면 바로가기 자동 설치\n\n' +
                    '1. 다운로드된 "설치_Slack대시보드.bat" 더블클릭\n' +
                    '2. Windows 보안 경고 뜨면 "추가 정보 → 실행"\n' +
                    '3. 검은 창 잠깐 떴다 사라지면 끝!\n' +
                    '4. 바탕화면에 "Slack 대시보드" 아이콘 생성됨 ✅\n' +
                    '5. 이 .bat 파일은 더 이상 필요 없음 (삭제 OK)\n\n' +
                    '💡 바로가기 더블클릭하면 Chrome 앱 모드로 깔끔하게 실행됩니다.'
                );
            }, 300);
        }
    }
    window.downloadBatShortcut = downloadBatShortcut;

    // [v3.7] 대시보드 사용 통계 (자랑용)
    var __lastStats = null;
    function pingAndLoadStats() {
        // 1) ping (오늘 접속 기록)
        google.script.run
            .withSuccessHandler(function() {
                // 2) 통계 조회 → 위젯 표시
                google.script.run
                    .withSuccessHandler(function(r) {
                        if (!r || !r.success) return;
                        __lastStats = r;
                        var w = document.getElementById('dashboardStatsWidget');
                        if (w) {
                            // 아이콘만 표시 (클릭하면 상세)
                            w.style.display = 'inline-flex';
                            w.title = '👥 대시보드 사용자 — 오늘 ' + (r.today||0) + '명 / 7일 ' + (r.week||0) + '명 / 총 ' + (r.total||0) + '명';
                        }
                    })
                    .getDashboardStats();
            })
            .withFailureHandler(function() {})
            .pingUser();
    }
    function showDashboardStatsDetail() {
        var modal = document.getElementById('dashboardStatsModal');
        if (!modal) return;
        // 최신 통계 다시 가져오기
        google.script.run
            .withSuccessHandler(function(r) {
                if (r && r.success) __lastStats = r;
                var s = __lastStats || {};
                var elToday = document.getElementById('statDetailToday');
                var el7 = document.getElementById('statDetail7day');
                var elTot = document.getElementById('statDetailTotal');
                if (elToday) elToday.textContent = s.today || 0;
                if (el7) el7.textContent = s.week || 0;
                if (elTot) elTot.textContent = s.total || 0;
                modal.classList.add('visible');
            })
            .withFailureHandler(function() {
                // 실패해도 캐시로 표시
                var s = __lastStats || {};
                var elToday = document.getElementById('statDetailToday');
                var el7 = document.getElementById('statDetail7day');
                var elTot = document.getElementById('statDetailTotal');
                if (elToday) elToday.textContent = s.today || 0;
                if (el7) el7.textContent = s.week || 0;
                if (elTot) elTot.textContent = s.total || 0;
                modal.classList.add('visible');
            })
            .getDashboardStats();
    }
    function closeDashboardStatsModal() {
        var modal = document.getElementById('dashboardStatsModal');
        if (modal) modal.classList.remove('visible');
    }
    window.showDashboardStatsDetail = showDashboardStatsDetail;
    window.closeDashboardStatsModal = closeDashboardStatsModal;

    // [v3.6] 사용법 도움말 모달
    function openHelpGuideModal() {
        var m = document.getElementById('helpGuideModal');
        if (m) m.classList.add('visible');
    }
    function closeHelpGuideModal() {
        var m = document.getElementById('helpGuideModal');
        if (m) m.classList.remove('visible');
    }
    function copyHelpShareUrl() {
        var url = 'https://hyshin6664.github.io/slack-dashboard/';
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function() {
                    showToast('✅ URL 복사됨! 직원들에게 공유하세요');
                }).catch(function() {
                    _fallbackCopyText(url);
                });
            } else {
                _fallbackCopyText(url);
            }
        } catch(e) { _fallbackCopyText(url); }
    }
    function _fallbackCopyText(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('✅ URL 복사됨!');
        } catch(e) {
            showToast('복사 실패 — 수동으로 복사해주세요');
        }
    }
    window.openHelpGuideModal = openHelpGuideModal;
    window.closeHelpGuideModal = closeHelpGuideModal;
    window.copyHelpShareUrl = copyHelpShareUrl;

    function _downloadFile(filename, content, mimeType) {
        try {
            // BOM 추가 (UTF-8 한글 파일명 안전)
            var blob = new Blob([content], { type: mimeType || 'text/plain' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function() {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        } catch(e) {
            alert('다운로드 실패: ' + e.message);
        }
    }

    function saveSlackCacheToStorage() {
        try {
            localStorage.setItem(LS_KEY_SLACK, JSON.stringify({
                dms: dummyDMs,
                channels: dummyChannels,
                canvases: dummyCanvases,
                usersMap: slackUsersMap,
                myUserId: slackMyUserId,
                savedAt: Date.now()
            }));
        } catch(e) {}
    }
    function loadSlackCacheFromStorage() {
        try {
            var raw = localStorage.getItem(LS_KEY_SLACK);
            if (!raw) return false;
            var data = JSON.parse(raw);
            if (!data) return false;
            if (data.dms && data.dms.length) dummyDMs = data.dms;
            if (data.channels && data.channels.length) dummyChannels = data.channels;
            if (data.canvases && data.canvases.length) dummyCanvases = data.canvases;
            if (data.usersMap) slackUsersMap = data.usersMap;
            if (data.myUserId) slackMyUserId = data.myUserId;
            slackRealMode = true;
            return true;
        } catch(e) { return false; }
    }
    function saveSlackMessagesToStorage(channelId) {
        try {
            var raw = localStorage.getItem(LS_KEY_MSGS);
            var all = raw ? JSON.parse(raw) : {};
            var msgs = dummyMessagesMap[channelId] || [];
            all[channelId] = msgs;
            var keys = Object.keys(all);
            if (keys.length > 20) {
                keys.slice(0, keys.length - 20).forEach(function(k) { delete all[k]; });
            }
            localStorage.setItem(LS_KEY_MSGS, JSON.stringify(all));
            console.log('[LS save]', channelId, msgs.length, '개 → LS key=' + LS_KEY_MSGS + ', 총 채널:', Object.keys(all).length);
        } catch(e) { console.warn('[LS save 실패]', channelId, e && e.message); }
    }
    function loadSlackMessagesFromStorage(channelId) {
        try {
            var raw = localStorage.getItem(LS_KEY_MSGS);
            if (!raw) { console.log('[LS load]', channelId, '→ LS 비어있음 key=' + LS_KEY_MSGS); return null; }
            var all = JSON.parse(raw);
            var found = (all && all[channelId]) || null;
            console.log('[LS load]', channelId, '→', found ? found.length + '개 hit' : 'MISS', '(총', Object.keys(all || {}).length, '채널)');
            return found;
        } catch(e) { console.warn('[LS load 실패]', channelId, e && e.message); return null; }
    }
    // 전역 노출 (multi_window.js가 호출할 수 있게)
    window.__slackSaveCache = saveSlackCacheToStorage;
    window.__slackLoadCache = loadSlackCacheFromStorage;
    window.__slackSaveMessages = saveSlackMessagesToStorage;
    window.__slackLoadMessages = loadSlackMessagesFromStorage;
    // [v4.8 debug] 진단용 전역 노출
    window.__slackDummyMessagesMap = dummyMessagesMap;
    window.__slackLSKey = LS_KEY_MSGS;

    // [v4.5] 상위 채널 백그라운드 prefetch — 클릭 시 즉시 표시되도록 미리 받아둠
    //   CPU/네트워크 부담 최소화: 1.5초 간격, 최대 8개, 캐시 있으면 skip
    var __prefetchInProgress = false;
    var __prefetchDoneAt = 0;
    function prefetchTopChats() {
        if (location.search.indexOf('chatWindow=1') >= 0) { return; }
        if (__prefetchInProgress) return;
        if (!slackRealMode) return;
        // [v5.10] 이미 prefetch 완료했으면 10분 쿨다운 (매 폴링마다 재실행 방지)
        if (__prefetchDoneAt && Date.now() - __prefetchDoneAt < 600000) return;
        console.log('[prefetch] 시작 — 상위 채팅 미리 받기');
        __prefetchInProgress = true;
        var queue = [];
        // 상위 5개 DM
        var sortedDM = (dummyDMs || []).slice().sort(function(a,b){
            var aRaw = a.timeRaw || 0; var bRaw = b.timeRaw || 0;
            var aMs = (aRaw < 1e11) ? aRaw * 1000 : aRaw;
            var bMs = (bRaw < 1e11) ? bRaw * 1000 : bRaw;
            return bMs - aMs;
        });
        sortedDM.slice(0, 20).forEach(function(d) { if (d.id) queue.push(d.id); });
        // 상위 10개 채널
        var sortedCh = (dummyChannels || []).slice().sort(function(a,b){
            var aRaw = a.timeRaw || 0; var bRaw = b.timeRaw || 0;
            var aMs = (aRaw < 1e11) ? aRaw * 1000 : aRaw;
            var bMs = (bRaw < 1e11) ? bRaw * 1000 : bRaw;
            return bMs - aMs;
        });
        sortedCh.slice(0, 10).forEach(function(c) { if (c.id) queue.push(c.id); });
        if (queue.length === 0) { __prefetchInProgress = false; console.log('[prefetch] 큐 비어있음'); return; }
        console.log('[prefetch] 큐:', queue.length, '개');
        // 동시 2개 병렬 fetch (속도 2배)
        var idx = 0;
        var done = 0;
        function fetchOne(cid) {
            // 이미 메모리/캐시에 있으면 스킵
            if (dummyMessagesMap[cid] && dummyMessagesMap[cid].length > 0) {
                done++; tryNext(); return;
            }
            try {
                var cached = loadSlackMessagesFromStorage(cid);
                if (cached && cached.length > 0) {
                    dummyMessagesMap[cid] = cached;
                    done++; tryNext(); return;
                }
            } catch(e) {}
            console.log('[prefetch] 받는중:', cid);
            // [v5.0] Slack API 직접 호출 우선 (200ms) — 실패 시 GAS fallback
            (async function() {
                try {
                    var t0 = Date.now();
                    var res = await window.__slackDirect('conversations.history', { channel: cid, limit: 30 });
                    if (res && res.ok && Array.isArray(res.messages)) {
                        // Slack 응답 → 우리 형식 변환
                        var msgs = res.messages.slice().reverse().map(function(m) {
                            return {
                                id: 'm_' + m.ts,
                                ts: m.ts,
                                from: (slackUsersMap[m.user] && slackUsersMap[m.user].name) || m.username || m.bot_id || m.user || '',
                                fromId: m.user || '',
                                text: m.text || '',
                                time: '',
                                mine: m.user === slackMyUserId,
                                files: m.files || []
                            };
                        });
                        dummyMessagesMap[cid] = msgs;
                        try { saveSlackMessagesToStorage(cid); } catch(e) {}
                        console.log('[prefetch v5.0] 완료:', cid, msgs.length, '개,', (Date.now()-t0)+'ms');
                        done++; tryNext(); return;
                    }
                } catch(e) { console.log('[prefetch] Slack 직접 실패 → GAS', cid, e.message||e); }
                // GAS fallback
                try {
                    google.script.run
                        .withSuccessHandler(function(res) {
                            if (res && res.success && res.messages) {
                                dummyMessagesMap[cid] = res.messages;
                                try { saveSlackMessagesToStorage(cid); } catch(e) {}
                                console.log('[prefetch GAS] 완료:', cid, res.messages.length);
                            }
                            done++; tryNext();
                        })
                        .withFailureHandler(function(e) { console.warn('[prefetch] 실패:', cid, e); done++; tryNext(); })
                        .getSlackMessages(cid, 30);
                } catch(e) { done++; tryNext(); }
            })();
        }
        function tryNext() {
            if (done >= queue.length) {
                __prefetchInProgress = false;
                __prefetchDoneAt = Date.now();
                console.log('[prefetch] 전체 완료 — 10분 쿨다운');
                return;
            }
            if (idx >= queue.length) return;
            // [v5.0] Slack 직접일 때는 0.5초 간격, GAS면 1.5초 (rate 보호)
            var delay = __slackToken ? 500 : 1500;
            setTimeout(function() { fetchOne(queue[idx++]); }, delay);
        }
        // [v5.0] 시작 시 동시 3개 (Slack 직접이면 안전)
        var concurrency = __slackToken ? 3 : 1;
        for (var c = 0; c < concurrency && idx < queue.length; c++) {
            (function(d) { setTimeout(function() { fetchOne(queue[idx++]); }, d); })(c * 200);
        }
    }
    window.__slackPrefetchTop = prefetchTopChats;

    // [v3.4] 새 메시지 도착 시 대화 목록 재정렬 + 미리보기 갱신
    function updateChatListOrder(channelId, lastMsg) {
        if (!channelId) return;
        // 어느 목록에 있는지 찾기
        var lists = [dummyDMs, dummyChannels, dummyCanvases];
        var found = null;
        for (var li = 0; li < lists.length; li++) {
            for (var i = 0; i < lists[li].length; i++) {
                if (lists[li][i].id === channelId) { found = lists[li][i]; break; }
            }
            if (found) break;
        }
        if (!found) return;
        // 미리보기/시간 갱신
        if (lastMsg) {
            var preview = (lastMsg.from ? lastMsg.from + ': ' : '') + (lastMsg.text || '').substring(0, 60);
            found.preview = preview;
            found.time = lastMsg.time || '';
            var ts = parseFloat(lastMsg.ts || '0');
            if (ts > 0) found.timeRaw = ts * 1000;
            else found.timeRaw = Date.now();
            // [v3.7.4] 로컬 unread 추적 (Slack 공식 앱이 읽어도 우리 대시보드 배지 유지)
            if (!lastMsg.mine && channelId !== focusedPopupId) {
                found.unreadLocal = (found.unreadLocal || 0) + 1;
                found.unread = Math.max(found.unread || 0, found.unreadLocal);
            }
        }
        // 목록 재정렬 + 다시 그리기
        try { renderSlackChatList(); } catch(e) {}
        try { updateTabCounts(); } catch(e) {}
        try { saveSlackCacheToStorage(); } catch(e) {}
    }
    window.__slackUpdateChatListOrder = updateChatListOrder;

    // ============================================================
    // 초기화
    // ============================================================
    var slackUsersMap = {};       // [v0.6] 실제 사용자 이름 맵 { id: { name, email } }
    var slackMyUserId = '';       // [v0.6] 내 Slack user ID
    var slackRealMode = false;    // [v0.6] 실제 모드 여부

    // ============================================================
    // [v1.2] 연결 해제 → 재연동 가능
    // ============================================================
    function slackDisconnect() {
        if (!confirm('Slack 연결을 해제할까요?\n해제 후 다시 연동하면 새 권한이 적용돼요.\n\n(해제 후 "Slack 연동하기" 버튼이 나타나면 클릭해주세요)')) return;
        google.script.run
            .withSuccessHandler(function(res) {
                if (res && res.success) {
                    showToast('해제 완료! 연동 화면으로...');
                    slackRealMode = false;
                    // 바로 연동 화면 표시 (새로고침 대신!)
                    setTimeout(function() {
                        showSlackConnectScreen();
                    }, 500);
                } else {
                    showToast('해제 실패');
                }
            })
            .disconnectSlack();
    }

    // ============================================================
    // [v0.7] Slack 연동 (OAuth)
    // ============================================================
    function slackConnect() {
        showToast('Slack 연동 준비 중...');
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    showToast('연동 실패: ' + (res ? res.message : '오류'));
                    return;
                }
                if (res.connected) {
                    showToast('이미 연동됨! 새로고침...');
                    setTimeout(function() { location.reload(); }, 1000);
                    return;
                }
                if (res.url) {
                    window.open(res.url, '_blank');
                    showToast('새 탭에서 Slack "허용"을 클릭해주세요!');
                    // [v1.4] 폴링으로 연동 확인 (콜백 URL 재호출 안 함!)
                    var pollCount = 0;
                    var pollInterval = setInterval(function() {
                        pollCount++;
                        if (pollCount > 20) {
                            clearInterval(pollInterval);
                            showToast('새로고침(F5) 해주세요');
                            return;
                        }
                        google.script.run
                            .withSuccessHandler(function(s) {
                                if (s && s.success && s.connected) {
                                    clearInterval(pollInterval);
                                    showToast('연동 완료!');
                                    // 즉시 데이터 로드 (새로고침 안 함!)
                                    slackMyUserId = s.userId || '';
                                    loadRealSlackData();
                                }
                            })
                            .getSlackAuthStatus();
                    }, 3000);
                }
            })
            .withFailureHandler(function(err) { showToast('연동 실패: ' + err); })
            .getSlackAuthUrl();
    }

    // [v3.2] GitHub Pages는 app.js를 동적 fetch로 주입하므로 window.onload가 이미 지난 시점.
    // → 그래서 init을 즉시(또는 DOM 준비 후) 실행해야 함. 둘 다 등록.
    // [v4.3 Tauri] 별도 채팅 창에서 'chat-opened' 이벤트 받으면 메인 unread 즉시 0
    try {
        var __T_evt = window.__TAURI__;
        var __isChatWin = location.search.indexOf('chatWindow=1') >= 0;
        if (!__isChatWin && __T_evt && __T_evt.event && __T_evt.event.listen) {
            __T_evt.event.listen('chat-opened', function(ev) {
                try {
                    var p = (ev && ev.payload) || {};
                    var cid = p.id;
                    if (!cid) return;
                    [dummyDMs, dummyChannels, dummyCanvases].forEach(function(arr) {
                        if (!Array.isArray(arr)) return;
                        for (var i = 0; i < arr.length; i++) {
                            if (arr[i].id === cid) {
                                arr[i].unread = 0;
                                arr[i].unreadLocal = 0;
                            }
                        }
                    });
                    if (slackLastUnreadMap[cid]) slackLastUnreadMap[cid].unread = 0;
                    if (typeof renderSlackChatList === 'function') renderSlackChatList();
                    if (typeof updateTabCounts === 'function') updateTabCounts();
                    console.log('[Tauri] chat-opened 동기화:', cid);
                } catch(e) { console.warn('[chat-opened] 처리', e); }
            });
        }
    } catch(e) {}

    var __slackInitFn = function() {
        try {
            // [v4.13] chat-window 모드 — 메인 캐시 자동 로드 (slackRealMode + dummyDMs 복원)
            var __isChatWin0 = location.search.indexOf('chatWindow=1') >= 0;
            if (__isChatWin0) {
                try {
                    loadSlackCacheFromStorage();
                    console.log('[v4.13] chat-window 모드 — 메인 캐시 로드:', dummyDMs.length, 'DM,', dummyChannels.length, '채널, realMode=' + slackRealMode);
                } catch(e) { console.warn('[v4.13] cache 로드 실패', e); }
            }
            // [v3.6] PWA standalone 아니면 → 랜딩 페이지만 표시 (앱 기능 비활성)
            //   브라우저 탭으로 접속 = 직원 첫 방문 → 사용법 + 설치 유도만
            //   PWA 설치 후 실행 = standalone → 정상 대시보드
            var __landingMode = false;
            try {
                var inStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                                   (window.matchMedia && window.matchMedia('(display-mode: window-controls-overlay)').matches) ||
                                   (window.navigator && window.navigator.standalone === true);
                __landingMode = !inStandalone;
                // [Tauri] 네이티브 앱에서는 랜딩 페이지 스킵 → 바로 대시보드
                if (typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_INTERNALS__ !== 'undefined') {
                    __landingMode = false;
                }
            } catch(e) {}
            if (__landingMode) {
                // 대시보드 UI 모두 숨기고 랜딩만 표시
                var landing = document.getElementById('landingPage');
                if (landing) landing.style.display = 'block';
                var topBar = document.querySelector('.top-bar');
                if (topBar) topBar.style.display = 'none';
                var appContainer = document.querySelector('.app-container');
                if (appContainer) appContainer.style.display = 'none';
                document.body.style.background = '#f8fafc';
                document.body.style.overflow = 'auto';
                // 페이지 제목도 다르게
                document.title = '개인대시보드 Slack — 설치 안내';
                return; // 이후 init 스킵 (Slack 연동 등 비활성)
            }

            // [v3.6.2] PWA 첫 실행 시 창을 카톡 스타일로 좁게 리사이즈
            //   — 사이드바만 필요 (대화창은 별도 창으로 뜸)
            //   — 첫 1회만 (사용자가 수동 조절한 크기 존중)
            try {
                if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
                    if (!localStorage.getItem('slack_dashboard_sized_v1')) {
                        var targetW = 540;
                        var targetH = Math.min(window.screen.availHeight - 80, 960);
                        var leftPos = Math.max(0, window.screen.availWidth - targetW - 20);
                        // 리사이즈는 PWA에서만 작동
                        setTimeout(function() {
                            try {
                                window.resizeTo(targetW, targetH);
                                window.moveTo(leftPos, 20);
                            } catch(e) {}
                        }, 300);
                        localStorage.setItem('slack_dashboard_sized_v1', '1');
                    }
                }
            } catch(e) {}

            // [v5.12] 첫 실행 가속 — 캐시 있으면 즉시 목록 렌더 (서버 응답 안 기다림)
            try {
                var cachedOK = loadSlackCacheFromStorage();
                if (cachedOK && dummyDMs.length + dummyChannels.length > 0) {
                    window.__slackInitialPreviewsLoaded = true;
                    try { renderSlackChatList(); } catch(e) {}
                    try { updateTabCounts(); } catch(e) {}
                    console.log('[v5.12] 캐시 즉시 렌더 (DM ' + dummyDMs.length + ', 채널 ' + dummyChannels.length + ')');
                } else {
                    showSlackLoadingSkeleton();
                }
            } catch(e) { showSlackLoadingSkeleton(); }
            // [v0.7] 실제 Slack 연결 시도 (백그라운드 — 최신 데이터로 덮어씀)
            google.script.run
                .withSuccessHandler(function(res) {
                    if (res && res.success && res.connected) {
                        slackMyUserId = res.userId || '';
                        // 연동됨 → 실제 데이터 로드
                        loadRealSlackData();
                    } else {
                        // 연동 안 됨 → "Slack 연동하기" 버튼 표시
                        showSlackConnectScreen();
                    }
                })
                .withFailureHandler(function() {
                    showSlackConnectScreen();
                })
                .getSlackAuthStatus();
            updateBrowserTitle();
            // [v2.3] 자동 진단 제거 — 🔍 진단 버튼으로만 실행
            // [v0.5] 데스크톱 알림 권한 (조용히 요청)
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                setTimeout(function() { try { Notification.requestPermission(); } catch(e) {} }, 3000);
            }
            // Esc 키로 가장 위 팝업 닫기 + 기타 패널
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Escape') return;
                // 모달/드롭다운 먼저 닫기
                var forwardModal = document.getElementById('slackForwardModal');
                if (forwardModal && forwardModal.classList.contains('visible')) { closeForwardModal(); return; }
                var profileModal = document.getElementById('slackProfileModal');
                if (profileModal && profileModal.classList.contains('visible')) { closeProfileModal(); return; }
                var picker = document.getElementById('emojiPicker');
                if (picker && picker.classList.contains('visible')) { picker.classList.remove('visible'); return; }
                var menu = document.getElementById('msgContextMenu');
                if (menu && menu.classList.contains('visible')) { hideContextMenu(); return; }
                var mention = document.getElementById('mentionDropdown');
                if (mention && mention.classList.contains('visible')) { hideMentionDropdown(); return; }
                // 가장 위 팝업 닫기
                var visible = openSlackPopups.filter(function(p) { return !p.minimized; });
                if (visible.length === 0) return;
                var top = visible[0];
                for (var i = 1; i < visible.length; i++) {
                    var currentZ = parseInt(visible[i].el.style.zIndex || 0);
                    var topZ = parseInt(top.el.style.zIndex || 0);
                    if (currentZ > topZ) top = visible[i];
                }
                closeSlackPopup(top.id);
            });
        } catch(e) {
            console.error('Slack 초기화 오류:', e);
        }
    };

    // [v3.2] DOM 준비 상태에 따라 즉시/지연 실행 — window.onload 의존 제거
    // 진단용 마커 (debugSlackApi에서 확인 가능하도록 전역에 기록)
    window.__slackInitMarker = { registered: true, readyState: document.readyState, ranAt: null, error: null };
    var __slackInitWrapped = function() {
        window.__slackInitMarker.ranAt = new Date().toISOString();
        try { __slackInitFn(); }
        catch(e) { window.__slackInitMarker.error = e && e.message ? e.message : String(e); throw e; }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', __slackInitWrapped);
    } else {
        // 이미 DOM 로드됨 (동적 주입 케이스) → 다음 tick에 실행
        setTimeout(__slackInitWrapped, 0);
    }

    // ============================================================
    // 탭 전환
    // ============================================================
    function switchSlackTab(tab) {
        currentSlackTab = tab;
        var tabs = document.querySelectorAll('.slack-tab');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-tab') === tab) tabs[i].classList.add('active');
            else tabs[i].classList.remove('active');
        }
        renderSlackChatList();
    }

    // ============================================================
    // 검색
    // ============================================================
    function handleSlackSearchInput() {
        var input = document.getElementById('slackSearchInput');
        if (!input) return;
        slackSearchQuery = (input.value || '').trim().toLowerCase();
        renderSlackChatList();
    }

    // ============================================================
    // 현재 탭의 데이터 가져오기
    // ============================================================
    function getCurrentTabData() {
        var src;
        if (currentSlackTab === 'friends') src = dummyFriends;
        else if (currentSlackTab === 'dm') src = dummyDMs;
        else if (currentSlackTab === 'channel') src = dummyChannels;
        else src = dummyCanvases;
        var q = slackSearchQuery;
        // [v3.6.3] 공백 무시 검색 — "김병국"으로 "김 병국" 찾기, 반대도 OK
        var qNoSpace = q ? q.replace(/\s+/g, '') : '';
        function _matchText(text) {
            if (!text) return false;
            var t = text.toLowerCase();
            if (t.indexOf(q) !== -1) return true;
            // 공백 제거 후 비교 (이름에 공백 있는 경우 대응)
            return t.replace(/\s+/g, '').indexOf(qNoSpace) !== -1;
        }
        var filtered = q ? src.filter(function(item) {
            if (_matchText(item.name)) return true;
            if (_matchText(item.preview)) return true;
            if (item.members && Array.isArray(item.members)) {
                for (var i = 0; i < item.members.length; i++) {
                    if (_matchText(item.members[i])) return true;
                }
            }
            if (item.participants && Array.isArray(item.participants)) {
                for (var j = 0; j < item.participants.length; j++) {
                    if (_matchText(item.participants[j])) return true;
                }
            }
            // [v6.7] 채널/캔버스의 멤버 (Slack API에서 받은 캐시)
            if (typeof getChannelMemberNames === 'function') {
                var memNames = getChannelMemberNames(item.id);
                for (var mk = 0; mk < memNames.length; mk++) {
                    if (_matchText(memNames[mk])) return true;
                }
            }
            return false;
        }) : src.slice();
        // [v3.4 #8] 초기 로드 중(첫 배치 전)에는 timeRaw 있는 것만 표시
        //   → 처음부터 최신순 정렬된 상태로 노출, 재정렬/깜빡임 없음
        //   [v3.5.2 fix] DM 탭에만 적용 — 채널/캔버스는 모두 표시
        //     (채널은 최근 메시지 없으면 가려져서 "대화 없음"이 되는 버그)
        if (currentSlackTab === 'dm' && window.__slackInitialPreviewsLoaded === false) {
            filtered = filtered.filter(function(item) {
                return (item.timeRaw || 0) > 0 || (item.unread || 0) > 0;
            });
        }
        // [v2.4] "새 대화 시작하기" 기능 제거
        // 이유: DM 목록에 이미 있는 사람도 "새 대화"로 중복 표시되는 문제
        // 새 대화가 필요하면 Slack 앱에서 시작 → 자동으로 목록에 추가됨
        // [v3.0] 모든 탭 통일: 최근 업데이트 시간순 (안읽음 있으면 맨 위)
        filtered.sort(function(a, b) {
            // 안읽음 메시지가 있으면 우선
            var aUnread = (a.unread || 0) > 0 ? 1 : 0;
            var bUnread = (b.unread || 0) > 0 ? 1 : 0;
            if (aUnread !== bUnread) return bUnread - aUnread;
            // [v4.4] timeRaw 정규화 (sec/ms 자동 감지)
            var aRaw = a.timeRaw || 0; var bRaw = b.timeRaw || 0;
            var aMs = (aRaw < 1e11) ? aRaw * 1000 : aRaw;
            var bMs = (bRaw < 1e11) ? bRaw * 1000 : bRaw;
            return bMs - aMs;
        });
        return filtered;
    }

    // ============================================================
    // 채팅 목록 렌더링
    // ============================================================
    function renderSlackChatList() {
        var list = document.getElementById('slackChatList');
        if (!list) return;
        var items = getCurrentTabData();
        if (items.length === 0) {
            var emptyIcon = currentSlackTab === 'dm' ? '👥' : (currentSlackTab === 'channel' ? '#' : '📋');
            var emptyText = slackSearchQuery ? '검색 결과 없음' : '대화가 없습니다';
            list.innerHTML =
                '<div class="slack-chat-empty">' +
                    '<div class="slack-chat-empty-icon">' + emptyIcon + '</div>' +
                    '<div>' + emptyText + '</div>' +
                '</div>';
            return;
        }
        var html = '';
        items.forEach(function(item) {
            // [v0.3] 그룹 DM이면 겹침 아바타로 표시
            var avatarHtml = '';
            if (currentSlackTab === 'dm' && item.isGroup && item.members) {
                avatarHtml = buildGroupAvatarHtml(item.members);
            } else {
                var avatarClass = '';
                var avatarInner = firstCharOf(item.name);
                var avatarStyle = '';
                if (currentSlackTab === 'channel') {
                    avatarClass = ' channel-icon';
                    avatarInner = '#';
                } else if (currentSlackTab === 'canvas') {
                    avatarClass = ' canvas-icon';
                    avatarInner = '📋';
                } else {
                    avatarStyle = 'background:' + avatarColorFromName(item.name) + ';';
                }
                // [v6.4] DM이면 user 프로필 사진 시도
                var imgUrl = '';
                if (currentSlackTab === 'dm' && !item.isGroup && item.user && typeof getSlackUserImage === 'function') {
                    imgUrl = getSlackUserImage(item.user);
                }
                var onlineDot = (currentSlackTab === 'dm' && item.online)
                    ? '<span class="online-dot"></span>' : '';
                if (imgUrl) {
                    avatarHtml =
                        '<div class="slack-chat-avatar' + avatarClass + '" style="background-image:url(\'' + imgUrl + '\');background-size:cover;background-position:center;color:transparent;">' +
                            onlineDot +
                        '</div>';
                } else {
                    avatarHtml =
                        '<div class="slack-chat-avatar' + avatarClass + '" style="' + avatarStyle + '">' +
                            avatarInner +
                            onlineDot +
                        '</div>';
                }
            }
            var unreadBadge = (item.unread && item.unread > 0)
                ? '<span class="slack-chat-unread">' + item.unread + '</span>' : '';
            var unreadClass = (item.unread && item.unread > 0) ? ' unread' : '';
            var safeName = highlightSearchTerm(escapeHtml(item.name), slackSearchQuery);
            // [v3.7] 미리보기에도 이모지 코드 변환 (:slightly_smiling_face: 등)
            var safePreview = highlightSearchTerm(convertEmojiCodes(escapeHtml(item.preview || '')), slackSearchQuery);
            // [v4.4] 시간 표시: timeRaw가 sec/ms 둘 다 가능 → 정규화 후 포맷
            var displayTime = item.time || '';
            try {
                var rawTs = item.timeRaw || 0;
                if (rawTs > 0) {
                    // sec(10자리) vs ms(13자리) 자동 감지
                    var ms = (rawTs < 1e11) ? rawTs * 1000 : rawTs;
                    var msgDate = new Date(ms);
                    var now = new Date();
                    var sameDay = msgDate.toDateString() === now.toDateString();
                    var yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
                    var isYesterday = msgDate.toDateString() === yesterday.toDateString();
                    var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
                    if (sameDay) {
                        displayTime = pad(msgDate.getHours()) + ':' + pad(msgDate.getMinutes());
                    } else if (isYesterday) {
                        displayTime = '어제';
                    } else {
                        displayTime = (msgDate.getMonth()+1) + '/' + msgDate.getDate();
                    }
                }
            } catch(e) {}
            var safeTime = escapeHtml(displayTime);
            var safeId = String(item.id).replace(/'/g, "\\'");
            html +=
                '<div class="slack-chat-item' + unreadClass + '" onclick="openSlackChatPopup(\'' + currentSlackTab + '\', \'' + safeId + '\')">' +
                    avatarHtml +
                    '<div class="slack-chat-info">' +
                        '<div class="slack-chat-name-row">' +
                            '<div class="slack-chat-name">' + safeName + '</div>' +
                            '<div class="slack-chat-time">' + safeTime + '</div>' +
                        '</div>' +
                        '<div class="slack-chat-preview-row">' +
                            '<div class="slack-chat-preview">' + safePreview + '</div>' +
                            unreadBadge +
                        '</div>' +
                    '</div>' +
                '</div>';
        });
        list.innerHTML = html;
    }

    // [v0.5] 검색 매치 하이라이트
    function highlightSearchTerm(text, query) {
        if (!query || !text) return text;
        try {
            var re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            return text.replace(re, '<span class="search-hl">$1</span>');
        } catch(e) { return text; }
    }

    // [v0.9] 소식 모달
    function openSlackUpdatesModal() {
        var modal = document.getElementById('slackUpdatesModal');
        var list = document.getElementById('slackUpdatesList');
        if (!modal || !list) return;
        if (typeof UPDATE_HISTORY === 'undefined') { showToast('업데이트 이력 없음'); return; }
        var html = '';
        UPDATE_HISTORY.forEach(function(up) {
            html +=
                '<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:15px; margin-bottom:15px;">' +
                    '<div style="font-size:12px; color:#3b82f6; font-weight:bold; margin-bottom:5px;">' + escapeHtml(up.date) + ' (버전: ' + escapeHtml(up.version) + ')</div>' +
                    '<div style="font-size:16px; font-weight:800; color:#1e293b; margin-bottom:10px;">' + escapeHtml(up.title) + '</div>' +
                    '<ul style="margin-left:20px; font-size:14px; color:#475569; line-height:1.6;">' +
                        up.details.map(function(d) { return '<li style="margin-bottom:5px;">' + escapeHtml(d) + '</li>'; }).join('') +
                    '</ul>' +
                '</div>';
        });
        list.innerHTML = html;
        modal.style.display = 'flex';
    }

    // [v0.9] 로딩 중 스켈레톤 표시 (빈 화면 절대 금지! 안되면 춤이라도!)
    function showSlackLoadingSkeleton() {
        var list = document.getElementById('slackChatList');
        if (!list) return;
        var html = '<div class="slack-loading-emoji">💬</div>';
        for (var i = 0; i < 8; i++) {
            html +=
                '<div class="slack-skeleton-item">' +
                    '<div class="skeleton-avatar"></div>' +
                    '<div class="skeleton-lines">' +
                        '<div class="skeleton-line short"></div>' +
                        '<div class="skeleton-line long"></div>' +
                    '</div>' +
                '</div>';
        }
        list.innerHTML = html;
    }

    // [v0.7] 연동 안 된 사용자에게 연동 버튼 표시
    function showSlackConnectScreen() {
        var list = document.getElementById('slackChatList');
        if (!list) return;
        list.innerHTML =
            '<div style="text-align:center; padding:60px 20px;">' +
                '<div style="font-size:48px; margin-bottom:15px;">💬</div>' +
                '<h3 style="color:#1e293b; margin:0 0 8px;">Slack 연동이 필요합니다</h3>' +
                '<p style="color:#64748b; font-size:13px; line-height:1.6; margin-bottom:20px;">' +
                    '버튼 하나만 누르면 바로 연동돼요!<br>본인 Slack 계정으로 "허용"만 클릭하면 끝.' +
                '</p>' +
                '<button onclick="slackConnect()" style="padding:12px 28px; background:#4A154B; color:#fff; border:none; border-radius:10px; font-size:15px; font-weight:800; cursor:pointer; box-shadow:0 4px 14px rgba(74,21,75,0.35);">🔗 Slack 연동하기</button>' +
            '</div>';
        // 배너도 변경
        var banner = document.querySelector('.slack-demo-banner');
        if (banner) {
            banner.innerHTML = '🔗 Slack 연동 후 실제 대화를 확인할 수 있어요';
            banner.style.background = 'linear-gradient(90deg, #fbbf24, #f59e0b)';
        }
    }

    // ============================================================
    // [v0.6] 실제 Slack 데이터 로딩
    // ============================================================
    function loadRealSlackData() {
        // [v0.9] 빈 화면 대신 스켈레톤 유지 (이미 표시됨)
        var banner = document.querySelector('.slack-demo-banner');
        if (banner) {
            banner.innerHTML = '💬 대화 목록 불러오는 중...';
            banner.style.background = 'linear-gradient(90deg, #3b82f6, #60a5fa)';
            banner.style.color = '#ffffff';
        }
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    showToast('Slack 로딩 실패: ' + (res ? res.message : '오류'));
                    if (banner) banner.innerHTML = '⚠ Slack 연결 실패 — 더미 데이터 표시';
                    renderSlackChatList();
                    updateTabCounts();
                    return;
                }
                slackRealMode = true;
                slackUsersMap = res.usersMap || {};
                slackMyUserId = res.myUserId || '';
                dummyDMs = res.dms || [];
                dummyChannels = res.channels || [];
                dummyCanvases = res.canvases || [];
                // [v6.10.22] GAS가 빈 결과 반환 시 Slack API 직접 호출로 fallback
                if (dummyDMs.length === 0 && dummyChannels.length === 0 && typeof window.__slackDirect === 'function') {
                    console.log('[v6.10.22] GAS 빈 응답 → Slack 직접 호출 fallback 시작');
                    (async function() {
                        try {
                            var convRes = await window.__slackDirect('conversations.list', { types: 'public_channel,private_channel,im,mpim', limit: 200, exclude_archived: true });
                            if (!convRes || !convRes.ok) { console.warn('[v6.10.22 fallback] conversations.list 실패', convRes && convRes.error); return; }
                            var convs = convRes.channels || [];
                            console.log('[v6.10.22 fallback] 받은 conversations:', convs.length);
                            // users 가 없으면 직접 가져옴
                            if (Object.keys(slackUsersMap).length < 10) {
                                try {
                                    var ulRes = await window.__slackDirect('users.list', { limit: 200 });
                                    if (ulRes && ulRes.ok && ulRes.members) {
                                        ulRes.members.forEach(function(u) {
                                            if (!u.deleted) {
                                                var rn = u.real_name || (u.profile && u.profile.display_name) || u.name || u.id;
                                                slackUsersMap[u.id] = { name: rn, isBot: u.is_bot || false };
                                            }
                                        });
                                    }
                                } catch(e) {}
                            }
                            var newDMs = [], newChans = [];
                            convs.forEach(function(c) {
                                if (c.is_archived) return;
                                if (c.is_im) {
                                    var u = slackUsersMap[c.user] || {};
                                    newDMs.push({
                                        id: c.id, name: u.name || c.user, user: c.user,
                                        unread: 0, online: false, isGroup: false,
                                        preview: '', time: '', timeRaw: 0
                                    });
                                } else if (c.is_mpim) {
                                    newDMs.push({
                                        id: c.id, name: c.name || '그룹DM',
                                        unread: 0, online: false, isGroup: true,
                                        preview: '', time: '', timeRaw: 0
                                    });
                                } else if (c.is_channel || c.is_group) {
                                    if (!c.is_member) return;
                                    newChans.push({
                                        id: c.id, name: c.name || c.id,
                                        unread: 0, preview: '', time: '', timeRaw: 0
                                    });
                                }
                            });
                            dummyDMs = newDMs;
                            dummyChannels = newChans;
                            console.log('[v6.10.22 fallback] DMs=' + newDMs.length + ' Channels=' + newChans.length);
                            slackMyUserId = slackMyUserId || (await window.__slackDirect('auth.test', {})).user_id || '';
                            try { renderSlackChatList(); updateTabCounts(); updateBrowserTitle(); saveSlackCacheToStorage(); } catch(e) {}
                        } catch(e) { console.warn('[v6.10.22 fallback] 실패', e); }
                    })();
                }
                // [v3.8.3] 초기 로드 실패 (rate limit 등)이면 60초 후 자동 재시도
                if (res.rateLimited || (dummyDMs.length === 0 && dummyChannels.length === 0)) {
                    showToast('⚠️ 일부 데이터가 아직 안 왔어요. 60초 후 자동 재시도...');
                    setTimeout(function() {
                        console.log('[v3.8.3] 초기 로드 재시도');
                        // 서버 캐시 무효화를 위해 clearSlackCache 먼저 호출
                        google.script.run
                            .withSuccessHandler(function() {
                                loadRealSlackData();
                            })
                            .clearSlackCache();
                    }, 60000);
                }
                // [v3.4 fix] dummyMessagesMap은 reset하지 않음 — 이미 로드된 팝업의 메시지를
                //           날려버리는 버그 (자식 창/낙관적 UI가 로드한 메시지 손실) 방지
                if (typeof dummyMessagesMap !== 'object' || dummyMessagesMap === null) {
                    dummyMessagesMap = {};
                }
                // [v3.4] 자식 창이 즉시 이름/메시지 쓸 수 있게 localStorage 공유
                try { saveSlackCacheToStorage(); } catch(e) {}
                if (banner) {
                    banner.innerHTML = '✅ Slack 연결됨 — 실제 데이터';
                    banner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
                    banner.style.color = '#ffffff';
                }
                // [v3.4 #8] 초기 이름 리스트를 즉시 렌더하지 않음 — 깜빡임/재정렬 방지
                // 첫 배치 미리보기 도착할 때까지 스켈레톤 유지
                window.__slackInitialPreviewsLoaded = false;
                showSlackLoadingSkeleton();  // 스켈레톤 유지
                // renderSlackChatList() 호출 생략 — loadPreviewsInBackground의 첫 배치 후에 렌더
                updateTabCounts();
                updateBrowserTitle();
                // [v2.6] 친구 목록 생성 (usersMap에서)
                dummyFriends = [];
                for (var fuid in slackUsersMap) {
                    if (!slackUsersMap.hasOwnProperty(fuid)) continue;
                    var fu = slackUsersMap[fuid];
                    if (fu.isBot) continue;
                    if (fuid === slackMyUserId) continue;
                    dummyFriends.push({
                        id: '__user_' + fuid,
                        userId: fuid,
                        name: fu.name || fuid,
                        preview: '',
                        time: '',
                        timeRaw: 0,
                        unread: 0,
                        online: false,
                        isGroup: false
                    });
                }
                showToast('Slack 연결! 친구 ' + dummyFriends.length + '명, 채팅 ' + dummyDMs.length + '개');
                // [v3.7] 사용 통계 — ping + 위젯 로드
                try { pingAndLoadStats(); } catch(e) {}
                // [v1.2] 연결 해제 버튼 표시
                var dcBtn = document.getElementById('slackDisconnectBtn');
                if (dcBtn) dcBtn.style.display = 'inline-block';
                // [v2.9] usersMap 캐시 (Delta 폴링에서 사용)
                google.script.run.cacheSlackUsersMap(slackMyUserId);
                // [v0.8] 백그라운드에서 미리보기 + 시간 로드 → 정렬
                loadPreviewsInBackground();
                // [v2.9] 스마트 폴링 시작 (포커스 1초 + 나머지 3초)
                startSlackPolling();
                // [v1.2] 캔버스 백그라운드 로드
                loadCanvasesInBackground();
            })
            .withFailureHandler(function(err) {
                showToast('Slack 연결 실패');
                renderSlackChatList();
                updateTabCounts();
            })
            .listSlackChannels();
    }

    function loadRealMessages(popupId, popupEl) {
        // [v4.13] chat-window 모드면 slackRealMode false라도 LS에서 메시지 직접 로드
        var __isChatWin = location.search.indexOf('chatWindow=1') >= 0;
        if (!slackRealMode && !__isChatWin) return;
        // [v3.0 fix] 이미 로드된 메시지가 있으면 스킵 (Delta가 처리)
        if (dummyMessagesMap[popupId] && dummyMessagesMap[popupId].length > 0) return;
        var body = popupEl.querySelector('.slack-popup-body');

        // [v3.4] 낙관적 UI — localStorage 캐시에 메시지 있으면 즉시 표시 (#11)
        var cached = null;
        try { cached = loadSlackMessagesFromStorage(popupId); } catch(e) {}
        if (cached && cached.length > 0) {
            dummyMessagesMap[popupId] = cached;
            renderPopupMessages(popupEl, popupId);
            // 작은 배지로 "최신 확인 중" 표시 (선택)
            if (body) {
                var refreshHint = document.createElement('div');
                refreshHint.id = 'slack-refresh-hint-' + popupId;
                refreshHint.style.cssText = 'position:absolute;top:58px;left:50%;transform:translateX(-50%);background:rgba(59,130,246,0.9);color:white;font-size:11px;padding:3px 10px;border-radius:10px;z-index:5;pointer-events:none;';
                refreshHint.textContent = '최신 확인 중...';
                body.parentNode.appendChild(refreshHint);
                setTimeout(function() { if (refreshHint.parentNode) refreshHint.remove(); }, 2000);
            }
        } else {
            if (body) body.innerHTML = '<div style="color:#475569; text-align:center; padding:30px;">💬 메시지 불러오는 중...</div>';
        }

        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    if (!cached || cached.length === 0) {
                        dummyMessagesMap[popupId] = [];
                        if (body) body.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:30px;">새 대화를 시작해보세요! 💬</div>';
                    }
                    return;
                }
                dummyMessagesMap[popupId] = res.messages || [];
                if (dummyMessagesMap[popupId].length === 0) {
                    if (body) body.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:30px;">새 대화를 시작해보세요! 💬</div>';
                } else {
                    renderPopupMessages(popupEl, popupId);
                    // [v3.4] 새 메시지 캐시에 저장 → 다음 열기 즉시 표시
                    try { saveSlackMessagesToStorage(popupId); } catch(e) {}
                }
            })
            .withFailureHandler(function(err) {
                if (!cached || cached.length === 0) {
                    dummyMessagesMap[popupId] = [];
                    if (body) body.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:30px;">새 대화를 시작해보세요! 💬</div>';
                }
            })
            .getSlackMessages(popupId, 30);
    }

    // ============================================================
    // [v0.8] 백그라운드 미리보기 로드 → 정렬
    // ============================================================
    function loadPreviewsInBackground() {
        if (!slackRealMode) return;
        // [v3.4 #8] 미리보기 로드 우선순위:
        //   1) unread 있는 대화 (가장 최근 활동)
        //   2) 최근 열어본 대화 (localStorage 이력 — 향후)
        //   3) 나머지
        //   → 첫 배치에 "최신 20개"가 들어가서 사용자가 바로 볼 수 있음
        var priorityIds = [];
        var normalIds = [];
        dummyDMs.forEach(function(d) {
            if ((d.unread || 0) > 0) priorityIds.push(d.id);
            else normalIds.push(d.id);
        });
        dummyChannels.forEach(function(c) {
            if ((c.unread || 0) > 0) priorityIds.push(c.id);
            else normalIds.push(c.id);
        });
        var allIds = priorityIds.concat(normalIds);
        if (allIds.length === 0) {
            // 데이터 없을 때 플래그 켜서 빈 목록 표시
            window.__slackInitialPreviewsLoaded = true;
            try { renderSlackChatList(); } catch(e) {}
            return;
        }
        // 20개씩 배치로 나눠서 호출 (서버 부담 분산)
        var batches = [];
        for (var i = 0; i < allIds.length; i += 20) {
            batches.push(allIds.slice(i, i + 20));
        }
        var batchIdx = 0;
        function processBatch() {
            if (batchIdx >= batches.length) {
                // [v3.4 #8] 마지막 배치 끝 → 나머지 (timeRaw=0)도 모두 표시
                window.__slackInitialPreviewsLoaded = true;
                try { renderSlackChatList(); } catch(e) {}
                try { saveSlackCacheToStorage(); } catch(e) {}
                // [v4.5] 미리보기 로드 끝나면 → 상위 채팅 메시지 prefetch (백그라운드)
                try { setTimeout(function(){ if (typeof prefetchTopChats==='function') prefetchTopChats(); }, 800); } catch(e) {}
                return;
            }
            var batch = batches[batchIdx];
            var isFirstBatch = (batchIdx === 0);
            batchIdx++;
            google.script.run
                .withSuccessHandler(function(res) {
                    if (!res || !res.success || !res.results) {
                        setTimeout(processBatch, 500);
                        return;
                    }
                    // [v4.6] 첫 배치 완료 후 5초 대기 후 prefetch (GAS rate 회피)
                    if (isFirstBatch) {
                        try { setTimeout(function(){ if (typeof prefetchTopChats==='function') prefetchTopChats(); }, 5000); } catch(e) {}
                    }
                    // [v4.4] timeRaw 정규화: GAS sec → ms
                    var __normMs = function(v) { v = v || 0; return (v > 0 && v < 1e11) ? v * 1000 : v; };
                    dummyDMs.forEach(function(d) {
                        if (res.results[d.id]) {
                            d.preview = res.results[d.id].preview || d.preview;
                            d.time = res.results[d.id].time || d.time;
                            d.timeRaw = __normMs(res.results[d.id].timeRaw) || d.timeRaw;
                        }
                    });
                    // 채널에 미리보기 반영
                    dummyChannels.forEach(function(c) {
                        if (res.results[c.id]) {
                            c.preview = res.results[c.id].preview || c.preview;
                            c.time = res.results[c.id].time || c.time;
                            c.timeRaw = __normMs(res.results[c.id].timeRaw) || c.timeRaw;
                        }
                    });
                    // UI 갱신 (미리보기 + 정렬 반영)
                    // [v3.4 #8] 첫 배치 도착 시 스켈레톤 숨기고 정렬된 리스트 표시
                    //   (첫 배치가 가장 최근 20개이므로 처음부터 최신순 노출됨)
                    renderSlackChatList();
                    // 다음 배치 (0.5초 뒤)
                    setTimeout(processBatch, 500);
                })
                .withFailureHandler(function() {
                    setTimeout(processBatch, 500);
                })
                .getLastMessagesBatch(JSON.stringify(batch));
        }
        // [v3.4 #8] 바로 시작 (이전엔 1초 대기였는데, 스켈레톤 시간 단축)
        setTimeout(processBatch, 100);
    }

    // [v1.2] 캔버스 백그라운드 로드
    function loadCanvasesInBackground() {
        if (!slackRealMode) return;
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                dummyCanvases = res.canvases || [];
                // 캔버스 탭이 활성이면 갱신
                if (currentSlackTab === 'canvas') renderSlackChatList();
                updateTabCounts();
            })
            .searchSlackCanvases();
    }

    // [v1.2] 캔버스 클릭 시 Slack 웹에서 열기
    function openCanvasInSlack(canvasId) {
        var canvas = dummyCanvases.find(function(c) { return c.id === canvasId; });
        if (canvas && canvas.url) {
            window.open(canvas.url, '_blank');
        } else {
            showToast('캔버스 링크를 찾을 수 없어요');
        }
    }

    // [v0.3] 그룹 아바타 HTML (2~3명 겹침 - 카톡 스타일)
    function buildGroupAvatarHtml(members) {
        if (!members || members.length === 0) return '<div class="slack-chat-avatar">?</div>';
        var show = members.slice(0, 3);
        var inner = '';
        show.forEach(function(name, idx) {
            var color = avatarColorFromName(name);
            var ch = firstCharOf(name);
            inner += '<div class="group-avatar-mini group-avatar-mini-' + idx + '" style="background:' + color + ';">' + ch + '</div>';
        });
        return '<div class="slack-chat-avatar group-avatar">' + inner + '</div>';
    }

    function updateTabCounts() {
        var dmCountEl = document.getElementById('slackTabCountDm');
        var chCountEl = document.getElementById('slackTabCountChannel');
        var cvCountEl = document.getElementById('slackTabCountCanvas');
        var dmUnread = dummyDMs.reduce(function(s, x) { return s + (x.unread || 0); }, 0);
        var chUnread = dummyChannels.reduce(function(s, x) { return s + (x.unread || 0); }, 0);
        var cvUnread = dummyCanvases.reduce(function(s, x) { return s + (x.unread || 0); }, 0);
        if (dmCountEl) { dmCountEl.textContent = dmUnread; dmCountEl.style.display = dmUnread > 0 ? '' : 'none'; }
        if (chCountEl) { chCountEl.textContent = chUnread; chCountEl.style.display = chUnread > 0 ? '' : 'none'; }
        if (cvCountEl) { cvCountEl.textContent = cvUnread; cvCountEl.style.display = cvUnread > 0 ? '' : 'none'; }
    }

    // ============================================================
    // 팝업 관리
    // ============================================================
    function findPopup(id) {
        for (var i = 0; i < openSlackPopups.length; i++) if (openSlackPopups[i].id === id) return openSlackPopups[i];
        return null;
    }

    function openSlackChatPopup(type, id) {
        // [v3.0 fix] 친구 탭 → conversations.open으로 DM 열기
        if (type === 'friends') {
            if (id.indexOf('__user_') === 0) {
                var friendUserId = id.replace('__user_', '');
                // 친구 이름 미리 저장 (팝업 생성 시 사용)
                var friendData = null;
                for (var fi = 0; fi < dummyFriends.length; fi++) {
                    if (dummyFriends[fi].id === id) { friendData = dummyFriends[fi]; break; }
                }
                window._pendingDmName = friendData ? friendData.name : friendUserId;
                showToast('대화방 열고 있어요...');
                google.script.run
                    .withSuccessHandler(function(res) {
                        if (res && res.success && res.channelId) {
                            openSlackChatPopup('dm', res.channelId);
                        } else {
                            window._pendingDmName = null;
                            showToast('대화방 열기 실패');
                        }
                    })
                    .withFailureHandler(function(err) {
                        window._pendingDmName = null;
                        showToast('대화방 열기 실패: ' + err);
                    })
                    .openSlackDm(friendUserId);
            }
            return;
        }
        // [v1.2] 캔버스 → Slack 웹에서 열기 (팝업 아님)
        if (type === 'canvas') {
            openCanvasInSlack(id);
            return;
        }
        // [v3.0 fix] 새 DM → conversations.open 후 팝업 열기
        if (id.indexOf('__user_') === 0) {
            var userId = id.replace('__user_', '');
            var uName = (slackUsersMap[userId] && slackUsersMap[userId].name) || userId;
            window._pendingDmName = uName;
            showToast('대화방 열고 있어요...');
            google.script.run
                .withSuccessHandler(function(res) {
                    if (res && res.success && res.channelId) {
                        openSlackChatPopup('dm', res.channelId);
                    } else {
                        window._pendingDmName = null;
                        showToast('대화방 열기 실패');
                    }
                })
                .withFailureHandler(function(err) {
                    window._pendingDmName = null;
                    showToast('대화방 열기 실패: ' + err);
                })
                .openSlackDm(userId);
            return;
        }
        var existing = findPopup(id);
        if (existing) {
            existing.minimized = false;
            existing.el.classList.remove('minimized');
            existing.el.style.zIndex = (++nextSlackPopupZ);
            renderDock();
            return;
        }
        if (openSlackPopups.length >= MAX_SLACK_POPUPS) {
            showToast('팝업은 최대 ' + MAX_SLACK_POPUPS + '개까지 열 수 있어요');
            return;
        }
        var data = getChatMetaById(type, id);
        // [v3.0 fix] dummyDMs에 없으면 새로 생성! (친구탭에서 새 대화 시작 시)
        if (!data) {
            var friendName = id;
            // usersMap에서 이름 찾기 (conversations.open이 반환한 channelId로)
            for (var uid in slackUsersMap) {
                if (!slackUsersMap.hasOwnProperty(uid)) continue;
                // DM 채널 목록에서 이 channelId가 있는지 확인 안 되니 friendName은 유지
            }
            // openSlackDm 호출 전에 저장한 이름 사용
            if (window._pendingDmName) {
                friendName = window._pendingDmName;
                window._pendingDmName = null;
            }
            data = {
                id: id, name: friendName,
                unread: 0, online: false, isGroup: false,
                preview: '', time: '', timeRaw: Date.now()
            };
            dummyDMs.push(data);
        }
        // 읽음 처리 (로컬 unread도 리셋)
        data.unread = 0;
        data.unreadLocal = 0;
        // [v3.8.3] Slack 서버에도 "읽음" 알림
        try {
            var latestMsgTs = '';
            var cached = dummyMessagesMap[id];
            if (cached && cached.length > 0) latestMsgTs = cached[cached.length - 1].ts || '';
            if (!latestMsgTs) latestMsgTs = (Date.now() / 1000).toFixed(6);
            google.script.run
                .withSuccessHandler(function() {
                    if (typeof slackLastUnreadMap === 'object' && slackLastUnreadMap[id]) {
                        slackLastUnreadMap[id].unread = 0;
                    }
                })
                .withFailureHandler(function() {})
                .markSlackRead(id, latestMsgTs);
        } catch(markErr) {}
        // [v4.3 Tauri] 별도 채팅 창에서 클릭한 경우 → 메인 창으로 즉시 알림 (배지 즉시 사라짐)
        try {
            var T = window.__TAURI__;
            if (T && T.event && T.event.emit) {
                T.event.emit('chat-opened', { id: id, type: type });
            }
        } catch(e) {}
        renderSlackChatList();
        updateTabCounts();

        // [v3.4] PWA/좁은 화면 감지 (먼저 판정해서 분기 처리)
        var __isPWA = false;
        try {
            __isPWA = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                      (window.matchMedia && window.matchMedia('(display-mode: window-controls-overlay)').matches) ||
                      (window.navigator && window.navigator.standalone === true);
        } catch(e) {}
        // [v3.6 fix] 데스크톱은 좁아도 풀스크린 안 함 (카톡 PC처럼 별도 창 우선)
        //   진짜 모바일(터치 기기)일 때만 인앱 풀스크린
        var __ua = navigator.userAgent || '';
        var __isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/.test(__ua) &&
                               (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
        var __narrowViewport = __isMobileDevice && window.innerWidth < 768;

        // [v3.4] PWA/풀스크린 모드: 한 번에 한 대화만 표시 (카톡 모바일 스타일)
        // 새 대화 열기 전에 기존 풀스크린 팝업 모두 close — "기존 창 변경" 버그 해결
        var __isTauriApp = (typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_INTERNALS__ !== 'undefined');
        if (__isPWA || __narrowViewport) {
            var toClose = openSlackPopups.filter(function(p) {
                return p.id !== id;
            }).map(function(p) { return p.id; });
            toClose.forEach(function(pid) { try { closeSlackPopup(pid); } catch(e) {} });
        }

        // 팝업 DOM 생성
        var popupEl = buildPopupDom(type, id, data);
        document.getElementById('slackPopupContainer').appendChild(popupEl);
        var __isTauriApp = (typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_INTERNALS__ !== 'undefined');
        if (__isPWA || __narrowViewport) {
            // [v3.3] 전체화면 — CSS가 inline을 덮어쓸 수 있으므로 !important 강제
            popupEl.style.setProperty('position', 'fixed', 'important');
            popupEl.style.setProperty('left', '0', 'important');
            popupEl.style.setProperty('top', '0', 'important');
            popupEl.style.setProperty('right', '0', 'important');
            popupEl.style.setProperty('bottom', '0', 'important');
            popupEl.style.setProperty('width', '100vw', 'important');
            popupEl.style.setProperty('height', '100vh', 'important');
            popupEl.style.setProperty('max-width', 'none', 'important');
            popupEl.style.setProperty('max-height', 'none', 'important');
            popupEl.style.setProperty('border-radius', '0', 'important');
            popupEl.style.setProperty('transform', 'none', 'important');
            popupEl.classList.add('slack-popup-fullscreen');
            // [v3.4] 풀스크린 모드 — 뒤로가기/닫기 + 진단을 헤더 안에 인라인 삽입
            //   (기존 absolute 배치는 이름을 가리는 버그가 있었음)
            var __isChildWin = false;
            try { __isChildWin = !!(new URLSearchParams(window.location.search)).get('chat'); } catch(e) {}
            var headerEl = popupEl.querySelector('.slack-popup-header');
            if (headerEl && !headerEl.querySelector('.slack-popup-back-btn')) {
                var backBtn = document.createElement('button');
                backBtn.className = 'slack-popup-back-btn';
                backBtn.innerHTML = __isChildWin ? '✕' : '←';
                backBtn.title = __isChildWin ? '창 닫기' : '대화 목록으로';
                backBtn.style.cssText = 'width:32px;height:32px;padding:0;margin-right:6px;background:rgba(255,255,255,0.9);border:1px solid #e2e8f0;border-radius:50%;font-size:15px;font-weight:800;color:#1e293b;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;';
                backBtn.addEventListener('click', function(ev) {
                    ev.stopPropagation();
                    if (__isChildWin) {
                        try { window.close(); } catch(e) { closeSlackPopup(id); }
                    } else {
                        closeSlackPopup(id);
                    }
                });
                // 맨 앞에 삽입 (아바타보다 앞)
                headerEl.insertBefore(backBtn, headerEl.firstChild);
            }
            // 진단 버튼도 헤더에 인라인 (기존 고정 위치 버튼들 앞에)
            if (headerEl && !headerEl.querySelector('.slack-popup-diag-btn')) {
                var diagBtn = document.createElement('button');
                diagBtn.className = 'slack-popup-diag-btn';
                diagBtn.innerHTML = '🔍';
                diagBtn.title = '진단 (Slack 상태 점검)';
                diagBtn.style.cssText = 'width:32px;height:32px;padding:0;margin-left:2px;background:rgba(254,224,71,0.9);border:1px solid #e2e8f0;border-radius:50%;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;';
                diagBtn.addEventListener('click', function(ev) {
                    ev.stopPropagation();
                    if (typeof runSlackDiagnostics === 'function') runSlackDiagnostics();
                });
                // 기존 헤더 버튼들(🔗 🔲 ─ ✕) 앞에 삽입
                var firstHdrBtn = headerEl.querySelector('.slack-popup-header-btn');
                if (firstHdrBtn) {
                    headerEl.insertBefore(diagBtn, firstHdrBtn);
                } else {
                    headerEl.appendChild(diagBtn);
                }
            }
        } else {
            // [v0.5] 데스크톱 일반 브라우저: 오른쪽에서 열림
            var offset = openSlackPopups.length * 32;
            var rightPos = window.innerWidth - 360 - 40 - offset;
            if (rightPos < 560) rightPos = 560;
            popupEl.style.left = rightPos + 'px';
            popupEl.style.top = (90 + (openSlackPopups.length * 32)) + 'px';
        }
        popupEl.style.zIndex = (++nextSlackPopupZ);
        var popupState = {
            id: id, type: type, name: data.name, data: data,
            minimized: false, el: popupEl
        };
        openSlackPopups.push(popupState);
        makeSlackPopupDraggable(popupEl, id);
        setupPopupDragDrop(popupEl, id);
        // [v1.0] 클립보드 이미지 붙여넣기 감지
        setupPasteHandler(popupEl, id);
        // [v2.9] 포커스 추적 — 팝업 클릭 시 이 팝업이 "대화 중"
        popupEl.addEventListener('mousedown', function() { setFocusedPopup(id); });
        popupEl.addEventListener('focusin', function() { setFocusedPopup(id); });
        setFocusedPopup(id); // 열 때 바로 포커스
        // [v0.6] 실제 모드면 메시지 서버에서 로딩
        if (slackRealMode) {
            loadRealMessages(id, popupEl);
        }
        setTimeout(function() {
            var input = popupEl.querySelector('.slack-popup-input');
            if (input) input.focus();
            var body = popupEl.querySelector('.slack-popup-body');
            if (body) body.scrollTop = body.scrollHeight;
        }, 50);
        renderDock();
    }

    function getChatMetaById(type, id) {
        var src;
        if (type === 'dm') src = dummyDMs;
        else if (type === 'channel') src = dummyChannels;
        else src = dummyCanvases;
        for (var i = 0; i < src.length; i++) if (src[i].id === id) return src[i];
        return null;
    }

    function buildPopupDom(type, id, data) {
        var el = document.createElement('div');
        el.className = 'slack-popup';
        el.setAttribute('data-id', id);
        // [v0.3] 팝업 헤더 아바타 - 그룹 DM이면 겹침 아바타
        var headerAvatarHtml;
        var titlePrefix = '';
        if (type === 'dm' && data.isGroup && data.members) {
            headerAvatarHtml = buildGroupAvatarHtml(data.members).replace(
                /class="slack-chat-avatar group-avatar"/,
                'class="slack-popup-header-avatar group-avatar"'
            );
        } else {
            var avatarClass = '';
            var avatarInner = firstCharOf(data.name);
            var avatarStyle = '';
            if (type === 'channel') {
                avatarClass = ' channel-icon';
                avatarInner = '#';
                titlePrefix = '# ';
            } else if (type === 'canvas') {
                avatarClass = ' canvas-icon';
                avatarInner = '📋';
                titlePrefix = '📋 ';
            } else {
                avatarStyle = 'background:' + avatarColorFromName(data.name) + ';';
            }
            headerAvatarHtml =
                '<div class="slack-popup-header-avatar' + avatarClass + '" style="' + avatarStyle + '">' + avatarInner + '</div>';
        }
        var safeId = String(id).replace(/'/g, "\\'");
        var safeName = escapeHtml(data.name);
        // 그룹이면 "👥 (3명)" 부가 정보 헤더에 넣기
        var groupCount = '';
        if (type === 'dm' && data.isGroup && data.members) {
            groupCount = ' <span style="font-size:11px; font-weight:600; color:#475569; margin-left:4px;">(' + data.members.length + '명)</span>';
        }
        // [v3.4] 대화 종류 라벨 — 어떤 대화인지 명확히 (사용자 요청)
        var typeLabel = '';
        var typeIcon = '';
        if (type === 'channel') { typeIcon = '#'; typeLabel = '채널'; }
        else if (type === 'canvas') { typeIcon = '📋'; typeLabel = '캔버스'; }
        else if (type === 'dm' && data.isGroup) { typeIcon = '👥'; typeLabel = '그룹 대화'; }
        else { typeIcon = '👤'; typeLabel = 'DM'; }
        var typeBadge = '<span style="font-size:10px; font-weight:700; color:#64748b; background:#f1f5f9; padding:2px 6px; border-radius:6px; margin-left:6px; vertical-align:middle;">' + typeIcon + ' ' + typeLabel + '</span>';
        el.innerHTML =
            '<div class="slack-popup-header" id="slack-popup-hdr-' + id + '">' +
                headerAvatarHtml +
                '<div class="slack-popup-header-title">' + titlePrefix + safeName + groupCount + typeBadge + '</div>' +
                '<button class="slack-popup-header-btn" onclick="togglePopupSearch(\'' + safeId + '\')" title="메시지 검색 (Ctrl+F)">🔍</button>' +
                '<button class="slack-popup-header-btn" data-mute-id="' + safeId + '" onclick="toggleChannelMute(\'' + safeId + '\')" title="' + (isChannelMuted(id) ? '알림 켜기' : '알림 끄기') + '">' + (isChannelMuted(id) ? '🔕' : '🔔') + '</button>' +
                '<button class="slack-popup-header-btn" onclick="openInSlackApp(\'' + safeId + '\')" title="Slack 앱에서 열기">🔗</button>' +
                '<button class="slack-popup-header-btn" onclick="toggleMaximizePopup(\'' + safeId + '\')" title="크기 조절">🔲</button>' +
                '<button class="slack-popup-header-btn" onclick="minimizeSlackPopup(\'' + safeId + '\')" title="최소화">─</button>' +
                '<button class="slack-popup-header-btn" onclick="closeSlackPopup(\'' + safeId + '\')" title="닫기">✕</button>' +
            '</div>' +
            '<div class="slack-popup-body" id="slack-popup-body-' + id + '"></div>' +
            // [v1.0] 이미지 붙여넣기 프리뷰
            '<div class="slack-paste-preview" id="slack-paste-preview-' + id + '">' +
                '<img id="slack-paste-img-' + id + '" src="" alt="붙여넣기">' +
                '<div class="slack-paste-preview-info">캡처 이미지</div>' +
                '<button class="slack-paste-send" onclick="sendPastedImage(\'' + safeId + '\')">전송</button>' +
                '<button class="slack-paste-cancel" onclick="cancelPaste(\'' + safeId + '\')">취소</button>' +
            '</div>' +
            // [v0.4] 답장 미리보기 바 (답장 시작 시 표시)
            '<div class="slack-reply-preview" id="slack-reply-preview-' + id + '" style="display:none;">' +
                '<div class="slack-reply-preview-info">' +
                    '<div class="slack-reply-preview-from" id="slack-reply-preview-from-' + id + '"></div>' +
                    '<div class="slack-reply-preview-text" id="slack-reply-preview-text-' + id + '"></div>' +
                '</div>' +
                '<button class="slack-reply-cancel" onclick="cancelReply(\'' + safeId + '\')">✕</button>' +
            '</div>' +
            // [v0.4] 업로드 진행 바
            '<div class="slack-upload-progress" id="slack-upload-progress-' + id + '">' +
                '<span id="slack-upload-label-' + id + '">업로드 중...</span>' +
                '<div class="slack-upload-progress-bar"><div class="slack-upload-progress-fill" id="slack-upload-fill-' + id + '"></div></div>' +
            '</div>' +
            '<div class="slack-popup-input-area">' +
                // [v0.4] 파일 첨부 버튼
                '<button class="slack-popup-attach-btn" onclick="triggerFilePicker(\'' + safeId + '\')" title="파일 첨부">📎</button>' +
                '<input type="file" id="slack-file-input-' + id + '" style="display:none;" multiple onchange="handleFilePick(event, \'' + safeId + '\')">' +
                '<textarea class="slack-popup-input" rows="1" placeholder="메시지 입력..." onkeydown="handleSlackPopupInputKey(event, \'' + safeId + '\')"></textarea>' +
                '<button class="slack-popup-send" onclick="sendSlackPopupMessage(\'' + safeId + '\')">전송</button>' +
            '</div>';
        renderPopupMessages(el, id);
        el.addEventListener('mousedown', function() {
            el.style.zIndex = (++nextSlackPopupZ);
        });
        return el;
    }

    function renderPopupMessages(popupEl, id) {
        var body = popupEl.querySelector('.slack-popup-body');
        if (!body) return;
        var msgs = dummyMessagesMap[id] || [];
        if (msgs.length === 0) {
            body.innerHTML = '<div style="color:#475569; text-align:center; padding:30px; font-size:12px;">메시지를 입력해 대화를 시작해보세요.</div>';
            return;
        }
        // [v0.3] 그룹 채팅(그룹 DM/채널/캔버스)인지 판단 → 모든 말풍선에 이름 표시
        var p = findPopup(id);
        var isGroupChat = false;
        if (p) {
            if (p.type === 'channel' || p.type === 'canvas') isGroupChat = true;
            else if (p.type === 'dm' && p.data && p.data.isGroup) isGroupChat = true;
        }
        var html = '';
        var lastDate = null;
        msgs.forEach(function(m) {
            // [v0.5] 날짜 구분선
            var msgDate = m.ts ? new Date(parseFloat(m.ts) * 1000) : null;
            var dateKey = msgDate ? (msgDate.getFullYear() + '-' + msgDate.getMonth() + '-' + msgDate.getDate()) : null;
            if (dateKey && dateKey !== lastDate) {
                lastDate = dateKey;
                html += '<div class="msg-date-sep"><span>' + formatDateSep(msgDate) + '</span></div>';
            }
            // 삭제된 메시지
            if (m.deleted) {
                html +=
                    '<div class="msg-bubble-row' + (m.mine ? ' mine' : '') + '" data-msg-id="' + escapeHtml(m.id || '') + '">' +
                        '<div class="msg-avatar" style="background:#cbd5e1;">?</div>' +
                        '<div class="msg-bubble-col">' +
                            '<div class="msg-bubble-wrap">' +
                                '<div class="msg-bubble msg-deleted">삭제된 메시지입니다</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
                return;
            }
            var mineClass = m.mine ? ' mine' : '';
            var avatarStyle = 'background:' + avatarColorFromName(m.from || '?') + ';';
            var safeFrom = escapeHtml(m.from || '');
            // [v3.7] 이모지 코드(:grin: 등) → 유니코드 변환 + 멘션 하이라이트
            var safeText = highlightMentions(convertEmojiCodes(escapeHtml(m.text || '')));
            var safeTime = escapeHtml(m.time || '');
            var msgId = escapeHtml(m.id || '');
            var senderName = (!m.mine && (isGroupChat || !p)) ? '<div class="msg-sender-name">' + safeFrom + '</div>' : '';
            // 인용 박스
            var quoteBox = '';
            if (m.replyTo) {
                var qFrom = escapeHtml(m.replyTo.from || '');
                var qText = escapeHtml((m.replyTo.text || '').substring(0, 60));
                var qId = escapeHtml(m.replyTo.id || '');
                quoteBox =
                    '<div class="msg-quote-box" onclick="scrollToMessage(\'' + id + '\', \'' + qId + '\')">' +
                        '<div class="msg-quote-from">' + qFrom + '</div>' +
                        '<div class="msg-quote-text">' + qText + '</div>' +
                    '</div>';
            }
            // 수정됨 마커
            var editedMark = m.edited ? ' <span class="msg-edited">(수정됨)</span>' : '';
            // 말풍선 내용
            var bubbleContent;
            // [v3.7] Slack API가 반환한 files 배열 처리 — 이미지는 인라인 표시
            var slackFilesHtml = '';
            if (m.files && m.files.length > 0) {
                slackFilesHtml = m.files.map(function(f) {
                    return renderSlackFile(f, id, msgId);
                }).join('');
            }
            if (m.file) {
                // 클라이언트 생성 파일(업로드) — 기존 로직
                bubbleContent = renderFileBubble(m.file);
            } else if (slackFilesHtml) {
                // Slack 서버 파일 (이미지 등)
                var textHtml = safeText ? (quoteBox + safeText + editedMark) : '';
                var bubbleOpen = textHtml ? '<div class="msg-bubble">' + textHtml + '</div>' : '';
                bubbleContent = bubbleOpen + slackFilesHtml;
            } else {
                bubbleContent = '<div class="msg-bubble">' + quoteBox + safeText + editedMark + '</div>';
            }
            // [v0.5] 리액션
            var reactionsHtml = '';
            if (m.reactions && m.reactions.length > 0) {
                reactionsHtml = '<div class="msg-reactions">';
                m.reactions.forEach(function(r) {
                    var isMine = r.users && r.users.indexOf(myUserName) !== -1;
                    // [v3.7] 리액션 이모지 코드 변환
                    var displayEmoji = convertEmojiCodes(r.emoji || '');
                    reactionsHtml +=
                        '<div class="msg-reaction' + (isMine ? ' mine' : '') + '" onclick="toggleReaction(\'' + id + '\', \'' + msgId + '\', \'' + r.emoji + '\')">' +
                            '<span class="msg-reaction-emoji">' + displayEmoji + '</span>' +
                            '<span class="msg-reaction-count">' + (r.users ? r.users.length : 0) + '</span>' +
                        '</div>';
                });
                reactionsHtml += '</div>';
            }
            // 읽음 표시 (내 메시지만)
            var readStatus = '';
            if (m.mine) {
                readStatus = '<span class="msg-read-status' + (m.read ? ' read' : '') + '">' + (m.read ? '읽음' : '1') + '</span>';
            }
            // 액션 버튼들 (호버 시 표시): 답장, 리액션, 더보기
            var textForReply = (m.text || (m.file ? '[파일]' : '')).substring(0, 60).replace(/'/g, '&apos;').replace(/"/g, '&quot;').replace(/\n/g, ' ');
            var replyBtn = '<button class="msg-reply-btn" onclick="event.stopPropagation(); startReply(\'' + id + '\', \'' + msgId + '\', \'' + safeFrom.replace(/'/g, '&apos;') + '\', \'' + textForReply + '\')">↩ 답장</button>';
            var reactionBtn = '<button class="msg-action-btn reaction-btn" onclick="event.stopPropagation(); openEmojiPicker(event, function(emoji) { toggleReaction(\'' + id + '\', \'' + msgId + '\', emoji); })">😀</button>';
            var moreBtn = '<button class="msg-action-btn more-btn" onclick="event.stopPropagation(); openMessageContextMenu(event, \'' + id + '\', \'' + msgId + '\')">⋯</button>';
            // 아바타 클릭 시 프로필 표시 (타인만)
            var avatarHtml = m.mine
                ? '<div class="msg-avatar" style="' + avatarStyle + '">' + firstCharOf(m.from) + '</div>'
                : '<div class="msg-avatar" style="' + avatarStyle + '; cursor:pointer;" onclick="event.stopPropagation(); showProfileModal(\'' + safeFrom.replace(/'/g, '&apos;') + '\')">' + firstCharOf(m.from) + '</div>';
            // [v3.0] 스레드 답글 표시
            var threadHtml = '';
            if (m.thread && m.thread.replyCount > 0) {
                var threadClass = m.thread.subscribed ? 'msg-thread-bar subscribed' : 'msg-thread-bar';
                var threadIcon = m.thread.subscribed ? '🔴' : '💬';
                var threadLabel = m.thread.subscribed
                    ? threadIcon + ' ' + m.thread.replyCount + '개의 새 답글'
                    : threadIcon + ' ' + m.thread.replyCount + '개의 답글';
                var threadUsers = m.thread.replyUsers ? m.thread.replyUsers.slice(0, 3).join(', ') : '';
                var safeTs = String(m.ts || '').replace(/'/g, '');
                threadHtml =
                    '<div class="' + threadClass + '" onclick="event.stopPropagation(); loadThreadReplies(\'' + id + '\', \'' + safeTs + '\', this)">' +
                        '<span class="msg-thread-label">' + threadLabel + '</span>' +
                        (threadUsers ? '<span class="msg-thread-users">' + escapeHtml(threadUsers) + '</span>' : '') +
                    '</div>' +
                    '<div class="msg-thread-replies" id="thread-' + safeTs.replace('.', '-') + '" style="display:none;"></div>';
            }
            html +=
                '<div class="msg-bubble-row' + mineClass + '" data-msg-id="' + msgId + '">' +
                    replyBtn +
                    reactionBtn +
                    moreBtn +
                    avatarHtml +
                    '<div class="msg-bubble-col">' +
                        senderName +
                        '<div class="msg-bubble-wrap">' +
                            '<div class="msg-time">' + readStatus + safeTime + '</div>' +
                            bubbleContent +
                        '</div>' +
                        reactionsHtml +
                        threadHtml +
                    '</div>' +
                '</div>';
        });
        // [v3.0] 내 스레드 알림 바 (맨 위)
        var threadAlertHtml = '';
        var subscribedThreads = msgs.filter(function(m) { return m.thread && m.thread.subscribed; });
        if (subscribedThreads.length > 0) {
            threadAlertHtml =
                '<div class="msg-thread-alert">' +
                    '⚡ 내 스레드에 새 답글 ' + subscribedThreads.length + '건 ' +
                    '<span class="msg-thread-alert-btn" onclick="scrollToFirstThread(\'' + id + '\')">바로가기</span>' +
                '</div>';
        }
        body.innerHTML = threadAlertHtml + html;
        // [v3.8.4] 스크롤 맨 아래 강제 — 3단계 전략
        var doScroll = function() {
            // 방법 1: scrollTop = scrollHeight (기본)
            body.scrollTop = body.scrollHeight;
            // 방법 2: 마지막 메시지를 scrollIntoView (가장 확실)
            var lastMsg = body.querySelector('.msg-row:last-child, .msg-day-sep:last-child, .chat-msg:last-child');
            if (lastMsg && typeof lastMsg.scrollIntoView === 'function') {
                try { lastMsg.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch(e) {}
            }
        };
        // 즉시
        doScroll();
        // RAF 후
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function() { doScroll(); });
        }
        // 비동기 리소스 로드 보정
        setTimeout(doScroll, 50);
        setTimeout(doScroll, 200);
        setTimeout(doScroll, 600);
        // 이미지 로드 시 재보정 (가장 중요 — 이미지가 뒤늦게 와서 레이아웃 밀림)
        var imgs = body.querySelectorAll('img');
        imgs.forEach(function(img) {
            img.addEventListener('load', doScroll, { once: true });
            img.addEventListener('error', doScroll, { once: true });
        });
    }

    // [v0.5] 날짜 구분선 포맷
    function formatDateSep(d) {
        if (!d) return '';
        var now = new Date();
        var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var diff = Math.round((today - target) / (1000 * 60 * 60 * 24));
        if (diff === 0) return '오늘';
        if (diff === 1) return '어제';
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1); if (m.length < 2) m = '0' + m;
        var dd = String(d.getDate()); if (dd.length < 2) dd = '0' + dd;
        var days = ['일','월','화','수','목','금','토'];
        return y + '년 ' + m + '월 ' + dd + '일 (' + days[d.getDay()] + ')';
    }

    // [v0.5] 텍스트 내 @멘션을 하이라이트로 표시
    function highlightMentions(text) {
        if (!text) return '';
        return text.replace(/@(\S+)/g, '<span class="mention-inline">@$1</span>');
    }

    // [v3.7] Slack 이모지 shortcode → 유니코드 매핑 (자주 쓰는 것들)
    var EMOJI_MAP = {
        // 기본
        'smile':'😄','grin':'😁','joy':'😂','laughing':'😆','sweat_smile':'😅',
        'rofl':'🤣','slightly_smiling_face':'🙂','upside_down_face':'🙃','wink':'😉','blush':'😊',
        'innocent':'😇','heart_eyes':'😍','star_struck':'🤩','kissing_heart':'😘','kissing_smiling_eyes':'😙',
        'yum':'😋','stuck_out_tongue':'😛','stuck_out_tongue_winking_eye':'😜','money_mouth_face':'🤑','hugging_face':'🤗',
        'thinking_face':'🤔','shushing_face':'🤫','face_with_raised_eyebrow':'🤨','neutral_face':'😐','expressionless':'😑',
        'no_mouth':'😶','smirk':'😏','unamused':'😒','relieved':'😌','pensive':'😔',
        'sleepy':'😪','drooling_face':'🤤','sleeping':'😴','mask':'😷','face_with_thermometer':'🤒',
        'face_with_head_bandage':'🤕','nauseated_face':'🤢','sneezing_face':'🤧','dizzy_face':'😵','cowboy':'🤠',
        'partying_face':'🥳','sunglasses':'😎','face_with_monocle':'🧐','confused':'😕','worried':'😟',
        'slightly_frowning_face':'🙁','frowning2':'☹️','open_mouth':'😮','hushed':'😯','astonished':'😲',
        'flushed':'😳','fearful':'😨','cold_sweat':'😰','cry':'😢','sob':'😭',
        'scream':'😱','confounded':'😖','persevere':'😣','disappointed':'😞','sweat':'😓',
        'weary':'😩','tired_face':'😫','angry':'😠','rage':'😡','pouting_face':'😡',
        // 제스처
        '+1':'👍','thumbsup':'👍','-1':'👎','thumbsdown':'👎','ok_hand':'👌','v':'✌️',
        'crossed_fingers':'🤞','call_me_hand':'🤙','raised_back_of_hand':'🤚','raised_hand':'✋','vulcan_salute':'🖖',
        'point_left':'👈','point_right':'👉','point_up_2':'👆','point_down':'👇','point_up':'☝️',
        'fu':'🖕','wave':'👋','hand_splayed':'🖐','muscle':'💪','pray':'🙏',
        'handshake':'🤝','clap':'👏','raised_hands':'🙌','open_hands':'👐',
        // 하트/상징
        'heart':'❤️','orange_heart':'🧡','yellow_heart':'💛','green_heart':'💚','blue_heart':'💙',
        'purple_heart':'💜','black_heart':'🖤','broken_heart':'💔','two_hearts':'💕','sparkling_heart':'💖',
        'heartbeat':'💓','heartpulse':'💗','cupid':'💘','gift_heart':'💝','revolving_hearts':'💞',
        'heart_decoration':'💟','peace':'☮️','cross':'✝️','star_of_david':'✡️','om':'🕉️',
        // 축하/자주쓰는
        'tada':'🎉','confetti_ball':'🎊','balloon':'🎈','gift':'🎁','birthday':'🎂',
        'cake':'🍰','champagne':'🍾','clinking_glasses':'🥂','beer':'🍺','beers':'🍻',
        'coffee':'☕','tea':'🍵','fire':'🔥','sparkles':'✨','star':'⭐',
        'star2':'🌟','100':'💯','boom':'💥','zap':'⚡','warning':'⚠️',
        'white_check_mark':'✅','ballot_box_with_check':'☑️','heavy_check_mark':'✔️','x':'❌','negative_squared_cross_mark':'❎',
        'question':'❓','exclamation':'❗','grey_question':'❔','grey_exclamation':'❕','bangbang':'‼️',
        'interrobang':'⁉️','radio_button':'🔘','white_circle':'⚪','black_circle':'⚫','red_circle':'🔴',
        'large_blue_circle':'🔵','large_orange_diamond':'🔶','large_blue_diamond':'🔷','small_orange_diamond':'🔸','small_blue_diamond':'🔹',
        // 자주 쓰는 추가
        'rocket':'🚀','airplane':'✈️','car':'🚗','bus':'🚌','taxi':'🚕',
        'ship':'🚢','anchor':'⚓','house':'🏠','office':'🏢','school':'🏫',
        'hospital':'🏥','bank':'🏦','sun':'☀️','cloud':'☁️','rainbow':'🌈',
        'snowflake':'❄️','umbrella':'☂️','moon':'🌙','earth_asia':'🌏','dart':'🎯',
        'trophy':'🏆','medal':'🏅','first_place':'🥇','second_place':'🥈','third_place':'🥉',
        'eyes':'👀','zzz':'💤','speech_balloon':'💬','thought_balloon':'💭','dollar':'💵',
        'moneybag':'💰','credit_card':'💳','email':'📧','phone':'☎️','mobile_phone':'📱',
        'laptop':'💻','computer':'🖥️','printer':'🖨️','keyboard':'⌨️','mouse_three_button':'🖱️',
        'eyes_':'👀','mag':'🔍','bulb':'💡','battery':'🔋','plug':'🔌',
        'lock':'🔒','unlock':'🔓','key':'🔑','hammer':'🔨','wrench':'🔧',
        'calendar':'📅','clipboard':'📋','pushpin':'📌','paperclip':'📎','pencil2':'✏️',
        'pen_ballpoint':'🖊','ballot_box':'🗳','chart_with_upwards_trend':'📈','chart_with_downwards_trend':'📉','bar_chart':'📊',
        'scroll':'📜','bookmark_tabs':'📑','newspaper':'📰','page_facing_up':'📄','page_with_curl':'📃',
        'book':'📖','books':'📚','notebook':'📓','notebook_with_decorative_cover':'📔','ledger':'📒',
        'closed_book':'📕','green_book':'📗','blue_book':'📘','orange_book':'📙','bookmark':'🔖',
        'link':'🔗','wheelchair':'♿','no_entry':'⛔','no_entry_sign':'🚫','skull_crossbones':'☠️',
        'biohazard':'☣️','radioactive':'☢️','recycle':'♻️','fleur_de_lis':'⚜️','trident':'🔱',
        // 한국어 관련 자주
        'kr':'🇰🇷','flag-kr':'🇰🇷','kimchi':'🥬','ramen':'🍜','rice':'🍚',
        'sushi':'🍣','bento':'🍱','bread':'🍞','cheese':'🧀','egg':'🥚',
        // 추가
        'man':'👨','woman':'👩','boy':'👦','girl':'👧','baby':'👶',
        'older_man':'👴','older_woman':'👵','person_with_blond_hair':'👱','man_with_gua_pi_mao':'👲','man_with_turban':'👳',
        'cop':'👮','construction_worker':'👷','guardsman':'💂','spy':'🕵','santa':'🎅'
    };
    function convertEmojiCodes(text) {
        if (!text) return text;
        // :emoji_name: → 이모지 변환
        return text.replace(/:([a-zA-Z0-9_+\-]+):/g, function(match, code) {
            var low = code.toLowerCase();
            return EMOJI_MAP[low] || match; // 매핑 없으면 원본 유지
        });
    }

    // [v3.7] Slack 첨부 파일 렌더링 (이미지는 자동 썸네일, 그 외는 카드)
    function renderSlackFile(file, popupId, msgId) {
        if (!file) return '';
        var safeName = escapeHtml(file.name || '파일');
        var sizeStr = formatFileSize(file.size || 0);
        if (file.isImage && file.thumb360) {
            // 이미지 → 프록시로 비동기 로드
            var imgId = 'slkimg_' + (msgId || '') + '_' + (file.id || Math.random()).toString().replace(/[^a-zA-Z0-9_]/g, '');
            var nameTrim = (safeName || '이미지').substring(0, 28);
            var placeholder = 'data:image/svg+xml;utf8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">' +
                '<rect fill="#f1f5f9" width="240" height="160" rx="8"/>' +
                '<text x="120" y="60" font-size="40" text-anchor="middle">🖼</text>' +
                '<text x="120" y="100" font-size="11" fill="#475569" text-anchor="middle">' + nameTrim + '</text>' +
                '<text x="120" y="125" font-size="10" fill="#94a3b8" text-anchor="middle">클릭해서 보기</text>' +
                '</svg>'
            );
            // 렌더 후 비동기 로드 예약
            setTimeout(function() { loadSlackImageViaProxy(file.thumb360, imgId, file.urlPrivate); }, 50);
            return '<div class="msg-slk-img-wrap">' +
                '<img id="' + imgId + '" class="msg-slk-img" src="' + placeholder + '" alt="' + safeName + '" ' +
                'data-permalink="' + escapeHtml(file.permalink || '') + '" ' +
                'data-url-private="' + escapeHtml(file.urlPrivate || file.thumb720 || '') + '" ' +
                'onclick="openSlackFullImage(\'' + encodeURIComponent(file.permalink || file.urlPrivate || file.thumb720 || '') + '\')" ' +
                'loading="lazy" />' +
                '<div class="msg-slk-img-caption">📷 ' + safeName + ' · ' + sizeStr + '</div>' +
            '</div>';
        }
        // 이미지 아닌 파일 → 카드
        var ext = (file.filetype || '').toLowerCase();
        var iconChar = '📄';
        if (ext === 'pdf') iconChar = '📕';
        else if (ext === 'doc' || ext === 'docx') iconChar = '📘';
        else if (ext === 'xls' || ext === 'xlsx') iconChar = '📗';
        else if (ext === 'ppt' || ext === 'pptx') iconChar = '📙';
        else if (ext === 'zip' || ext === 'rar' || ext === '7z') iconChar = '🗜️';
        var link = file.permalink || file.urlPrivate || '';
        var linkAttr = link ? 'onclick="window.open(\'' + encodeURIComponent(link).replace(/%/g, '%25') + '\', \'_blank\')"' : '';
        return '<div class="msg-slk-file" ' + linkAttr + ' style="cursor:pointer;">' +
            '<div class="msg-slk-file-icon">' + iconChar + '</div>' +
            '<div class="msg-slk-file-info">' +
                '<div class="msg-slk-file-name">' + safeName + '</div>' +
                '<div class="msg-slk-file-size">' + sizeStr + '</div>' +
            '</div>' +
        '</div>';
    }

    // [v3.7] 이미지 프록시 로드 (Slack 인증 URL → base64)
    var __imageLoadCache = {};
    function _gasImage(url, cb) {
        google.script.run
            .withSuccessHandler(function(r) { cb((r && r.success && r.dataUrl) ? r.dataUrl : null); })
            .withFailureHandler(function() { cb(null); })
            .getImageDataUrl(url);
    }
    function loadSlackImageViaProxy(url, imgId, fullUrl) {
        if (!url || !imgId) return;
        var img = document.getElementById(imgId);
        if (!img) return;
        if (__imageLoadCache[url]) { img.src = __imageLoadCache[url]; return; }
        var T = window.__TAURI__;
        // [v6.10.7] Tauri: slack_fetch_image 시도 → 실패 시 GAS로 fallback
        function applyDataUrl(dataUrl) {
            if (!dataUrl) return;
            __imageLoadCache[url] = dataUrl;
            var i = document.getElementById(imgId);
            if (i) i.src = dataUrl;
        }
        if (T && T.core && __slackToken) {
            T.core.invoke('slack_fetch_image', { url: url, token: __slackToken })
                .then(function(dataUrl) {
                    if (dataUrl && dataUrl.indexOf('data:image/') === 0) { applyDataUrl(dataUrl); }
                    else { _gasImage(url, applyDataUrl); }
                })
                .catch(function() { _gasImage(url, applyDataUrl); });
            return;
        }
        _gasImage(url, applyDataUrl);
    }
    window.openSlackFullImage = function(encodedUrl) {
        if (!encodedUrl) return;
        var url = decodeURIComponent(encodedUrl);
        showToast('이미지 로딩 중...');
        var T = window.__TAURI__;
        if (T && T.core && __slackToken) {
            // [v6.10.4] 별창으로 열기 (GAS 우회)
            if (window.openImageInWindow) { window.openImageInWindow(url, '이미지'); return; }
            T.core.invoke('slack_fetch_image', { url: url, token: __slackToken })
                .then(function(dataUrl) { if (dataUrl) openLightbox(encodeURIComponent(dataUrl)); else showToast('이미지 로딩 실패'); })
                .catch(function() { showToast('이미지 로딩 실패'); });
            return;
        }
        google.script.run
            .withSuccessHandler(function(r) {
                if (r && r.success && r.dataUrl) openLightbox(encodeURIComponent(r.dataUrl));
                else showToast('이미지 로딩 실패');
            })
            .withFailureHandler(function() { showToast('이미지 로딩 실패'); })
            .getImageDataUrl(url);
    };

    // [v0.4] 파일 말풍선 렌더
    function renderFileBubble(file) {
        if (!file) return '<div class="msg-bubble">[파일 없음]</div>';
        var sizeStr = formatFileSize(file.size || 0);
        var demoBadge = '<span class="msg-file-demo-badge">🚧 데모</span>';
        if (file.type === 'image') {
            var imgSrc = file.dataUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180"><rect fill="%23e2e8f0" width="240" height="180"/><text x="120" y="90" font-size="14" fill="%2394a3b8" text-anchor="middle" dominant-baseline="central">🖼 ' + escapeHtml(file.name || '') + '</text></svg>';
            return '<div class="msg-bubble" style="padding:6px;">' +
                '<div class="msg-file">' +
                    '<img class="msg-file-image" src="' + imgSrc + '" alt="' + escapeHtml(file.name || '') + '" onclick="openLightbox(\'' + encodeURIComponent(imgSrc) + '\')">' +
                    '<div class="msg-file-info">' +
                        '<div class="msg-file-name">' + escapeHtml(file.name || '') + '</div>' +
                        '<div class="msg-file-size">' + sizeStr + ' ' + demoBadge + '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
        }
        // 문서 파일
        var ext = (file.name || '').split('.').pop().toLowerCase();
        var iconClass = 'file-other';
        var iconChar = '📄';
        if (ext === 'pdf') { iconClass = 'file-pdf'; iconChar = 'PDF'; }
        else if (ext === 'doc' || ext === 'docx') { iconClass = 'file-doc'; iconChar = 'DOC'; }
        else if (ext === 'xls' || ext === 'xlsx') { iconClass = 'file-xls'; iconChar = 'XLS'; }
        else if (ext === 'ppt' || ext === 'pptx') { iconClass = 'file-ppt'; iconChar = 'PPT'; }
        else if (ext === 'zip' || ext === 'rar' || ext === '7z') { iconClass = 'file-zip'; iconChar = 'ZIP'; }
        return '<div class="msg-bubble" style="padding:0;">' +
            '<div class="msg-file-doc" onclick="showToast(\'(데모) 실제 다운로드는 OAuth 연동 후\')">' +
                '<div class="msg-file-icon ' + iconClass + '">' + iconChar + '</div>' +
                '<div class="msg-file-info">' +
                    '<div class="msg-file-name">' + escapeHtml(file.name || '') + '</div>' +
                    '<div class="msg-file-size">' + sizeStr + ' ' + demoBadge + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function formatFileSize(bytes) {
        if (!bytes) return '0B';
        if (bytes < 1024) return bytes + 'B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
        return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    }

    // [v0.4] 이미지 라이트박스
    function openLightbox(encodedSrc) {
        var src = decodeURIComponent(encodedSrc);
        var lb = document.getElementById('slackLightbox');
        if (!lb) {
            lb = document.createElement('div');
            lb.id = 'slackLightbox';
            lb.className = 'slack-lightbox';
            lb.innerHTML = '<img id="slackLightboxImg" src="" alt="" />';
            lb.addEventListener('click', function() { lb.classList.remove('visible'); });
            document.body.appendChild(lb);
        }
        document.getElementById('slackLightboxImg').src = src;
        lb.classList.add('visible');
    }

    // [v0.4] 인용 클릭 → 원본 메시지로 스크롤 + 하이라이트
    function scrollToMessage(popupId, msgId) {
        var p = findPopup(popupId);
        if (!p) return;
        var row = p.el.querySelector('[data-msg-id="' + msgId + '"]');
        if (!row) { showToast('원본 메시지를 찾을 수 없어요'); return; }
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var bubble = row.querySelector('.msg-bubble');
        if (bubble) {
            bubble.classList.add('highlighted');
            setTimeout(function() { bubble.classList.remove('highlighted'); }, 2000);
        }
    }

    // 드래그 가능하게
    function makeSlackPopupDraggable(popupEl, id) {
        var header = popupEl.querySelector('.slack-popup-header');
        if (!header) return;
        var dragging = false, ox = 0, oy = 0;
        header.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            ox = e.clientX - parseInt(popupEl.style.left || 0);
            oy = e.clientY - parseInt(popupEl.style.top || 0);
            popupEl.style.zIndex = (++nextSlackPopupZ);
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            var nx = e.clientX - ox;
            var ny = e.clientY - oy;
            if (nx < 0) nx = 0;
            if (ny < 50) ny = 50;
            if (nx > window.innerWidth - 100) nx = window.innerWidth - 100;
            if (ny > window.innerHeight - 80) ny = window.innerHeight - 80;
            popupEl.style.left = nx + 'px';
            popupEl.style.top = ny + 'px';
        });
        document.addEventListener('mouseup', function() { dragging = false; });
    }

    function minimizeSlackPopup(id) {
        var p = findPopup(id);
        if (!p) return;
        p.minimized = true;
        p.el.classList.add('minimized');
        renderDock();
    }

    function restoreSlackPopup(id) {
        var p = findPopup(id);
        if (!p) return;
        p.minimized = false;
        p.el.classList.remove('minimized');
        p.el.style.zIndex = (++nextSlackPopupZ);
        // [v0.5] 복원하면서 읽음 처리
        popupUnreadMap[id] = 0;
        if (p.data) { p.data.unread = 0; p.data.unreadLocal = 0; }
        renderSlackChatList();
        updateTabCounts();
        updateBrowserTitle();
        renderDock();
        setTimeout(function() {
            var input = p.el.querySelector('.slack-popup-input');
            if (input) input.focus();
        }, 50);
    }

    function closeSlackPopup(id) {
        var p = findPopup(id);
        if (!p) return;
        if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
        openSlackPopups = openSlackPopups.filter(function(x) { return x.id !== id; });
        renderDock();
    }

    function renderDock() {
        var dock = document.getElementById('slackPopupDock');
        if (!dock) return;
        var minimized = openSlackPopups.filter(function(p) { return p.minimized; });
        if (minimized.length === 0) { dock.innerHTML = ''; return; }
        var html = '';
        minimized.forEach(function(p) {
            var prefix = p.type === 'channel' ? '#' : (p.type === 'canvas' ? '📋' : '👤');
            var safeId = String(p.id).replace(/'/g, "\\'");
            var safeName = escapeHtml(p.name);
            // [v0.5] 최소화 상태에서 받은 새 메시지 수
            var unread = popupUnreadMap[p.id] || 0;
            var hasNewClass = unread > 0 ? ' has-new' : '';
            var unreadBadge = unread > 0 ? '<span class="slack-dock-unread">' + unread + '</span>' : '';
            html +=
                '<div class="slack-dock-item' + hasNewClass + '" onclick="restoreSlackPopup(\'' + safeId + '\')">' +
                    '<span>' + prefix + '</span>' +
                    '<span class="dock-title">' + safeName + '</span>' +
                    unreadBadge +
                    '<button class="slack-dock-close" onclick="event.stopPropagation(); closeSlackPopup(\'' + safeId + '\')">✕</button>' +
                '</div>';
        });
        dock.innerHTML = html;
    }

    // ============================================================
    // 메시지 입력/전송
    // ============================================================
    function handleSlackPopupInputKey(e, id) {
        // [v0.5] @멘션 자동완성 체크
        if (e.key === '@' || e.key === 'Backspace' || (e.key.length === 1 && /\S/.test(e.key))) {
            setTimeout(function() {
                var p = findPopup(id);
                if (!p) return;
                var input = p.el.querySelector('.slack-popup-input');
                if (input) checkMentionTrigger(id, input);
            }, 10);
        }
        if (e.key === 'Escape') {
            hideMentionDropdown();
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            if (document.getElementById('mentionDropdown').classList.contains('visible')) {
                // 멘션 드롭다운 열려있으면 첫 항목 선택
                e.preventDefault();
                var firstItem = document.getElementById('mentionDropdown').querySelector('.mention-item');
                if (firstItem) firstItem.click();
                return;
            }
            e.preventDefault();
            sendSlackPopupMessage(id);
        }
    }

    function sendSlackPopupMessage(id) {
        var p = findPopup(id);
        if (!p) return;
        var input = p.el.querySelector('.slack-popup-input');
        if (!input) return;
        var text = (input.value || '').trim();
        if (!text) return;
        // 낙관적 UI - 즉시 메시지 추가
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var newMsgId = 'm_new_' + Date.now();
        var newMsg = { id: newMsgId, from: '나', text: text, time: hh + ':' + mm, mine: true };
        // [v0.4] 답장 상태면 replyTo 포함
        if (p.replyingTo) {
            newMsg.replyTo = {
                id: p.replyingTo.msgId,
                from: p.replyingTo.from,
                text: p.replyingTo.text
            };
            p.replyingTo = null;
            hideReplyPreview(id);
        }
        if (!dummyMessagesMap[id]) dummyMessagesMap[id] = [];
        dummyMessagesMap[id].push(newMsg);
        if (p.data) {
            p.data.preview = '나: ' + text;
            p.data.time = hh + ':' + mm;
            p.data.timeRaw = now.getTime();
        }
        renderPopupMessages(p.el, id);
        renderSlackChatList();
        input.value = '';
        input.focus();
        // [v6.2] Slack 직접 전송 (chat.postMessage) — 200~400ms, GAS 미경유
        (async function() {
            try {
                if (window.__slackDirect) {
                    var res = await window.__slackDirect('chat.postMessage', { channel: id, text: text });
                    if (res && res.ok) {
                        if (slackRealMode) {
                            var sentTs = res.ts || '0';
                            setTimeout(function() { quickDeltaPoll(id, sentTs); }, 500);
                            setTimeout(function() { quickDeltaPoll(id, sentTs); }, 1500);
                        }
                        return;
                    }
                    console.warn('[v6.2 send Slack 직접 실패]', res && res.error, '— GAS fallback');
                }
            } catch(e) { console.warn('[v6.2 send 예외]', e); }
            // GAS fallback
            google.script.run
                .withSuccessHandler(function(res) {
                    if (!res || !res.success) {
                        showToast('전송 실패: ' + (res ? res.message : '오류'));
                    } else if (slackRealMode) {
                        var sentTs = (res.ts || '0');
                        setTimeout(function() { quickDeltaPoll(id, sentTs); }, 500);
                        setTimeout(function() { quickDeltaPoll(id, sentTs); }, 1500);
                    }
                })
                .sendSlackMessage_v04(id, text, null);
        })();
        showToast(slackRealMode ? '전송됨' : '(데모) 메시지 추가됨');
    }

    // ============================================================
    // [v0.4] 답장(Reply) 기능
    // ============================================================
    function startReply(popupId, msgId, msgFrom, msgText) {
        var p = findPopup(popupId);
        if (!p) return;
        p.replyingTo = { msgId: msgId, from: msgFrom, text: msgText };
        showReplyPreview(popupId, msgFrom, msgText);
        var input = p.el.querySelector('.slack-popup-input');
        if (input) input.focus();
    }

    function cancelReply(popupId) {
        var p = findPopup(popupId);
        if (!p) return;
        p.replyingTo = null;
        hideReplyPreview(popupId);
    }

    function showReplyPreview(popupId, from, text) {
        var wrap = document.getElementById('slack-reply-preview-' + popupId);
        var fromEl = document.getElementById('slack-reply-preview-from-' + popupId);
        var textEl = document.getElementById('slack-reply-preview-text-' + popupId);
        if (wrap && fromEl && textEl) {
            fromEl.textContent = '↩ ' + from + '님에게 답장';
            textEl.textContent = text;
            wrap.style.display = 'flex';
        }
    }

    function hideReplyPreview(popupId) {
        var wrap = document.getElementById('slack-reply-preview-' + popupId);
        if (wrap) wrap.style.display = 'none';
    }

    // ============================================================
    // [v0.4] 파일 업로드 - Option C 방식
    // API-Ready: 서버 함수(getSlackUploadUrl, completeSlackUpload) 는
    //            OAuth 연동 후 내부만 교체. 클라이언트 코드 무변경.
    // ============================================================
    function triggerFilePicker(popupId) {
        var fi = document.getElementById('slack-file-input-' + popupId);
        if (fi) fi.click();
    }

    function handleFilePick(event, popupId) {
        var files = event.target.files;
        if (!files || files.length === 0) return;
        for (var i = 0; i < files.length; i++) {
            uploadFileToSlack(files[i], popupId);
        }
        event.target.value = ''; // 같은 파일 다시 선택 가능하도록
    }

    function setupPopupDragDrop(popupEl, popupId) {
        popupEl.addEventListener('dragenter', function(e) {
            e.preventDefault();
            popupEl.classList.add('drop-active');
        });
        popupEl.addEventListener('dragover', function(e) {
            e.preventDefault();
            popupEl.classList.add('drop-active');
        });
        popupEl.addEventListener('dragleave', function(e) {
            if (e.target === popupEl || !popupEl.contains(e.relatedTarget)) {
                popupEl.classList.remove('drop-active');
            }
        });
        popupEl.addEventListener('drop', function(e) {
            e.preventDefault();
            popupEl.classList.remove('drop-active');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                for (var i = 0; i < e.dataTransfer.files.length; i++) {
                    uploadFileToSlack(e.dataTransfer.files[i], popupId);
                }
            }
        });
    }

    // ★ API-Ready: 이 함수는 OAuth 후에도 그대로 ★
    function uploadFileToSlack(file, popupId) {
        if (!file) return;
        var p = findPopup(popupId);
        if (!p) return;
        showUploadProgress(popupId, file.name, 0);
        // 1단계: 서버에 업로드 URL 요청
        google.script.run
            .withSuccessHandler(function(urlRes) {
                if (!urlRes || !urlRes.success) {
                    showToast('업로드 URL 실패: ' + (urlRes ? urlRes.message : '오류'));
                    hideUploadProgress(popupId);
                    return;
                }
                // 2단계: 더미/실제 분기
                if (urlRes.dummy) {
                    // 더미 모드: 업로드 시뮬레이션 (0.5초 진행 바)
                    simulateUpload(popupId, file, urlRes, function() {
                        completeUploadStep(popupId, file, urlRes);
                    });
                } else {
                    // 실제 모드: URL에 직접 업로드 (OAuth 후)
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', urlRes.upload_url, true);
                    xhr.upload.onprogress = function(e) {
                        if (e.lengthComputable) {
                            showUploadProgress(popupId, file.name, (e.loaded / e.total) * 100);
                        }
                    };
                    xhr.onload = function() {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            completeUploadStep(popupId, file, urlRes);
                        } else {
                            showToast('업로드 실패');
                            hideUploadProgress(popupId);
                        }
                    };
                    xhr.onerror = function() {
                        showToast('네트워크 오류');
                        hideUploadProgress(popupId);
                    };
                    xhr.send(file);
                }
            })
            .withFailureHandler(function() {
                showToast('서버 연결 실패');
                hideUploadProgress(popupId);
            })
            .getSlackUploadUrl(file.name, file.size, popupId);
    }

    function simulateUpload(popupId, file, urlRes, onDone) {
        var pct = 0;
        var interval = setInterval(function() {
            pct += 20;
            showUploadProgress(popupId, file.name, pct);
            if (pct >= 100) {
                clearInterval(interval);
                // 이미지 파일이면 dataUrl 읽기 (프리뷰용)
                if (file.type && file.type.indexOf('image/') === 0) {
                    var reader = new FileReader();
                    reader.onload = function(e) {
                        file._dataUrl = e.target.result;
                        onDone();
                    };
                    reader.readAsDataURL(file);
                } else {
                    onDone();
                }
            }
        }, 80);
    }

    function completeUploadStep(popupId, file, urlRes) {
        google.script.run
            .withSuccessHandler(function(doneRes) {
                hideUploadProgress(popupId);
                if (!doneRes || !doneRes.success) {
                    showToast('업로드 완료 실패: ' + (doneRes ? doneRes.message : '오류'));
                    return;
                }
                // 파일 메시지 추가
                addFileMessageToPopup(popupId, file, doneRes.file);
            })
            .withFailureHandler(function() {
                hideUploadProgress(popupId);
                showToast('완료 통보 실패');
            })
            .completeSlackUpload(urlRes.file_id, popupId, file.name);
    }

    function addFileMessageToPopup(popupId, file, serverFile) {
        var p = findPopup(popupId);
        if (!p) return;
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var isImage = file.type && file.type.indexOf('image/') === 0;
        var newMsgId = 'm_file_' + Date.now();
        var fileMsg = {
            id: newMsgId,
            from: '나',
            mine: true,
            time: hh + ':' + mm,
            file: {
                type: isImage ? 'image' : (file.name.split('.').pop().toLowerCase()),
                name: file.name,
                size: file.size,
                dataUrl: file._dataUrl || null
            }
        };
        if (!dummyMessagesMap[popupId]) dummyMessagesMap[popupId] = [];
        dummyMessagesMap[popupId].push(fileMsg);
        if (p.data) {
            p.data.preview = '나: 📎 ' + file.name;
            p.data.time = hh + ':' + mm;
            p.data.timeRaw = now.getTime();
        }
        renderPopupMessages(p.el, popupId);
        renderSlackChatList();
        showToast('(데모) 파일 업로드 완료: ' + file.name);
    }

    function showUploadProgress(popupId, fileName, pct) {
        var wrap = document.getElementById('slack-upload-progress-' + popupId);
        var label = document.getElementById('slack-upload-label-' + popupId);
        var fill = document.getElementById('slack-upload-fill-' + popupId);
        if (!wrap || !label || !fill) return;
        wrap.classList.add('visible');
        label.textContent = '📎 ' + fileName + ' (' + Math.round(pct) + '%)';
        fill.style.width = pct + '%';
    }

    function hideUploadProgress(popupId) {
        var wrap = document.getElementById('slack-upload-progress-' + popupId);
        if (wrap) wrap.classList.remove('visible');
    }

    // ============================================================
    // [v0.5] 이모지 리액션
    // ============================================================
    function toggleReaction(popupId, msgId, emoji) {
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m) return;
        if (!m.reactions) m.reactions = [];
        var existing = m.reactions.find(function(r) { return r.emoji === emoji; });
        var isMine;
        if (existing) {
            isMine = existing.users && existing.users.indexOf(myUserName) !== -1;
            if (isMine) {
                // 제거
                existing.users = existing.users.filter(function(u) { return u !== myUserName; });
                if (existing.users.length === 0) m.reactions = m.reactions.filter(function(r) { return r.emoji !== emoji; });
                google.script.run.withSuccessHandler(function(){}).removeSlackReaction(popupId, m.ts || '', emoji);
            } else {
                existing.users.push(myUserName);
                google.script.run.withSuccessHandler(function(){}).addSlackReaction(popupId, m.ts || '', emoji);
            }
        } else {
            m.reactions.push({ emoji: emoji, users: [myUserName] });
            google.script.run.withSuccessHandler(function(){}).addSlackReaction(popupId, m.ts || '', emoji);
        }
        var p = findPopup(popupId);
        if (p) renderPopupMessages(p.el, popupId);
    }

    // ============================================================
    // [v0.5] 이모지 피커
    // ============================================================
    function openEmojiPicker(ev, callback) {
        var picker = document.getElementById('emojiPicker');
        if (!picker) return;
        picker.innerHTML = '';
        EMOJI_PICKER_LIST.forEach(function(emoji) {
            var btn = document.createElement('button');
            btn.textContent = emoji;
            btn.addEventListener('click', function() {
                callback(emoji);
                picker.classList.remove('visible');
            });
            picker.appendChild(btn);
        });
        var rect = ev.target.getBoundingClientRect();
        picker.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
        picker.style.top = (rect.bottom + 6) + 'px';
        picker.classList.add('visible');
        emojiPickerCallback = callback;
        // 바깥 클릭 시 닫기
        setTimeout(function() {
            var onOut = function(e) {
                if (!picker.contains(e.target)) {
                    picker.classList.remove('visible');
                    document.removeEventListener('mousedown', onOut);
                }
            };
            document.addEventListener('mousedown', onOut);
        }, 50);
    }

    function openEmojiPickerForInput(popupId, ev) {
        openEmojiPicker(ev, function(emoji) {
            var p = findPopup(popupId);
            if (!p) return;
            var input = p.el.querySelector('.slack-popup-input');
            if (input) {
                input.value += emoji;
                input.focus();
            }
        });
    }

    // ============================================================
    // [v0.5] 메시지 컨텍스트 메뉴 (복사/전달/수정/삭제)
    // ============================================================
    function openMessageContextMenu(ev, popupId, msgId) {
        var menu = document.getElementById('msgContextMenu');
        if (!menu) return;
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m) return;
        var isMine = m.mine;
        var html = '';
        html += '<button onclick="copyMessageText(\'' + popupId + '\', \'' + msgId + '\')">📋 복사</button>';
        html += '<button onclick="openForwardModal(\'' + popupId + '\', \'' + msgId + '\')">📨 전달</button>';
        if (isMine) {
            html += '<div class="menu-divider"></div>';
            html += '<button onclick="editMessagePrompt(\'' + popupId + '\', \'' + msgId + '\')">✏ 수정</button>';
            html += '<button class="danger" onclick="deleteMessage(\'' + popupId + '\', \'' + msgId + '\')">🗑 삭제</button>';
        }
        menu.innerHTML = html;
        var rect = ev.target.getBoundingClientRect();
        menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
        menu.style.top = (rect.bottom + 6) + 'px';
        menu.classList.add('visible');
        setTimeout(function() {
            var onOut = function(e) {
                if (!menu.contains(e.target)) {
                    menu.classList.remove('visible');
                    document.removeEventListener('mousedown', onOut);
                }
            };
            document.addEventListener('mousedown', onOut);
        }, 50);
    }

    function hideContextMenu() {
        var menu = document.getElementById('msgContextMenu');
        if (menu) menu.classList.remove('visible');
    }

    function copyMessageText(popupId, msgId) {
        hideContextMenu();
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m) return;
        var text = m.text || (m.file ? '[파일] ' + m.file.name : '');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                showToast('복사됨');
            }, function() {
                showToast('복사 실패');
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); showToast('복사됨'); } catch(e) { showToast('복사 실패'); }
            document.body.removeChild(ta);
        }
    }

    function editMessagePrompt(popupId, msgId) {
        hideContextMenu();
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m || !m.mine) return;
        var newText = prompt('메시지 수정:', m.text || '');
        if (newText === null || newText.trim() === '') return;
        m.text = newText.trim();
        m.edited = true;
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) showToast('수정 실패');
            })
            .editSlackMessage(popupId, m.ts || '', newText.trim());
        var p = findPopup(popupId);
        if (p) renderPopupMessages(p.el, popupId);
        renderSlackChatList();
        showToast('수정됨');
    }

    function deleteMessage(popupId, msgId) {
        hideContextMenu();
        if (!confirm('이 메시지를 삭제할까요?')) return;
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m || !m.mine) return;
        m.deleted = true;
        m.text = '';
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) showToast('삭제 실패');
            })
            .deleteSlackMessage(popupId, m.ts || '');
        var p = findPopup(popupId);
        if (p) renderPopupMessages(p.el, popupId);
        showToast('삭제됨');
    }

    // ============================================================
    // [v0.5] 메시지 전달
    // ============================================================
    var forwardingFrom = null; // { popupId, msgId }

    function openForwardModal(popupId, msgId) {
        hideContextMenu();
        forwardingFrom = { popupId: popupId, msgId: msgId };
        var modal = document.getElementById('slackForwardModal');
        var list = document.getElementById('slackForwardList');
        if (!modal || !list) return;
        // 전달 대상 목록: 모든 DM + 채널
        var html = '';
        dummyDMs.forEach(function(d) {
            if (d.id === popupId) return; // 원본 제외
            html += buildForwardTargetItem(d, 'dm');
        });
        dummyChannels.forEach(function(c) {
            if (c.id === popupId) return;
            html += buildForwardTargetItem(c, 'channel');
        });
        list.innerHTML = html;
        modal.classList.add('visible');
    }

    function buildForwardTargetItem(item, type) {
        var color = avatarColorFromName(item.name);
        var icon = type === 'channel' ? '#' : (item.isGroup ? '👥' : firstCharOf(item.name));
        var bg = type === 'channel' ? '#64748b' : color;
        var safeId = String(item.id).replace(/'/g, "\\'");
        return '<div class="slack-forward-target" onclick="executeForward(\'' + type + '\', \'' + safeId + '\')">' +
            '<div class="mention-item-avatar" style="background:' + bg + ';">' + icon + '</div>' +
            '<div>' + escapeHtml(item.name) + '</div>' +
        '</div>';
    }

    function closeForwardModal() {
        var modal = document.getElementById('slackForwardModal');
        if (modal) modal.classList.remove('visible');
        forwardingFrom = null;
    }

    function executeForward(targetType, targetId) {
        if (!forwardingFrom) { closeForwardModal(); return; }
        var srcMsgs = dummyMessagesMap[forwardingFrom.popupId];
        if (!srcMsgs) { closeForwardModal(); return; }
        var m = srcMsgs.find(function(x) { return x.id === forwardingFrom.msgId; });
        if (!m) { closeForwardModal(); return; }
        // 타겟에 새 메시지 추가 (전달 표시)
        if (!dummyMessagesMap[targetId]) dummyMessagesMap[targetId] = [];
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var newText = '[전달] ' + (m.from || '') + ': ' + (m.text || (m.file ? m.file.name : ''));
        dummyMessagesMap[targetId].push({
            id: 'm_fwd_' + Date.now(),
            from: myUserName,
            text: newText,
            time: hh + ':' + mm,
            mine: true,
            ts: String(now.getTime() / 1000)
        });
        google.script.run
            .withSuccessHandler(function(){})
            .forwardSlackMessage(forwardingFrom.popupId, m.ts || '', targetId, m.text || '', m.from || '');
        showToast('전달됨');
        closeForwardModal();
        // 목록 갱신
        renderSlackChatList();
        // 대상 팝업 열려있으면 갱신
        var tp = findPopup(targetId);
        if (tp) renderPopupMessages(tp.el, targetId);
    }

    // ============================================================
    // [v0.5] 프로필 모달
    // ============================================================
    function showProfileModal(userName) {
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                renderProfileModal(res.profile, userName);
            })
            .getSlackUserProfile(userName);
    }

    function renderProfileModal(profile, fallbackName) {
        var modal = document.getElementById('slackProfileModal');
        var content = document.getElementById('slackProfileContent');
        if (!modal || !content) return;
        var name = profile.name || fallbackName;
        var color = avatarColorFromName(name);
        content.innerHTML =
            '<div class="profile-big-avatar" style="background:' + color + ';">' + firstCharOf(name) + '</div>' +
            '<div class="profile-name">' + escapeHtml(name) + '</div>' +
            '<div class="profile-title">' + escapeHtml(profile.title || '') + '</div>' +
            '<div class="profile-row"><span class="label">이메일</span><span class="value">' + escapeHtml(profile.email || '') + '</span></div>' +
            '<div class="profile-row"><span class="label">상태</span><span class="value">' + escapeHtml(profile.status || '') + '</span></div>' +
            '<div class="profile-row"><span class="label">연락처</span><span class="value">' + escapeHtml(profile.phone || '') + '</span></div>' +
            '<button class="profile-close-btn" onclick="closeProfileModal()">닫기</button>';
        modal.classList.add('visible');
    }

    function closeProfileModal() {
        var modal = document.getElementById('slackProfileModal');
        if (modal) modal.classList.remove('visible');
    }

    // ============================================================
    // [v0.5] @멘션 자동완성
    // ============================================================
    function checkMentionTrigger(popupId, input) {
        var val = input.value;
        var caret = input.selectionStart;
        // 커서 직전 @로 시작하는 단어 찾기
        var before = val.substring(0, caret);
        var match = before.match(/@([^\s@]*)$/);
        if (!match) {
            hideMentionDropdown();
            return;
        }
        var query = match[1].toLowerCase();
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                var filtered = res.members.filter(function(mb) {
                    return !query || mb.name.toLowerCase().indexOf(query) !== -1;
                });
                if (filtered.length === 0) { hideMentionDropdown(); return; }
                showMentionDropdown(popupId, input, filtered, match[0]);
            })
            .getSlackChannelMembers(popupId);
    }

    function showMentionDropdown(popupId, inputEl, members, trigger) {
        var dd = document.getElementById('mentionDropdown');
        if (!dd) return;
        var html = '';
        members.slice(0, 8).forEach(function(mb) {
            var color = avatarColorFromName(mb.name);
            html +=
                '<div class="mention-item" onclick="insertMention(\'' + popupId + '\', \'' + String(mb.name).replace(/'/g, "\\'") + '\')">' +
                    '<div class="mention-item-avatar" style="background:' + color + ';">' + firstCharOf(mb.name) + '</div>' +
                    '<div>' + escapeHtml(mb.name) + '</div>' +
                '</div>';
        });
        dd.innerHTML = html;
        var rect = inputEl.getBoundingClientRect();
        dd.style.left = rect.left + 'px';
        dd.style.top = (rect.top - 250) + 'px';
        dd.classList.add('visible');
        activeMentionState = { popupId: popupId, trigger: trigger, inputEl: inputEl };
    }

    function hideMentionDropdown() {
        var dd = document.getElementById('mentionDropdown');
        if (dd) dd.classList.remove('visible');
        activeMentionState = null;
    }

    function insertMention(popupId, name) {
        if (!activeMentionState) { hideMentionDropdown(); return; }
        var input = activeMentionState.inputEl;
        var val = input.value;
        var caret = input.selectionStart;
        var before = val.substring(0, caret);
        var after = val.substring(caret);
        var newBefore = before.replace(/@[^\s@]*$/, '@' + name + ' ');
        input.value = newBefore + after;
        var newCaret = newBefore.length;
        input.focus();
        input.setSelectionRange(newCaret, newCaret);
        hideMentionDropdown();
    }

    // ============================================================
    // [v0.5] 새 메시지 알림 (최소화/비활성 상태)
    // ============================================================
    function addMessageToChat(popupId, msgData, opts) {
        opts = opts || {};
        if (!dummyMessagesMap[popupId]) dummyMessagesMap[popupId] = [];
        dummyMessagesMap[popupId].push(msgData);
        // 메타데이터 업데이트
        var metas = [dummyDMs, dummyChannels, dummyCanvases];
        var meta = null;
        for (var i = 0; i < metas.length; i++) {
            meta = metas[i].find(function(x) { return x.id === popupId; });
            if (meta) break;
        }
        if (meta) {
            meta.preview = (msgData.from || '') + ': ' + (msgData.text || (msgData.file ? '[파일]' : ''));
            meta.time = msgData.time;
            meta.timeRaw = Date.now();
            // 팝업 열려있고 최소화 안 됐으면 읽음
            var p = findPopup(popupId);
            var isActiveView = p && !p.minimized;
            if (!isActiveView) {
                meta.unread = (meta.unread || 0) + 1;
                popupUnreadMap[popupId] = (popupUnreadMap[popupId] || 0) + 1;
            }
        }
        // 팝업 열려있으면 메시지 영역 갱신
        var p2 = findPopup(popupId);
        if (p2) renderPopupMessages(p2.el, popupId);
        // 목록 갱신 + 탭 카운트
        renderSlackChatList();
        updateTabCounts();
        renderDock();
        updateBrowserTitle();
        // [v1.0] 3종 알림: 데스크톱 + 탭 깜빡임 + 소리
        if (opts.notify && meta) {
            showDesktopNotification(meta.name, msgData.from + ': ' + (msgData.text || '[파일]'));
            startTabFlash(msgData.from, msgData.text || '[파일]');
            try { playSlackDing(); } catch(e) {}
        }
    }

    function updateBrowserTitle() {
        var totalUnread = 0;
        dummyDMs.forEach(function(x) { totalUnread += (x.unread || 0); });
        dummyChannels.forEach(function(x) { totalUnread += (x.unread || 0); });
        dummyCanvases.forEach(function(x) { totalUnread += (x.unread || 0); });
        document.title = (totalUnread > 0 ? '(' + totalUnread + ') ' : '') + '💬 개인대시보드 Slack';
        // [v5.6] 작업 표시줄 아이콘에 빨간 배지 + 트레이 tooltip (Tauri)
        try {
            var T = window.__TAURI__;
            if (T && T.core && T.core.invoke && location.search.indexOf('chatWindow=1') === -1) {
                T.core.invoke('set_unread_badge', { count: totalUnread }).catch(function(){});
            }
        } catch(e) {}
    }

    function showDesktopNotification(title, body) {
        // [Tauri] 네이티브 알림 우선 — 브라우저 SW 대비 2~3배 빠르고 Focus Assist 덜 영향
        try {
            var T = window.__TAURI__;
            if (T && T.notification && T.notification.sendNotification) {
                T.notification.isPermissionGranted().then(function(ok) {
                    var fire = function() { T.notification.sendNotification({ title: '💬 ' + title, body: body }); };
                    if (ok) { fire(); }
                    else { T.notification.requestPermission().then(function(p) { if (p === 'granted') fire(); }); }
                });
                return;
            }
        } catch(e) { /* fallback to browser */ }
        if (typeof Notification === 'undefined') return;
        if (Notification.permission !== 'granted') {
            if (Notification.permission !== 'denied') Notification.requestPermission();
            return;
        }
        // [v3.4.3] Chrome PWA standalone은 new Notification() 차단 —
        //   SW registration이 있으면 controller 비활성이어도 registration.showNotification 사용
        var opts = {
            body: body,
            icon: 'icon-192.png',
            badge: 'icon-192.png',
            tag: 'slack-msg',
            // [v3.4.4] Slack 공식 앱처럼 자연스럽게 — Windows 기본 타이머로 자동 사라짐
            requireInteraction: false,
            silent: false,
            data: { url: location.href, title: title }
        };
        if ('serviceWorker' in navigator) {
            // getRegistration은 controller 비활성이어도 등록된 SW 반환
            navigator.serviceWorker.getRegistration().then(function(reg) {
                if (reg && reg.active) {
                    return reg.showNotification('💬 ' + title, opts);
                }
                // registration 아직 active 아님 → ready 대기
                return navigator.serviceWorker.ready.then(function(r) {
                    return r.showNotification('💬 ' + title, opts);
                });
            }).catch(function(err) {
                // SW 경로 완전 실패 → 마지막 수단
                _showDesktopNotificationFallback(title, body);
            });
        } else {
            _showDesktopNotificationFallback(title, body);
        }
    }
    function _showDesktopNotificationFallback(title, body) {
        try {
            var n = new Notification('💬 ' + title, {
                body: body,
                icon: 'icon-192.png',
                tag: 'slack-msg',
                requireInteraction: false,  // [v3.4.4] 자동 사라짐
                silent: false
            });
            n.onclick = function() { window.focus(); stopTabFlash(); n.close(); };
            // [v3.4.4] 보강: Windows 기본 5초보다 짧게 3초 후 자동 close
            setTimeout(function() { try { n.close(); } catch(e) {} }, 3000);
        } catch(e) {
            // 최후의 수단 — 옵션 빼고 기본만
            try { new Notification('💬 ' + title); } catch(e2) {}
        }
    }

    // [v3.4] 화면 좌측 하단 인앱 토스트 알림 (카톡 미리보기 스타일)
    var __inAppToastQueue = [];
    function showInAppToast(senderName, text, channelId) {
        var container = document.getElementById('slackInAppToast');
        if (!container) return;
        var card = document.createElement('div');
        card.className = 'toast-card';
        card.innerHTML =
            '<div class="toast-from">' + escapeHtml(senderName || '새 메시지') + '</div>' +
            '<div class="toast-text">' + escapeHtml((text || '').substring(0, 80)) + '</div>';
        card.addEventListener('click', function() {
            try {
                window.focus();
                if (channelId) openSlackChatPopup('dm', channelId);
            } catch(e) {}
            card.remove();
        });
        container.appendChild(card);
        // 5초 후 자동 제거
        setTimeout(function() {
            if (card && card.parentNode) {
                card.style.transition = 'opacity 0.3s';
                card.style.opacity = '0';
                setTimeout(function() { if (card.parentNode) card.remove(); }, 300);
            }
        }, 5000);
        // 5개 초과 시 가장 오래된 거 제거
        var cards = container.querySelectorAll('.toast-card');
        if (cards.length > 5) {
            for (var i = 0; i < cards.length - 5; i++) cards[i].remove();
        }
    }

    // ============================================================
    // [v0.6] Slack 진단 — 오류신고에 전부 기록
    // ============================================================
    function runSlackDiagnostics() {
        showToast('진단 중...');
        google.script.run
            .withSuccessHandler(function(res) {
                var lines = [];
                lines.push('=== Slack 진단 v3.0 ===');
                lines.push('시각: ' + new Date().toLocaleString());
                lines.push('버전: Slack v3.0');
                lines.push('');

                // 토큰 상태
                lines.push('[토큰 상태]');
                lines.push('  토큰 존재: ' + (res.tokenExists ? 'YES' : 'NO'));
                lines.push('  토큰 앞부분: ' + (res.tokenPrefix || 'none'));
                lines.push('  토큰 길이: ' + (res.tokenLength || 0));
                lines.push('  토큰 소스: ' + (res.tokenSource || 'unknown'));
                lines.push('');

                // auth
                lines.push('[auth.test]');
                if (res.auth) {
                    lines.push('  ok: ' + res.auth.ok);
                    if (res.auth.ok) {
                        lines.push('  user: ' + (res.auth.user || ''));
                        lines.push('  user_id: ' + (res.auth.user_id || ''));
                        lines.push('  team: ' + (res.auth.team || ''));
                        lines.push('  team_id: ' + (res.auth.team_id || ''));
                    } else {
                        lines.push('  error: ' + (res.auth.error || 'unknown'));
                    }
                } else {
                    lines.push('  실행 안 됨 (토큰 없음)');
                }
                lines.push('');

                // OAuth2 상태
                lines.push('[OAuth2 서비스]');
                lines.push('  hasAccess: ' + (res.oauthHasAccess || false));
                lines.push('  oauth2.slack 키 존재: ' + (res.oauthKeyExists || false));
                lines.push('');

                // conversations
                if (res.byType) {
                    lines.push('[conversations.list 타입별]');
                    for (var t in res.byType) {
                        var d = res.byType[t];
                        lines.push('  ' + t + ': ok=' + d.ok + ' count=' + (d.count || 0) + (d.error ? ' error=' + d.error : ''));
                    }
                    lines.push('');
                }

                // 클라이언트 상태 (대폭 확대)
                lines.push('[클라이언트 상태]');
                lines.push('  realMode: ' + slackRealMode);
                lines.push('  myUserId: ' + slackMyUserId);
                lines.push('  DMs: ' + dummyDMs.length);
                lines.push('  channels: ' + dummyChannels.length);
                lines.push('  canvases: ' + dummyCanvases.length);
                lines.push('  friends: ' + dummyFriends.length);
                lines.push('  openPopups: ' + openSlackPopups.length);
                lines.push('  focusedPopup: ' + (focusedPopupId || 'none'));
                lines.push('  currentTab: ' + currentSlackTab);
                lines.push('  searchQuery: "' + slackSearchQuery + '"');
                lines.push('');

                // 열린 팝업 상세
                if (openSlackPopups.length > 0) {
                    lines.push('[열린 팝업 상세]');
                    openSlackPopups.forEach(function(p, i) {
                        var msgCount = (dummyMessagesMap[p.id] || []).length;
                        var lastTs = '';
                        if (msgCount > 0) {
                            var lastMsg = dummyMessagesMap[p.id][msgCount - 1];
                            lastTs = lastMsg.ts || '';
                        }
                        lines.push('  [' + i + '] id=' + p.id + ' name="' + p.name + '" type=' + p.type + ' minimized=' + p.minimized + ' msgs=' + msgCount + ' lastTs=' + lastTs);
                        // [v3.3] DOM 상태 (위치/크기/가시성) 진단
                        if (p.el) {
                            var rect = p.el.getBoundingClientRect();
                            var cs = window.getComputedStyle(p.el);
                            var inViewport = (rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0);
                            lines.push('       DOM: x=' + Math.round(rect.left) + ' y=' + Math.round(rect.top) + ' w=' + Math.round(rect.width) + ' h=' + Math.round(rect.height) + ' z=' + cs.zIndex + ' display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' inViewport=' + inViewport);
                        } else {
                            lines.push('       DOM: ❌ p.el 없음 (DOM에 추가 안 됨!)');
                        }
                    });
                    lines.push('');
                }

                // [v3.4] 알림 시스템 상태 진단 (사용자 요청)
                lines.push('[알림 상태]');
                try {
                    var notifPerm = (typeof Notification !== 'undefined') ? Notification.permission : 'N/A';
                    lines.push('  Notification 권한: ' + notifPerm);
                } catch(e) { lines.push('  Notification: 확인 실패'); }
                var hasSW = ('serviceWorker' in navigator);
                lines.push('  Service Worker 지원: ' + hasSW);
                if (hasSW && navigator.serviceWorker.controller) {
                    lines.push('  SW 컨트롤러: 활성');
                } else if (hasSW) {
                    lines.push('  SW 컨트롤러: 비활성 (알림 제한될 수 있음)');
                }
                lines.push('  화면 포커스: ' + (document.hasFocus() ? 'YES' : 'NO'));
                lines.push('  페이지 가시성: ' + document.visibilityState);
                lines.push('  누적 알림 수(이번 세션): ' + (window.__slackTotalAlerts || 0));
                lines.push('  Events API 폴링: 호출 ' + (window.__slackEventApiCallCount || 0) + '회 / 응답 ' + (window.__slackEventApiRespCount || 0) + '회 / hit ' + (window.__slackEventApiHitCount || 0) + '회');
                lines.push('  마지막 Events API 응답: ' + (window.__slackLastAlertAt ? new Date(window.__slackLastAlertAt).toLocaleTimeString() : 'never'));
                lines.push('  마지막 활성 채널: ' + (window.__slackLastEventChannels || '없음'));
                // [v3.5] Unread 폴링 통계
                var __curIntv = (typeof getMasterInterval === 'function') ? getMasterInterval() : 3000;
                lines.push('  [Master폴링] 현재 간격: ' + (__curIntv / 1000) + '초 (에러연속: ' + slackErrorStreak + ', 탭가시성: ' + document.visibilityState + ')');
                lines.push('  [Unread폴링] 호출 ' + (window.__slackUnreadPollCount || 0) + '회, 마지막: ' + (window.__slackLastUnreadAt ? new Date(window.__slackLastUnreadAt).toLocaleTimeString() : 'never'));
                lines.push('  [Unread폴링] 추적 채널: ' + Object.keys(slackLastUnreadMap).length + '개');
                lines.push('  [LatestTs폴링] 호출 ' + (window.__slackLatestTsPollCount || 0) + '회, 추적: ' + Object.keys(slackLatestTsMap).length + '개');
                lines.push('  [Master폴링] 호출 ' + (window.__slackMasterPollCount || 0) + '회, 마지막: ' + (window.__slackLastMasterAt ? new Date(window.__slackLastMasterAt).toLocaleTimeString() : 'never'));
                // [v3.4] 서버 doPost 통계 (Events API가 실제로 작동하는지 확인)
                try {
                    if (window.__slackServerEventStats) {
                        var s = window.__slackServerEventStats;
                        lines.push('  [서버] doPost 호출: ' + (s.doPostCount || 0) + '회 (마지막: ' + (s.doPostLastAgo || 'never') + ')');
                        lines.push('  [서버] 마지막 이벤트 타입: ' + (s.doPostLastType || '없음'));
                        lines.push('  [서버] 활성 채널 캐시: ' + (s.activeChannelsCount || 0) + '개');
                    } else {
                        lines.push('  [서버] doPost 통계: 확인 중... (다음 진단에서 표시)');
                        // 비동기로 가져와서 다음 진단에 표시
                        google.script.run
                            .withSuccessHandler(function(r) { window.__slackServerEventStats = r; })
                            .getEventApiStats();
                    }
                } catch(e) {}
                lines.push('  탭 깜빡임 상태: ' + (tabFlashInterval ? 'active' : 'off'));
                lines.push('  탭 깜빡임 큐: ' + tabFlashMessages.length + '개');
                var toastCards = document.querySelectorAll('#slackInAppToast .toast-card');
                lines.push('  현재 표시 중인 토스트: ' + toastCards.length + '개');
                lines.push('');

                // [v3.4] 인라인 버튼 상태 (헤더 버튼 가림 버그 진단용)
                lines.push('[인라인 버튼 상태]');
                var backBtns = document.querySelectorAll('.slack-popup-back-btn');
                lines.push('  뒤로가기 버튼: ' + backBtns.length + '개');
                var diagBtns = document.querySelectorAll('.slack-popup-diag-btn');
                lines.push('  진단 버튼: ' + diagBtns.length + '개');
                lines.push('');

                // [v3.3] PWA/멀티윈도우 환경 진단
                lines.push('[환경 상세]');
                var isStandalone = false;
                try {
                    isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                                   (window.matchMedia && window.matchMedia('(display-mode: window-controls-overlay)').matches) ||
                                   (window.navigator && window.navigator.standalone === true);
                } catch(e) {}
                lines.push('  isPWA(standalone): ' + isStandalone);
                lines.push('  viewport: ' + window.innerWidth + 'x' + window.innerHeight);
                lines.push('  multi_window 패치됨: ' + (window.openSlackChatPopup && window.openSlackChatPopup._patched === true));
                var bodyOverflow = window.getComputedStyle(document.body).overflow;
                lines.push('  body.overflow: ' + bodyOverflow);
                lines.push('');

                // 폴링 상태
                lines.push('[폴링 상태]');
                lines.push('  deltaInterval: ' + (slackDeltaInterval ? 'active(1s)' : 'off'));
                lines.push('  cacheInterval: ' + (slackCacheInterval ? 'active(3s)' : 'off'));
                lines.push('  lastListRefresh: ' + (window._lastListRefresh ? new Date(window._lastListRefresh).toLocaleTimeString() : 'never'));
                lines.push('');

                // usersMap 상태
                lines.push('[usersMap]');
                var umKeys = Object.keys(slackUsersMap);
                lines.push('  총 유저 수: ' + umKeys.length);
                lines.push('  봇 제외 유저: ' + umKeys.filter(function(k) { return !(slackUsersMap[k] && slackUsersMap[k].isBot); }).length);
                lines.push('');

                // DM 검색 테스트
                lines.push('[DM에서 "신현식" 검색]');
                var foundShin = dummyDMs.filter(function(d) {
                    return (d.name || '').indexOf('신현식') !== -1;
                });
                if (foundShin.length > 0) {
                    foundShin.forEach(function(d, i) {
                        lines.push('  찾음! [' + i + '] id=' + d.id + ' name="' + d.name + '" group=' + (d.isGroup || false));
                    });
                } else {
                    lines.push('  ❌ "신현식" 없음');
                }
                lines.push('');

                // DM 이름 샘플
                lines.push('[DM 이름 샘플]');
                lines.push('  처음 5개:');
                dummyDMs.slice(0, 5).forEach(function(d, i) {
                    lines.push('    [' + i + '] id=' + d.id + ' name="' + (d.name || '') + '" unread=' + (d.unread || 0));
                });
                lines.push('  마지막 5개:');
                dummyDMs.slice(-5).forEach(function(d, i) {
                    var idx = dummyDMs.length - 5 + i;
                    lines.push('    [' + idx + '] id=' + dummyDMs[idx].id + ' name="' + (dummyDMs[idx].name || '') + '" unread=' + (dummyDMs[idx].unread || 0));
                });
                lines.push('');

                // 채널 샘플
                lines.push('[채널 샘플 (처음 10개)]');
                dummyChannels.slice(0, 10).forEach(function(c, i) {
                    lines.push('  [' + i + '] id=' + c.id + ' name="' + (c.name || '') + '" unread=' + (c.unread || 0));
                });
                lines.push('');

                // 메시지맵 상태
                lines.push('[메시지맵 (dummyMessagesMap)]');
                var mmKeys = Object.keys(dummyMessagesMap);
                lines.push('  캐시된 채널 수: ' + mmKeys.length);
                mmKeys.forEach(function(k) {
                    lines.push('  ' + k + ': ' + (dummyMessagesMap[k] || []).length + '개');
                });
                lines.push('');

                // 오류 수집기
                if (typeof window.__errorCollector !== 'undefined' && window.__errorCollector.length > 0) {
                    lines.push('[수집된 오류 ' + window.__errorCollector.length + '건]');
                    window.__errorCollector.forEach(function(e, i) {
                        lines.push('  [' + i + '] ' + (e.type || '') + ': ' + String(e.message || '').substring(0, 150));
                        if (e.source) lines.push('    source: ' + e.source + ':' + (e.line || 0));
                        if (e.stack) lines.push('    stack: ' + String(e.stack).substring(0, 200));
                    });
                    lines.push('');
                } else {
                    lines.push('[수집된 오류] 없음 ✅');
                    lines.push('');
                }

                // 브라우저 정보
                lines.push('[환경]');
                lines.push('  URL: ' + (location.href || '').substring(0, 80));
                lines.push('  화면: ' + window.innerWidth + 'x' + window.innerHeight);
                lines.push('');

                lines.push('=== 끝 ===');
                var fullText = lines.join('\n');
                console.log(fullText);

                // [v3.0 fix] 클립보드 복사 — execCommand만 사용 (iframe에서 navigator.clipboard 안됨!)
                var copied = false;
                try {
                    var ta = document.createElement('textarea');
                    ta.value = fullText;
                    ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    copied = document.execCommand('copy');
                    document.body.removeChild(ta);
                } catch(e) {}
                showToast(copied ? '✅ 진단 결과 클립보드 복사 완료!' : '진단 완료 (팝업에서 Ctrl+A → Ctrl+C)');
                // 복사 실패 시에만 팝업 표시
                if (!copied) showDiagnosticResult(fullText);
            })
            .withFailureHandler(function(err) {
                showToast('진단 실패: ' + String(err));
            })
            .debugSlackApi();
    }

    // [v2.0] 진단 결과를 텍스트박스 팝업으로 — Ctrl+A → Ctrl+C 가능!
    function showDiagnosticResult(text) {
        var existing = document.getElementById('diagResultOverlay');
        if (existing) existing.remove();
        var overlay = document.createElement('div');
        overlay.id = 'diagResultOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;';
        overlay.innerHTML =
            '<div style="background:#fff;border-radius:12px;padding:20px;max-width:600px;width:100%;max-height:80vh;display:flex;flex-direction:column;">' +
                '<h3 style="margin:0 0 10px;color:#1e293b;">🔍 진단 결과</h3>' +
                '<p style="font-size:12px;color:#64748b;margin:0 0 10px;">아래 텍스트를 <strong>Ctrl+A → Ctrl+C</strong> 로 복사해주세요</p>' +
                '<textarea id="diagResultText" style="flex:1;min-height:300px;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;font-family:monospace;resize:none;color:#1e293b;" readonly>' + text + '</textarea>' +
                '<button onclick="document.getElementById(\'diagResultOverlay\').remove()" style="margin-top:10px;padding:8px 20px;background:#e2e8f0;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">닫기</button>' +
            '</div>';
        overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        // 텍스트 자동 선택
        setTimeout(function() {
            var ta = document.getElementById('diagResultText');
            if (ta) { ta.focus(); ta.select(); }
        }, 100);
    }

    // 페이지 로드 시 자동 진단 (실제 모드일 때)
    function autoRunDiagnostics() {
        setTimeout(function() {
            runSlackDiagnostics();
        }, 3000);
    }

    // ============================================================
    // [v1.0] 새 메시지 알림 — 탭 깜빡임 + 작업표시줄 깜빡임 + 소리
    // ============================================================
    var tabFlashInterval = null;
    var tabFlashOriginalTitle = '';

    // ============================================================
    // [v3.0] 강력한 탭 깜빡임 — 읽을 때까지 계속!
    // ============================================================
    var tabFlashCount = 0;           // 안 읽은 알림 수
    var tabFlashMessages = [];       // 알림 메시지 큐

    function startTabFlash(senderName, text) {
        // [v3.0] 포커스 여부 관계없이 카운트 증가 + 알림 큐 추가
        tabFlashCount++;
        var preview = (senderName ? senderName + ': ' : '') + (text || '새 메시지').substring(0, 30);
        tabFlashMessages.push(preview);
        if (tabFlashMessages.length > 5) tabFlashMessages.shift(); // 최대 5개

        // 탭이 활성 상태면 소리만 + 데스크톱 알림
        if (document.hasFocus()) {
            try { playSlackDing(); } catch(e) {}
            showDesktopNotification(senderName || '새 메시지', text || '');
            // 포커스 상태에서는 카운트 바로 리셋
            tabFlashCount = 0;
            tabFlashMessages = [];
            return;
        }

        // 비활성 → 강력한 깜빡임 시작!
        if (!tabFlashOriginalTitle) {
            tabFlashOriginalTitle = document.title;
        }

        // 기존 인터벌 있으면 유지 (카운트만 증가)
        if (tabFlashInterval) return;

        var flashPhase = 0;
        tabFlashInterval = setInterval(function() {
            flashPhase = (flashPhase + 1) % 4;
            var latestMsg = tabFlashMessages.length > 0 ? tabFlashMessages[tabFlashMessages.length - 1] : '새 메시지';
            switch(flashPhase) {
                case 0: document.title = '🔴 [' + tabFlashCount + '개] ' + latestMsg; break;
                case 1: document.title = '⚡ [' + tabFlashCount + '개] 새 메시지!'; break;
                case 2: document.title = '🔴 [' + tabFlashCount + '개] ' + latestMsg; break;
                case 3: document.title = '💬 확인해주세요!'; break;
            }
        }, 500); // 0.5초마다 깜빡 (더 빠르게!)

        // 데스크톱 알림
        showDesktopNotification(senderName || '새 메시지', text || '');
        // 소리 (2초 간격으로 반복 3회)
        try { playSlackDing(); } catch(e) {}
        setTimeout(function() { try { playSlackDing(); } catch(e) {} }, 2000);
        setTimeout(function() { try { playSlackDing(); } catch(e) {} }, 4000);
    }

    function stopTabFlash() {
        if (tabFlashInterval) {
            clearInterval(tabFlashInterval);
            tabFlashInterval = null;
        }
        if (tabFlashOriginalTitle) {
            document.title = tabFlashOriginalTitle;
            tabFlashOriginalTitle = '';
        }
        tabFlashCount = 0;
        tabFlashMessages = [];
    }

    // 탭 포커스 돌아오면 깜빡임 멈춤
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) stopTabFlash();
    });
    window.addEventListener('focus', function() { stopTabFlash(); });

    // [v3.0] 알림 테스트 버튼
    function testSlackNotification() {
        // [v3.4.2] 알림 시스템 end-to-end 검증
        //   단계별로 각 알림 방식을 순차 발사 → 라이악마님이 어느 게 뜨고 어느 게 안 뜨는지 직접 확인
        var origHasFocus = document.hasFocus;
        document.hasFocus = function() { return false; };

        // 1단계 (즉시): 탭 깜빡임 — 가장 단순한 알림
        showToast('1/4: 탭 제목 깜빡임 테스트');
        startTabFlash('테스트', '1단계: 탭 깜빡임');

        // 2단계 (0.5초 뒤): 좌측 하단 인앱 토스트
        setTimeout(function() {
            showToast('2/4: 좌측 하단 토스트 테스트');
            try { showInAppToast('테스트 친구', '2단계: 좌측 하단 카드 보이나요?', ''); } catch(e) {}
            window.__slackTotalAlerts = (window.__slackTotalAlerts || 0) + 1;
        }, 500);

        // 3단계 (1초 뒤): 데스크톱 알림 (SW 또는 Notification API)
        setTimeout(function() {
            showToast('3/4: 데스크톱(Windows) 알림 테스트 — 우측 하단 확인');
            try { showDesktopNotification('테스트 친구', '3단계: 우측 하단에 뜨나요?'); } catch(e) {}
        }, 1000);

        // 4단계 (1.5초 뒤): 소리
        setTimeout(function() {
            showToast('4/4: 알림 소리');
            try { playSlackDing(); } catch(e) {}
        }, 1500);

        // 포커스 복원
        setTimeout(function() { document.hasFocus = origHasFocus; }, 200);

        // 최종 요약
        setTimeout(function() {
            showToast('✅ 테스트 완료! 안 뜬 알림이 있으면 알려주세요 (진단에 상세 정보 있어요)');
        }, 2500);
    }

    // addMessageToChat에서 알림 호출하도록 수정은 이미 있음.
    // 추가: startTabFlash 호출

    // ============================================================
    // [v1.0] 팝업 확대/축소 토글
    // ============================================================
    function toggleMaximizePopup(popupId) {
        var p = findPopup(popupId);
        if (!p) return;
        if (p.el.classList.contains('maximized')) {
            // 축소 → 원래 크기/위치 복원
            p.el.classList.remove('maximized');
            if (p.savedPos) {
                p.el.style.left = p.savedPos.left;
                p.el.style.top = p.savedPos.top;
                p.el.style.width = p.savedPos.width;
                p.el.style.height = p.savedPos.height;
            }
        } else {
            // 확대 → 현재 위치 저장 후 전체 크기
            p.savedPos = {
                left: p.el.style.left,
                top: p.el.style.top,
                width: p.el.style.width || '360px',
                height: p.el.style.height || '520px'
            };
            p.el.classList.add('maximized');
        }
        // 스크롤 맨 아래로
        setTimeout(function() {
            var body = p.el.querySelector('.slack-popup-body');
            if (body) body.scrollTop = body.scrollHeight;
        }, 100);
    }

    // ============================================================
    // [v1.0] 클립보드 이미지 붙여넣기 (Ctrl+V → 캡처 전송)
    // ============================================================
    var pendingPasteData = {}; // { popupId: { blob, dataUrl } }

    function setupPasteHandler(popupEl, popupId) {
        popupEl.addEventListener('paste', function(e) {
            if (!e.clipboardData || !e.clipboardData.items) return;
            for (var i = 0; i < e.clipboardData.items.length; i++) {
                var item = e.clipboardData.items[i];
                if (item.type && item.type.indexOf('image/') === 0) {
                    e.preventDefault();
                    var blob = item.getAsFile();
                    if (!blob) continue;
                    var reader = new FileReader();
                    reader.onload = function(ev) {
                        showPastePreview(popupId, blob, ev.target.result);
                    };
                    reader.readAsDataURL(blob);
                    return;
                }
            }
        });
    }

    function showPastePreview(popupId, blob, dataUrl) {
        pendingPasteData[popupId] = { blob: blob, dataUrl: dataUrl };
        var preview = document.getElementById('slack-paste-preview-' + popupId);
        var img = document.getElementById('slack-paste-img-' + popupId);
        if (preview && img) {
            img.src = dataUrl;
            preview.classList.add('visible');
        }
    }

    function cancelPaste(popupId) {
        delete pendingPasteData[popupId];
        var preview = document.getElementById('slack-paste-preview-' + popupId);
        if (preview) preview.classList.remove('visible');
    }

    function sendPastedImage(popupId) {
        var data = pendingPasteData[popupId];
        if (!data) return;
        cancelPaste(popupId); // 프리뷰 닫기
        // 파일 이름 생성
        var now = new Date();
        var fileName = 'capture_' + now.getFullYear() +
            String(now.getMonth()+1).padStart(2,'0') +
            String(now.getDate()).padStart(2,'0') + '_' +
            String(now.getHours()).padStart(2,'0') +
            String(now.getMinutes()).padStart(2,'0') +
            String(now.getSeconds()).padStart(2,'0') + '.png';
        // File 객체 생성
        var file = new File([data.blob], fileName, { type: 'image/png' });
        file._dataUrl = data.dataUrl;
        // 기존 업로드 함수 재사용!
        uploadFileToSlack(file, popupId);
    }

    // ============================================================
    // [v1.0 fix] 실시간 폴링 — 15초마다 새 메시지 확인
    // ============================================================
    var slackPollInterval = null;

    // ============================================================
    // [v3.8] 마스터 폴링 — 통합 (기존 unread/latestTs/cache 폴링 대체)
    // ============================================================
    // 핵심 원칙:
    //   - 3초 1회 호출로 전체 unread + TOP 10 latestTs 처리
    //   - 포커스 대화는 별도 1초 Delta 폴링 유지
    //   - rate limit 거의 안 걸림, 복잡도 낮음
    //   - 실시간성: focused 1초 / others 3초
    // ============================================================
    var slackMasterInterval = null;
    var slackLastUnreadMap = {};   // { channelId: {unread, latestTs} }
    var slackLatestTsMap = {};     // { channelId: ts }
    var slackErrorStreak = 0;
    var slackLastActivityAt = Date.now();

    // [v5.11] 폴링 간격 — users.counts 쓰면 1초, GAS fallback이면 2초
    function getMasterInterval() {
        if (navigator.onLine === false) return 0;
        if (slackErrorStreak >= 3) return Math.min(60000, 5000 * slackErrorStreak);
        if (document.visibilityState === 'hidden') return 30000;
        if (Date.now() - slackLastActivityAt > 600000) return 10000;
        // Slack 직접 모드면 1초 (카톡급), GAS fallback이면 2초
        return __slackToken ? 1000 : 2000;
    }

    // [v3.8] 활성 채널 ID 선정 (서버가 latestTs 정밀 조회할 대상)
    function selectActiveChannelIds() {
        var ids = [];
        // 우선순위 1: 열린 팝업들
        openSlackPopups.forEach(function(p) {
            if (ids.indexOf(p.id) === -1) ids.push(p.id);
        });
        // 우선순위 2: 최근 timeRaw 기준 정렬
        var pool = [];
        dummyDMs.forEach(function(d) { pool.push({ id: d.id, ts: d.timeRaw || 0 }); });
        dummyChannels.forEach(function(c) { pool.push({ id: c.id, ts: c.timeRaw || 0 }); });
        pool.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
        // 빈 자리 채우기 (최대 10개)
        for (var i = 0; i < pool.length && ids.length < 10; i++) {
            if (ids.indexOf(pool[i].id) === -1) ids.push(pool[i].id);
        }
        return ids;
    }

    // [v3.8] 마스터 폴링 — 3초 1회 통합 호출
    function startSlackMasterPolling() {
        if (slackMasterInterval) clearTimeout(slackMasterInterval);
        function loop() {
            if (!slackRealMode) { slackMasterInterval = setTimeout(loop, 5000); return; }
            var delay = getMasterInterval();
            if (delay === 0) { slackMasterInterval = setTimeout(loop, 5000); return; }

            var activeIds = selectActiveChannelIds();
            window.__slackMasterPollCount = (window.__slackMasterPollCount || 0) + 1;

            // [v5.11] 응답시간 독립 타이머 + users.counts 우선
            var loopStart = Date.now();
            function scheduleNext(extraDelay) {
                var elapsed = Date.now() - loopStart;
                var waitNext = Math.max(0, (extraDelay || delay) - elapsed);
                slackMasterInterval = setTimeout(loop, waitNext);
            }
            // 1차: Slack users.counts 직접 (100~200ms, 모든 채널 unread 한방)
            pollViaUsersCounts().then(function(ok) {
                if (ok) {
                    slackErrorStreak = 0;
                    window.__slackLastMasterAt = Date.now();
                    scheduleNext();
                    return;
                }
                // 2차: GAS pollAll fallback
                google.script.run
                    .withSuccessHandler(function(res) {
                        slackErrorStreak = 0;
                        window.__slackLastMasterAt = Date.now();
                        if (res && res.success) processMasterPollResult(res);
                        scheduleNext();
                    })
                    .withFailureHandler(function(err) {
                        slackErrorStreak++;
                        scheduleNext(Math.min(60000, delay * 2));
                    })
                    .pollAll(JSON.stringify(activeIds));
            });
        }
        loop();
    }

    // [v5.11] Slack users.counts 직접 호출 — 모든 채널 unread 1회 + 100~200ms
    // [v6.10] 채널 unread 정확 동기화 — conversations.info per channel
    var __unreadInfoInProgress = false;
    async function syncChannelUnreadViaInfo() {
        if (__unreadInfoInProgress) return;
        if (!window.__slackDirect) return;
        // [v6.10.26] 채널 + DM + MPIM 모두 sync (Slack 공식앱처럼 unread 정확 표시)
        var targets = [].concat(dummyChannels || [], dummyDMs || []);
        if (targets.length === 0) return;
        __unreadInfoInProgress = true;
        try {
            var changed = 0, ok = 0, fail = 0, hasLastRead = 0, hasLatest = 0;
            var sample = null;
            for (var i = 0; i < targets.length; i++) {
                var ch = targets[i];
                if (!ch.id || !/^[CGD]/.test(ch.id)) continue; // C=channel, G=group, D=DM
                try {
                    // 1) info → last_read
                    var infoRes = await window.__slackDirect('conversations.info', { channel: ch.id, include_num_members: false });
                    if (!infoRes || !infoRes.ok || !infoRes.channel) { fail++; await new Promise(function(r){setTimeout(r,200);}); continue; }
                    var lastRead = infoRes.channel.last_read || '';
                    if (lastRead) hasLastRead++;
                    // 2) history (last_read 이후 최대 30개) — bot/system/본인 제외하고 사람 메시지만 카운트
                    var hParams = { channel: ch.id, limit: 30 };
                    if (lastRead) hParams.oldest = lastRead;
                    var histRes = await window.__slackDirect('conversations.history', hParams);
                    var latestTs = '';
                    var humanCount = 0;
                    if (histRes && histRes.ok && histRes.messages) {
                        for (var k = 0; k < histRes.messages.length; k++) {
                            var msg = histRes.messages[k];
                            if (!msg) continue;
                            if (!latestTs && msg.ts) latestTs = msg.ts;
                            if (msg.subtype) continue;          // 시스템 메시지
                            if (msg.bot_id) continue;            // 봇 메시지 (USLACKBOT, 자동 리포트 등)
                            if (msg.user === 'USLACKBOT') continue;
                            if (slackMyUserId && msg.user === slackMyUserId) continue;
                            if (lastRead && msg.ts && parseFloat(msg.ts) <= parseFloat(lastRead)) continue;
                            humanCount++;
                        }
                    }
                    if (latestTs) hasLatest++;
                    ok++;
                    // 30일 이상 안 본 채널은 "관심 없는 채널" → unread 표시 안함
                    var lastReadDays = lastRead ? (Date.now()/1000 - parseFloat(lastRead)) / 86400 : 9999;
                    var newUnread = (lastReadDays > 30) ? 0 : humanCount;
                    if (!sample) sample = { id: ch.id, name: ch.name, lastReadDays: Math.round(lastReadDays), human: humanCount, applied: newUnread };
                    if ((ch.unread||0) !== newUnread) { ch.unread = newUnread; changed++; }
                } catch(e) { fail++; }
                await new Promise(function(r) { setTimeout(r, 300); });
            }
            var unreadCount = dummyChannels.filter(function(c) { return (c.unread||0) > 0; }).length;
            console.log('[v6.10.7] unread 동기화: changed=' + changed + ' ok=' + ok + ' fail=' + fail + ' hasLR=' + hasLastRead + ' hasLT=' + hasLatest + ' unread>0=' + unreadCount + ' sample=' + JSON.stringify(sample).substring(0, 250));
            if (changed > 0) {
                try { renderSlackChatList(); updateTabCounts(); updateBrowserTitle(); } catch(e) {}
            }
        } finally { __unreadInfoInProgress = false; }
    }
    window.__syncChannelUnread = syncChannelUnreadViaInfo;
    setTimeout(syncChannelUnreadViaInfo, 15000);
    setInterval(syncChannelUnreadViaInfo, 90 * 1000);  // [v6.10.6] 5min → 90s

    async function pollViaUsersCounts() {
        if (!window.__slackDirect) return false;
        try {
            var t0 = Date.now();
            var res = await window.__slackDirect('users.counts', { only_relevant_ims: false, include_threads: false });
            if (!res || !res.ok) return false;
            var listChanged = false;
            ['channels', 'ims', 'mpims', 'groups'].forEach(function(type) {
                (res[type] || []).forEach(function(c) {
                    var meta = null;
                    for (var i=0; i<dummyDMs.length; i++) if (dummyDMs[i].id === c.id) { meta = dummyDMs[i]; break; }
                    if (!meta) for (var j=0; j<dummyChannels.length; j++) if (dummyChannels[j].id === c.id) { meta = dummyChannels[j]; break; }
                    if (!meta) return;
                    var unread = c.mention_count || 0;
                    if (c.has_unreads) unread = Math.max(unread, 1);
                    if (meta.unread !== unread) { meta.unread = unread; listChanged = true; }
                    if (c.latest && c.latest.ts) {
                        var ms = parseFloat(c.latest.ts) * 1000;
                        if (meta.timeRaw !== ms) {
                            meta.timeRaw = ms;
                            var fromName = slackUsersMap[c.latest.user] && slackUsersMap[c.latest.user].name;
                            meta.preview = (fromName ? fromName + ': ' : '') + (c.latest.text || '').substring(0, 60);
                            listChanged = true;
                        }
                    }
                });
            });
            if (listChanged) {
                try { renderSlackChatList(); } catch(e) {}
                try { updateTabCounts(); } catch(e) {}
                try { updateBrowserTitle(); } catch(e) {}
            }
            console.log('[users.counts] ' + (Date.now()-t0) + 'ms, changed=' + listChanged);
            return true;
        } catch(e) { console.log('[users.counts] fail:', e.message); return false; }
    }
    window.__pollUsersCounts = pollViaUsersCounts;

    // [v3.8] 마스터 응답 처리 (unread + latestTs 동시에)
    function processMasterPollResult(res) {
        var unreadItems = res.unreadItems || [];
        var latestItems = res.latestItems || {};
        var listChanged = false;
        // [v6.9 debug] unread > 0 카운트 (채널 unread 표시 진단)
        try {
            var unreadGt0 = unreadItems.filter(function(u) { return (u.unread || 0) > 0; });
            if (unreadGt0.length > 0 && (window.__lastUnreadCnt !== unreadGt0.length || Date.now() - (window.__lastUnreadLogAt||0) > 30000)) {
                console.log('[Master] unread>0 채널 ' + unreadGt0.length + '개:', unreadGt0.slice(0, 5).map(function(u) { return u.id + '(' + u.unread + ')'; }).join(', '));
                window.__lastUnreadCnt = unreadGt0.length;
                window.__lastUnreadLogAt = Date.now();
            }
        } catch(e) {}

        // === 1) unread 동기화 ===
        unreadItems.forEach(function(it) {
            var prev = slackLastUnreadMap[it.id];
            // unread 증가 OR Slack이 latestTs 제공 시 비교
            var isNewByUnread = false;
            if (prev) {
                if ((it.unread || 0) > (prev.unread || 0)) isNewByUnread = true;
                else if (it.latestTs && prev.latestTs && parseFloat(it.latestTs) > parseFloat(prev.latestTs)) isNewByUnread = true;
            }
            slackLastUnreadMap[it.id] = { unread: it.unread || 0, latestTs: it.latestTs || '' };

            // [v5.9] Server unread 그대로 사용 — local 누적 제거 (Slack 공식앱 read 즉시 반영)
            // [v6.10.26] 채널 + DM 모두: server unread 0 → v6.10.26 sync 값 보존, >0이면 신뢰
            var serverUnread = it.unread || 0;
            function applyUnread(arr) {
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i].id === it.id) {
                        // server가 0을 보내면 무시 (직접 sync 값 보존). >0이면 신뢰.
                        if (serverUnread === 0) break;
                        if (arr[i].unread !== serverUnread) {
                            arr[i].unread = serverUnread;
                            arr[i].unreadLocal = serverUnread;
                            listChanged = true;
                        }
                        break;
                    }
                }
            }
            applyUnread(dummyDMs);
            applyUnread(dummyChannels);

            // unread 기반 알림 (latestItems에 없는 채널용 backup)
            if (isNewByUnread && !latestItems[it.id]) {
                _fireAlertForChannel(it.id, it.latestTs, null);
            }
        });

        // === 2) latestTs 정밀 처리 (TOP 10) ===
        Object.keys(latestItems).forEach(function(chId) {
            var info = latestItems[chId];
            if (!info || !info.ts) return;
            var prevTs = slackLatestTsMap[chId];
            var currTs = parseFloat(info.ts);

            // 메타에서 초기 timeRaw 찾기
            var meta = null;
            for (var i = 0; i < dummyDMs.length; i++) if (dummyDMs[i].id === chId) { meta = dummyDMs[i]; break; }
            if (!meta) for (var j = 0; j < dummyChannels.length; j++) if (dummyChannels[j].id === chId) { meta = dummyChannels[j]; break; }
            var metaBaseTs = (meta && meta.timeRaw) ? (meta.timeRaw / 1000) : 0;

            // [v5.9] preview만 직접 갱신 — unreadLocal 누적 없이
            if (meta && currTs !== (meta._lastPreviewTs || 0)) {
                meta._lastPreviewTs = currTs;
                if (info.text || info.from) {
                    var newPreview = (info.from ? info.from + ': ' : '') + (info.text || '').substring(0, 60);
                    if (meta.preview !== newPreview) { meta.preview = newPreview; listChanged = true; }
                }
                var tsNum = parseFloat(info.ts || '0');
                if (tsNum > 0) {
                    var newMs = tsNum * 1000;
                    if (meta.timeRaw !== newMs) { meta.timeRaw = newMs; listChanged = true; }
                }
                // [v5.11] 새 메시지 시각 피드백 — 600ms 펄스
                meta._justArrived = true;
                setTimeout(function() {
                    try {
                        var el = document.querySelector('[onclick*="' + chId.replace(/'/g, "\\'") + '"]');
                        if (el && el.classList) {
                            el.classList.add('just-arrived');
                            setTimeout(function(){ el.classList.remove('just-arrived'); }, 700);
                        }
                    } catch(e) {}
                }, 50);
            }

            // 새 메시지 판정
            var isFresh = false;
            if (!prevTs) {
                if (metaBaseTs > 0 && currTs > metaBaseTs + 2) isFresh = true;
            } else {
                if (currTs > prevTs) isFresh = true;
            }
            slackLatestTsMap[chId] = currTs;
            if (!isFresh) return;
            if (info.mine) return;

            _fireAlertForChannel(chId, info.ts, info);
        });

        // 화면 갱신
        if (listChanged) {
            try { renderSlackChatList(); } catch(e) {}
            try { updateTabCounts(); } catch(e) {}
        }
    }

    // [v6.6] 이미지 클릭 → 별도 창에서 크게 보기
    // [v6.10.5] 이미지 — Slack 권한 한계로 외부 브라우저로 열기 (사용자 슬랙 세션 활용)
    // [v6.10.9] 이미지 클릭 → PC에 다운로드 → OS 기본 앱 (사진/그림판)으로 열기
    //   실패 시 (cookie 없음) → Slack 로그인 popup 자동 → 로그인 후 다시 시도
    var __slackLoginPromptShown = false;
    window.openImageInWindow = async function(imageUrl, title) {
        try {
            var T = window.__TAURI__;
            if (!T || !T.core) { window.open(imageUrl, '_blank'); return; }
            showToast('🖼 이미지 다운로드 중...');
            try {
                var savedPath = await T.core.invoke('download_and_open', {
                    url: imageUrl,
                    token: __slackToken || '',
                    nameHint: title || ''
                });
                showToast('✓ 열림: ' + (savedPath ? savedPath.split('\\').pop() : '이미지'));
            } catch(err) {
                console.warn('[v6.10.9 download fail]', err);
                if (!__slackLoginPromptShown) {
                    __slackLoginPromptShown = true;
                    showToast('💡 이미지 보려면 슬랙 로그인 필요 — 로그인 창 여는 중...');
                    setTimeout(function() {
                        T.core.invoke('open_slack_login').catch(function(){});
                    }, 600);
                } else {
                    showToast('이미지 받기 실패: ' + (err.message||err));
                }
            }
        } catch(e) { try { window.open(imageUrl, '_blank'); } catch(ee){} }
    };
    // 채팅창 안 이미지에 클릭 핸들러 자동 부착 (이벤트 위임)
    document.addEventListener('click', function(e) {
        var t = e.target;
        // 1. img 태그 직접 클릭 — permalink 우선 (외부 브라우저, 슬랙 세션 활용)
        if (t && t.tagName === 'IMG') {
            var insidePopup = !!t.closest('.slack-popup');
            if (insidePopup) {
                var url = t.dataset.permalink || t.dataset.fullUrl || t.dataset.urlPrivate || t.src;
                if (url && url.length > 10 && url.indexOf('data:') !== 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('[v6.10.5 image click]', url.substring(0, 80));
                    window.openImageInWindow(url, t.alt || '이미지');
                    return;
                }
            }
        }
        // 2. 첨부 a 태그 (Slack file link) — popup 안에서
        if (t && t.tagName === 'A') {
            var ahref = t.href || '';
            if (t.closest('.slack-popup') && (ahref.indexOf('files.slack.com') >= 0 || /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(ahref))) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[v6.9 link click]', ahref.substring(0, 80));
                window.openImageInWindow(ahref, t.textContent || '이미지');
                return;
            }
        }
        // 3. data-image-url 명시
        if (t && t.dataset && t.dataset.imageUrl) {
            e.preventDefault();
            window.openImageInWindow(t.dataset.imageUrl, t.dataset.imageTitle || '이미지');
        }
    }, true);

    // [v6.5] 채팅창 메시지 검색 — Ctrl+F or 🔍
    window.togglePopupSearch = function(popupId) {
        var p = findPopup(popupId);
        if (!p) return;
        var existing = p.el.querySelector('.popup-search-bar');
        if (existing) {
            existing.remove();
            // 모든 메시지 다시 보이게
            p.el.querySelectorAll('.msg-row, .chat-msg').forEach(function(m) { m.style.display = ''; });
            return;
        }
        var bar = document.createElement('div');
        bar.className = 'popup-search-bar';
        bar.style.cssText = 'padding:8px 12px;background:#fef3c7;border-bottom:1px solid #fde68a;display:flex;gap:8px;align-items:center;flex-shrink:0;';
        bar.innerHTML =
            '<span style="font-size:13px;">🔍</span>' +
            '<input type="text" placeholder="메시지 검색..." style="flex:1;padding:6px 10px;border:1px solid #fbbf24;border-radius:6px;font-size:13px;outline:none;" />' +
            '<button onclick="togglePopupSearch(\'' + popupId.replace(/\\/g, '\\\\').replace(/\'/g, "\\'") + '\')" style="padding:4px 8px;background:transparent;border:none;cursor:pointer;font-size:14px;">✕</button>';
        var header = p.el.querySelector('.slack-popup-header');
        if (header && header.nextSibling) header.parentNode.insertBefore(bar, header.nextSibling);
        else p.el.insertBefore(bar, p.el.firstChild);
        var inp = bar.querySelector('input');
        var counter = document.createElement('span');
        counter.style.cssText = 'font-size:11px;color:#92400e;min-width:50px;text-align:right;';
        bar.insertBefore(counter, bar.lastElementChild);
        inp.addEventListener('input', function() {
            var q = (inp.value || '').toLowerCase().trim();
            var rows = p.el.querySelectorAll('.msg-row, .chat-msg');
            var matchCount = 0;
            // 이전 highlight 제거
            p.el.querySelectorAll('mark.search-hit').forEach(function(m) {
                var parent = m.parentNode;
                if (parent) { parent.replaceChild(document.createTextNode(m.textContent), m); parent.normalize(); }
            });
            rows.forEach(function(row) {
                if (!q) { row.style.display = ''; return; }
                var t = (row.textContent || '').toLowerCase();
                var match = t.indexOf(q) !== -1;
                row.style.display = match ? '' : 'none';
                if (match) {
                    matchCount++;
                    // 텍스트 노드만 highlight
                    var textNodes = [];
                    var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
                    var node;
                    while (node = walker.nextNode()) textNodes.push(node);
                    textNodes.forEach(function(tn) {
                        var idx = tn.textContent.toLowerCase().indexOf(q);
                        if (idx < 0) return;
                        var before = tn.textContent.substring(0, idx);
                        var hit = tn.textContent.substring(idx, idx + q.length);
                        var after = tn.textContent.substring(idx + q.length);
                        var span = document.createElement('span');
                        span.appendChild(document.createTextNode(before));
                        var mark = document.createElement('mark');
                        mark.className = 'search-hit';
                        mark.style.cssText = 'background:#fde68a;padding:1px 2px;border-radius:3px;';
                        mark.textContent = hit;
                        span.appendChild(mark);
                        span.appendChild(document.createTextNode(after));
                        tn.parentNode.replaceChild(span, tn);
                    });
                }
            });
            counter.textContent = q ? (matchCount + '개') : '';
        });
        setTimeout(function() { inp.focus(); }, 50);
    };
    // Ctrl+F → focused popup의 검색
    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            if (focusedPopupId) {
                e.preventDefault();
                window.togglePopupSearch(focusedPopupId);
            }
        }
    });

    // [v6.3] 채널별 알림 mute — localStorage 저장
    var __mutedChannels = (function() {
        try { return JSON.parse(localStorage.getItem('slack_muted_channels_v1') || '{}'); }
        catch(e) { return {}; }
    })();
    function isChannelMuted(chId) { return !!__mutedChannels[chId]; }
    function setChannelMuted(chId, muted) {
        if (muted) __mutedChannels[chId] = Date.now();
        else delete __mutedChannels[chId];
        try { localStorage.setItem('slack_muted_channels_v1', JSON.stringify(__mutedChannels)); } catch(e) {}
    }
    window.toggleChannelMute = function(chId) {
        var newState = !isChannelMuted(chId);
        setChannelMuted(chId, newState);
        showToast(newState ? '🔕 알림 꺼짐' : '🔔 알림 켜짐');
        // 채팅창 헤더 버튼 갱신
        var btns = document.querySelectorAll('[data-mute-id="' + chId + '"]');
        btns.forEach(function(b) { b.textContent = newState ? '🔕' : '🔔'; b.title = newState ? '알림 켜기' : '알림 끄기'; });
    };

    // [v4.11] 중복 알림 차단 — (channelId, ts) 조합 기억 (최근 500개, 10분 TTL)
    window.__notifiedKeys = window.__notifiedKeys || {};
    var __notifiedKeys = window.__notifiedKeys;

    // ============================================================
    // [v5.0] Slack API 직접 호출 — Rust reqwest 경유 (8.5x 빠름)
    // ============================================================
    var __slackToken = null;
    async function __ensureSlackToken() {
        if (__slackToken) return __slackToken;
        var T = window.__TAURI__;
        if (!T || !T.core) return null;
        try {
            var saved = await T.core.invoke('load_slack_token');
            if (saved) { __slackToken = saved; return saved; }
        } catch(e) {}
        // 로컬에 없으면 GAS에서 1회 받음 (jsonpCall 거침)
        return new Promise(function(resolve) {
            try {
                google.script.run
                    .withSuccessHandler(function(res) {
                        // [v5.5 debug] 응답 전체 로그
                        try { console.log('[getMyToken response]', JSON.stringify(res).substring(0, 500)); } catch(e) {}
                        if (res && res.success && res.token) {
                            __slackToken = res.token;
                            T.core.invoke('save_slack_token', { token: res.token }).catch(function(){});
                            console.log('[v5.0] Slack 토큰 획득 + 로컬 저장 source=' + (res.source||'?'));
                            resolve(res.token);
                        } else {
                            console.warn('[getMyToken FAIL]', res && res.error, 'debug=', res && res.debug);
                            resolve(null);
                        }
                    })
                    .withFailureHandler(function(e){ console.warn('[getMyToken err]', e); resolve(null); })
                    .getMyToken();
            } catch(e) { resolve(null); }
        });
    }
    window.__slackDirect = async function(method, params) {
        var token = await __ensureSlackToken();
        if (!token) throw new Error('토큰 없음');
        var T = window.__TAURI__;
        return await T.core.invoke('slack_api', { method: method, token: token, params: params || {} });
    };
    // 백그라운드: 즉시 토큰 가져옴 (지연 없음 → prefetch가 Slack 직접 모드로 시작)
    __ensureSlackToken().then(function(t) { if (t) console.log('[v5.0] 토큰 로딩 완료 — Slack 직접 모드'); });

    // [v6.4] 사용자 프로필 사진 캐시 — users.list 1회 호출 후 image URL 저장
    var __slackUserImages = {};
    try {
        var cachedImg = localStorage.getItem('slack_user_images_v1');
        if (cachedImg) __slackUserImages = JSON.parse(cachedImg) || {};
    } catch(e) {}
    window.getSlackUserImage = function(uid) { return __slackUserImages[uid] || ''; };
    async function loadSlackUserImages() {
        try {
            if (!window.__slackDirect) return;
            var res = await window.__slackDirect('users.list', { limit: 1000 });
            if (!res || !res.ok || !Array.isArray(res.members)) return;
            var changed = false;
            res.members.forEach(function(u) {
                if (u.deleted) return;
                var img = (u.profile && (u.profile.image_72 || u.profile.image_48 || u.profile.image_24)) || '';
                if (img && __slackUserImages[u.id] !== img) {
                    __slackUserImages[u.id] = img;
                    changed = true;
                }
            });
            if (changed) {
                try { localStorage.setItem('slack_user_images_v1', JSON.stringify(__slackUserImages)); } catch(e) {}
                try { renderSlackChatList(); } catch(e) {}
                console.log('[v6.4] 사용자 프로필 사진 ' + Object.keys(__slackUserImages).length + '개 캐시');
            }
        } catch(e) { console.warn('[v6.4 user images]', e); }
    }
    setTimeout(loadSlackUserImages, 5000); // 토큰 로드 후 5초 뒤
    // 12시간마다 갱신 (사진 바뀐 사람 반영)
    setInterval(loadSlackUserImages, 12 * 3600 * 1000);

    // [v6.7] 채널/캔버스 멤버 캐시 — 검색 시 멤버 이름 매칭용
    var __channelMembers = {};
    try {
        var cached = localStorage.getItem('slack_channel_members_v1');
        if (cached) __channelMembers = JSON.parse(cached) || {};
    } catch(e) {}
    function getChannelMemberNames(chId) { return __channelMembers[chId] || []; }
    window.getChannelMemberNames = getChannelMemberNames;
    async function loadChannelMembersBatch() {
        console.log('[v6.7] 멤버 캐시 시작...');
        try {
            if (!window.__slackDirect) { console.warn('[v6.7] __slackDirect 없음'); return; }
            // 채널 + group DM
            var targets = [];
            (dummyChannels || []).forEach(function(c) { if (c.id && /^[CG]/.test(c.id)) targets.push({ id: c.id, name: c.name, kind: 'channel' }); });
            (dummyDMs || []).forEach(function(d) { if (d.id && d.isGroup && /^G/.test(d.id)) targets.push({ id: d.id, name: d.name, kind: 'mpim' }); });
            // [v6.9] 캔버스 — files.info로 editors/user 수집
            (dummyCanvases || []).forEach(function(c) {
                var fid = (c.id && c.id.indexOf('cv_F') === 0) ? c.id.substring(3) : (c.fileId || '');
                if (fid) targets.push({ id: c.id, fileId: fid, name: c.name, kind: 'canvas' });
            });
            console.log('[v6.7] 대상(C/G):', targets.filter(function(t){return t.kind!=='canvas';}).length, '캔버스:', targets.filter(function(t){return t.kind==='canvas';}).length);
            var ok = 0, err = 0, skip = 0;
            var firstErrors = [];
            for (var i = 0; i < targets.length; i++) {
                var ch = targets[i];
                if (__channelMembers[ch.id] && __channelMembers[ch.id].length > 0) { skip++; continue; }
                try {
                    var res, members = [];
                    if (ch.kind === 'canvas') {
                        // [v6.10] 캔버스: files:read scope 없음 → channelIds 통한 채널 멤버 합집합
                        var cvObj = (dummyCanvases||[]).find(function(c) { return c.id === ch.id; });
                        var cvChIds = (cvObj && cvObj.channelIds) || [];
                        var unionNames = {};
                        // participants 먼저 (만든 사람, editors)
                        (cvObj && cvObj.participants || []).forEach(function(n) { unionNames[n] = 1; });
                        // 그 다음 share된 채널들의 멤버 — 캐시에 있는 것만
                        cvChIds.forEach(function(chId) {
                            (__channelMembers[chId] || []).forEach(function(n) { unionNames[n] = 1; });
                        });
                        members = Object.keys(unionNames);
                        // 가짜 res ok 만들기 (위 분기 통과용)
                        res = { ok: true };
                    } else {
                        res = await window.__slackDirect('conversations.members', { channel: ch.id, limit: 100 });
                        if (res && res.ok && Array.isArray(res.members)) members = res.members;
                    }
                    if (res && res.ok) {
                        var names = members.map(function(uid) {
                            return (slackUsersMap[uid] && slackUsersMap[uid].name) || '';
                        }).filter(function(n) { return !!n; });
                        __channelMembers[ch.id] = names;
                        ok++;
                        if (ok % 10 === 0) {
                            try { localStorage.setItem('slack_channel_members_v1', JSON.stringify(__channelMembers)); } catch(e) {}
                        }
                    } else {
                        err++;
                        if (firstErrors.length < 3) firstErrors.push(ch.id + ':' + (res && res.error || 'no res'));
                    }
                } catch(e) {
                    err++;
                    if (firstErrors.length < 3) firstErrors.push(ch.id + ':except:' + (e.message||e));
                }
                await new Promise(function(r) { setTimeout(r, 400); });
            }
            try { localStorage.setItem('slack_channel_members_v1', JSON.stringify(__channelMembers)); } catch(e) {}
            console.log('[v6.7] 캐시 완료: ok=' + ok + ' err=' + err + ' skip=' + skip + ' / total cache=' + Object.keys(__channelMembers).length + ' firstErr=' + firstErrors.join(' / '));
        } catch(e) { console.warn('[v6.7]', e); }
    }
    // 데이터 로딩 후 시작 (dummyCanvases 등 채워질 때까지 polling)
    var __memCacheTries = 0;
    function tryStartMemberCache() {
        __memCacheTries++;
        var ready = (dummyChannels && dummyChannels.length > 0) || __memCacheTries > 20;
        if (!ready) { setTimeout(tryStartMemberCache, 3000); return; }
        // 1차 즉시 (현재 데이터로)
        loadChannelMembersBatch();
        // 2차: 30초 후 (캔버스가 늦게 도착하는 경우 대비)
        setTimeout(loadChannelMembersBatch, 30000);
        // 주기 (12시간) 갱신
        setInterval(loadChannelMembersBatch, 12 * 3600 * 1000);
    }
    setTimeout(tryStartMemberCache, 5000);

    // [v6.0] Socket Mode — xapp token 있으면 WebSocket 시작 → 실시간 push
    if (location.search.indexOf('chatWindow=1') === -1) {
        setTimeout(function() {
            (async function() {
                var T = window.__TAURI__;
                var dbg = function(msg) {
                    console.log('[v6.0]', msg);
                    try { T && T.core && T.core.invoke('write_feedback', { name: 'socket_init', content: JSON.stringify({ts: new Date().toISOString(), msg: msg}) }); } catch(e){}
                };
                try {
                    if (!T || !T.core || !T.core.invoke) { dbg('Tauri 없음'); return; }
                    var inv = T.core.invoke;
                    dbg('load_xapp_token 호출');
                    var xtok = await inv('load_xapp_token');
                    if (!xtok) { dbg('xapp 토큰 없음 (Socket Mode 비활성)'); return; }
                    dbg('xapp 토큰 길이=' + xtok.length + ' Socket Mode 시작 invoke...');
                    if (T.event && T.event.listen) {
                        T.event.listen('socket-status', function(ev) { dbg('socket-status: ' + JSON.stringify(ev.payload)); });
                        T.event.listen('slack-event', function(ev) {
                            try { handleSlackSocketEvent(ev.payload); }
                            catch(e) { dbg('handle 오류: ' + e.message); }
                        });
                    }
                    var r = await inv('start_socket_mode', { xappToken: xtok });
                    dbg('start_socket_mode 결과: ' + r);
                } catch(e) { dbg('Socket Mode 시작 실패: ' + (e.message || e)); }
            })();
        }, 3000); // 3초 후 시작 — 메인 폴링 안정화 후
    }

    // Socket Mode 이벤트 처리 (message + channel_marked + im_marked)
    function handleSlackSocketEvent(payload) {
        try {
            if (!payload || typeof payload !== 'object') return;
            // hello/disconnect 등 envelope-less 이벤트
            if (payload.type === 'hello' || payload.type === 'disconnect') {
                console.log('[v6.0]', payload.type);
                return;
            }
            // events_api 형식: { envelope_id, type:'events_api', payload:{event:{...}} }
            var ev = (payload.payload && payload.payload.event) || payload.event || payload;
            if (!ev) return;
            // 채널 read 마크 이벤트 → 우리 unread 즉시 0
            if (ev.type === 'channel_marked' || ev.type === 'im_marked' || ev.type === 'group_marked' || ev.type === 'mpim_marked') {
                var chId = ev.channel;
                if (!chId) return;
                [dummyDMs, dummyChannels].forEach(function(arr) {
                    if (!Array.isArray(arr)) return;
                    arr.forEach(function(it) { if (it.id === chId) { it.unread = 0; it.unreadLocal = 0; } });
                });
                if (slackLastUnreadMap[chId]) slackLastUnreadMap[chId].unread = 0;
                try { renderSlackChatList(); updateTabCounts(); updateBrowserTitle(); } catch(e) {}
                return;
            }
            if (ev.type !== 'message') return;
            // 봇/edit/내가 보낸 것 무시
            if (ev.subtype && ev.subtype !== 'file_share') return;
            if (ev.user === slackMyUserId) return;
            var chId = ev.channel;
            if (!chId) return;
            var ts = ev.ts;
            var fromName = (slackUsersMap[ev.user] && slackUsersMap[ev.user].name) || ev.username || ev.user || '';
            var text = ev.text || '';
            console.log('[v6.0 message]', chId, fromName, text.substring(0, 30));

            // 채팅 목록 즉시 갱신 + unread 증가 (focused 아니고 본인 아닌 경우)
            try {
                updateChatListOrder(chId, { from: fromName, text: text, ts: ts, mine: false });
                // [v6.1] Socket 새 메시지 → unread + 1 (focused 채널 제외)
                if (chId !== focusedPopupId) {
                    [dummyDMs, dummyChannels].forEach(function(arr) {
                        if (!Array.isArray(arr)) return;
                        for (var i=0; i<arr.length; i++) {
                            if (arr[i].id === chId) {
                                arr[i].unread = (arr[i].unread || 0) + 1;
                                break;
                            }
                        }
                    });
                    try { renderSlackChatList(); updateTabCounts(); updateBrowserTitle(); } catch(e) {}
                }
            } catch(e) {}
            // 알림 (중복 차단 + mute 체크 + 멘션 강조)
            try {
                if (typeof isChannelMuted === 'function' && isChannelMuted(chId)) {
                    // mute된 채널은 알림 스킵 (배지/목록은 정상 갱신)
                } else
                if (typeof __shouldNotifyImpl === 'function' && __shouldNotifyImpl(chId, ts)) {
                    var meta = null;
                    for (var i=0; i<dummyDMs.length; i++) if (dummyDMs[i].id === chId) { meta = dummyDMs[i]; break; }
                    if (!meta) for (var j=0; j<dummyChannels.length; j++) if (dummyChannels[j].id === chId) { meta = dummyChannels[j]; break; }
                    var displayName = (meta && meta.name) || fromName;
                    // [v6.1] 멘션 감지 — <@MYUSERID> 또는 본인 이름
                    var isMention = false;
                    try {
                        if (slackMyUserId && text.indexOf('<@' + slackMyUserId + '>') >= 0) isMention = true;
                        if (text.indexOf('<!channel>') >= 0 || text.indexOf('<!here>') >= 0 || text.indexOf('<!everyone>') >= 0) isMention = true;
                    } catch(e) {}
                    var notifTitle = (isMention ? '⭐ ' : '') + displayName;
                    var notifBody = fromName + ': ' + text;
                    showDesktopNotification(notifTitle, notifBody);
                    startTabFlash(fromName, text);
                    try { playSlackDing(); if (isMention) setTimeout(function(){ try { playSlackDing(); } catch(e){} }, 300); } catch(e) {}
                }
            } catch(e) {}
            // 채팅 창 열려있으면 메시지 추가
            try {
                var fp = findPopup(chId);
                if (fp) {
                    var msgs = dummyMessagesMap[chId] || [];
                    var dup = msgs.some(function(m){ return m.ts === ts; });
                    if (!dup) {
                        msgs.push({
                            id: 'm_' + ts, ts: ts, from: fromName, fromId: ev.user,
                            text: text, mine: false, files: ev.files || []
                        });
                        dummyMessagesMap[chId] = msgs;
                        renderPopupMessages(fp.el, chId);
                        try { saveSlackMessagesToStorage(chId); } catch(e) {}
                    }
                }
            } catch(e) {}
        } catch(e) { console.warn('[v6.0 handle]', e); }
    }
    window.__handleSlackSocketEvent = handleSlackSocketEvent;
    function __shouldNotifyImpl(channelId, ts) {
        if (!channelId || !ts) return true; // ts 없으면 차단 못함 (안전하게 허용)
        var key = channelId + '|' + String(ts);
        if (__notifiedKeys[key]) {
            console.log('[알림 중복 차단]', key);
            return false;
        }
        __notifiedKeys[key] = Date.now();
        // 정리: 오래된 entry 삭제
        var cutoff = Date.now() - 600000;
        var keys = Object.keys(__notifiedKeys);
        if (keys.length > 500) {
            keys.forEach(function(k) { if (__notifiedKeys[k] < cutoff) delete __notifiedKeys[k]; });
        }
        return true;
    }

    // [v5.0 fix] 함수 정의 후 window에 안전 노출 (re-entrant 회피)
    window.__shouldNotify = __shouldNotifyImpl;

    // [v3.8] 알림 발사 통합 함수
    function _fireAlertForChannel(channelId, latestTs, infoOpt) {
        // [v4.11] 중복 차단 — 같은 메시지 두번 알림 방지
        var dedupTs = (infoOpt && infoOpt.ts) || latestTs || '';
        if (!__shouldNotifyImpl(channelId, dedupTs)) return;
        // [v6.3] mute 체크 — 배지는 갱신되지만 알림 스킵
        if (typeof isChannelMuted === 'function' && isChannelMuted(channelId)) return;
        // 메타 조회
        var meta = null;
        for (var i = 0; i < dummyDMs.length; i++) if (dummyDMs[i].id === channelId) { meta = dummyDMs[i]; break; }
        if (!meta) for (var j = 0; j < dummyChannels.length; j++) if (dummyChannels[j].id === channelId) { meta = dummyChannels[j]; break; }
        if (!meta) return;

        // 정보가 이미 있으면 즉시 알림
        if (infoOpt) {
            var popup = findPopup(channelId);
            var displayText = (typeof convertEmojiCodes === 'function') ? convertEmojiCodes(infoOpt.text || '') : (infoOpt.text || '');
            var senderName = infoOpt.from || meta.name || '새 메시지';
            if (!popup || popup.minimized) {
                try { startTabFlash(senderName, displayText); } catch(e) {}
                try { showInAppToast(senderName, displayText, channelId); } catch(e) {}
                try { playSlackDing(); } catch(e) {}
                window.__slackTotalAlerts = (window.__slackTotalAlerts || 0) + 1;
            }
            try {
                updateChatListOrder(channelId, {
                    from: infoOpt.from || '',
                    text: infoOpt.text || '',
                    time: formatTsBrief(infoOpt.ts),
                    ts: infoOpt.ts,
                    mine: false
                });
            } catch(e) {}
            return;
        }

        // 정보 없으면 서버에서 가져옴 (unread 기반 backup)
        google.script.run
            .withSuccessHandler(function(r) {
                if (!r || !r.success) return;
                var msgs = r.newMessages || [];
                if (msgs.length === 0) return;
                var lastMsg = msgs[msgs.length - 1];
                if (lastMsg.mine) return;
                try { updateChatListOrder(channelId, lastMsg); } catch(e) {}
                var popup = findPopup(channelId);
                if (!popup || popup.minimized) {
                    var displayText = (typeof convertEmojiCodes === 'function') ? convertEmojiCodes(lastMsg.text || '') : (lastMsg.text || '');
                    var senderName = lastMsg.from || meta.name;
                    try { startTabFlash(senderName, displayText); } catch(e) {}
                    try { showInAppToast(senderName, displayText, channelId); } catch(e) {}
                    try { playSlackDing(); } catch(e) {}
                    window.__slackTotalAlerts = (window.__slackTotalAlerts || 0) + 1;
                }
            })
            .getSlackNewMessages(channelId, latestTs ? String(parseFloat(latestTs) - 1) : '0');
    }

    // 사용자 활동 감지
    document.addEventListener('mousemove', function() { slackLastActivityAt = Date.now(); }, { passive: true });
    document.addEventListener('keydown', function() { slackLastActivityAt = Date.now(); }, { passive: true });

    // 간단한 ts 포맷
    function formatTsBrief(ts) {
        try {
            var d = new Date(parseFloat(ts) * 1000);
            var hh = String(d.getHours()).padStart(2, '0');
            var mm = String(d.getMinutes()).padStart(2, '0');
            return hh + ':' + mm;
        } catch(e) { return ''; }
    }

    // ============================================================
    // [v3.8] 폴링 통합 — Master + Delta 2종만
    // ============================================================
    function startSlackPolling() {
        if (slackPollInterval) clearInterval(slackPollInterval);
        if (slackDeltaInterval) clearInterval(slackDeltaInterval);

        // [v4.11] 채팅 전용 창(chatWindow=1)은 폴링/알림 비활성 — 메인 창이 전담
        var __isChatWin = location.search.indexOf('chatWindow=1') >= 0;
        if (__isChatWin) {
            console.log('[v4.11] chat-window 모드 — 폴링/알림 비활성화');
            return;
        }

        // === 1. Master 폴링 (3초) — unread + top 10 latestTs ===
        startSlackMasterPolling();

        // === 2. Focus Delta 폴링 (1초) — 열린 대화방 실시간 ===
        slackDeltaInterval = setInterval(async function() {
            if (!slackRealMode || !focusedPopupId) return;
            var fp = findPopup(focusedPopupId);
            if (!fp || fp.minimized) return;
            var msgs = dummyMessagesMap[focusedPopupId] || [];
            var lastTs = msgs.length > 0 ? msgs[msgs.length - 1].ts : '0';
            // [v5.1] Slack 직접 호출 (200ms) — 실패 시 GAS fallback
            try {
                if (window.__slackDirect) {
                    var oldest = lastTs && lastTs !== '0' ? String(parseFloat(lastTs)) : '0';
                    var res = await window.__slackDirect('conversations.history', { channel: focusedPopupId, oldest: oldest, limit: 30, inclusive: false });
                    if (res && res.ok && Array.isArray(res.messages)) {
                        var newMsgsRaw = res.messages.slice().reverse();
                        var existing = dummyMessagesMap[focusedPopupId] || [];
                        var existingTs = {};
                        existing.forEach(function(m) { existingTs[m.ts] = true; });
                        var added = false;
                        newMsgsRaw.forEach(function(m) {
                            if (existingTs[m.ts]) return;
                            var fmtMsg = {
                                id: 'm_' + m.ts, ts: m.ts,
                                from: (slackUsersMap[m.user] && slackUsersMap[m.user].name) || m.username || m.user || '',
                                fromId: m.user || '',
                                text: m.text || '', time: '',
                                mine: m.user === slackMyUserId, files: m.files || []
                            };
                            existing.push(fmtMsg);
                            added = true;
                            if (!fmtMsg.mine) {
                                startTabFlash(fmtMsg.from, fmtMsg.text);
                                try { playSlackDing(); } catch(e) {}
                                try { showInAppToast(fmtMsg.from, fmtMsg.text, focusedPopupId); } catch(e) {}
                            }
                        });
                        if (added) {
                            dummyMessagesMap[focusedPopupId] = existing;
                            renderPopupMessages(fp.el, focusedPopupId);
                            try { updateChatListOrder(focusedPopupId, existing[existing.length-1]); } catch(e) {}
                            try { saveSlackMessagesToStorage(focusedPopupId); } catch(e) {}
                        }
                        return;
                    }
                }
            } catch(e) { console.log('[Delta] Slack 직접 실패, GAS fallback', e.message); }
            // GAS fallback (토큰 없거나 Slack 직접 실패 시)
            google.script.run
                .withSuccessHandler(function(res) {
                    if (!res || !res.success) return;
                    var newMsgs = res.newMessages || [];
                    if (newMsgs.length === 0) return;
                    var existing = dummyMessagesMap[focusedPopupId] || [];
                    var existingTs = {};
                    existing.forEach(function(m) { existingTs[m.ts] = true; });
                    var added = false;
                    newMsgs.forEach(function(m) {
                        if (!existingTs[m.ts]) {
                            existing.push(m);
                            added = true;
                            if (!m.mine) {
                                startTabFlash(m.from, m.text);
                                try { playSlackDing(); } catch(e) {}
                                try { showInAppToast(m.from, m.text, focusedPopupId); } catch(e) {}
                            }
                        }
                    });
                    if (added) {
                        dummyMessagesMap[focusedPopupId] = existing;
                        renderPopupMessages(fp.el, focusedPopupId);
                        try { updateChatListOrder(focusedPopupId, newMsgs[newMsgs.length - 1]); } catch(e) {}
                        try { saveSlackMessagesToStorage(focusedPopupId); } catch(e) {}
                    }
                })
                .getSlackNewMessages(focusedPopupId, lastTs);
        }, 1000);
    }

    // [v2.9] 팝업 포커스 추적 — 클릭/입력 시 해당 팝업을 "대화 중"으로
    function setFocusedPopup(popupId) {
        focusedPopupId = popupId;
    }

    // [v3.0] 스레드 답글 로드 — 클릭 시 펼침
    function loadThreadReplies(channelId, threadTs, barEl) {
        var replyContainer = document.getElementById('thread-' + threadTs.replace('.', '-'));
        if (!replyContainer) return;
        // 토글: 이미 열려있으면 닫기
        if (replyContainer.style.display !== 'none') {
            replyContainer.style.display = 'none';
            return;
        }
        replyContainer.style.display = 'block';
        replyContainer.innerHTML = '<div style="padding:8px;color:#64748b;font-size:11px;">답글 불러오는 중...</div>';
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success || !res.replies || res.replies.length === 0) {
                    replyContainer.innerHTML = '<div style="padding:8px;color:#94a3b8;font-size:11px;">답글이 없습니다</div>';
                    return;
                }
                var html = '';
                res.replies.forEach(function(r) {
                    var avatarStyle = 'background:' + avatarColorFromName(r.from) + ';';
                    html +=
                        '<div class="msg-thread-reply">' +
                            '<div class="msg-thread-reply-avatar" style="' + avatarStyle + '">' + firstCharOf(r.from) + '</div>' +
                            '<div class="msg-thread-reply-content">' +
                                '<span class="msg-thread-reply-name">' + escapeHtml(r.from) + '</span>' +
                                '<span class="msg-thread-reply-time">' + escapeHtml(r.time) + '</span>' +
                                '<div class="msg-thread-reply-text">' + escapeHtml(r.text) + '</div>' +
                            '</div>' +
                        '</div>';
                });
                replyContainer.innerHTML = html;
            })
            .withFailureHandler(function() {
                replyContainer.innerHTML = '<div style="padding:8px;color:#ef4444;font-size:11px;">답글 로딩 실패</div>';
            })
            .getSlackThreadReplies(channelId, threadTs);
    }

    // [v3.0] 첫 번째 구독 스레드로 스크롤
    function scrollToFirstThread(channelId) {
        var p = findPopup(channelId);
        if (!p) return;
        var body = p.el.querySelector('.slack-popup-body');
        if (!body) return;
        var firstThread = body.querySelector('.msg-thread-bar.subscribed');
        if (firstThread) {
            firstThread.scrollIntoView({ behavior: 'smooth', block: 'center' });
            firstThread.style.animation = 'none';
            setTimeout(function() { firstThread.style.animation = 'threadPulse 1s ease 3'; }, 10);
        }
    }

    // [v3.0] Slack 앱에서 열기 (팝아웃 대화창)
    // Ctrl+클릭하면 Slack 앱에서 대화창만 단독으로 열 수 있어요!
    function openInSlackApp(channelId) {
        var slackUrl = 'slack://channel?team=T1RV5MJFK&id=' + channelId;
        window.open(slackUrl);
        showToast('Slack 앱에서 열었어요! (Ctrl+클릭 → 단독 창)');
    }

    // [v2.9] 즉시 Delta 폴링 (전송 직후 빠른 응답 확인용)
    function quickDeltaPoll(channelId, afterTs) {
        var fp = findPopup(channelId);
        if (!fp) return;
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                var newMsgs = res.newMessages || [];
                if (newMsgs.length === 0) return;
                var existing = dummyMessagesMap[channelId] || [];
                var existingTs = {};
                existing.forEach(function(m) { existingTs[m.ts] = true; });
                var added = false;
                newMsgs.forEach(function(m) {
                    if (!existingTs[m.ts]) {
                        existing.push(m);
                        added = true;
                        if (!m.mine) {
                            startTabFlash(m.from, m.text);
                            try { playSlackDing(); } catch(e) {}
                            // [v3.4] 좌측 하단 인앱 토스트
                            try { showInAppToast(m.from, m.text, channelId); } catch(e) {}
                        }
                    }
                });
                if (added) {
                    dummyMessagesMap[channelId] = existing;
                    renderPopupMessages(fp.el, channelId);
                    // [v3.4] 대화 목록 재정렬
                    try { updateChatListOrder(channelId, newMsgs[newMsgs.length - 1]); } catch(e) {}
                    try { saveSlackMessagesToStorage(channelId); } catch(e) {}
                }
            })
            .getSlackNewMessages(channelId, afterTs);
    }

    function refreshUnreadCounts() {
        // 목록 미리보기 + 정렬도 백그라운드에서 다시 로드
        var allIds = [];
        dummyDMs.forEach(function(d) { allIds.push(d.id); });
        dummyChannels.forEach(function(c) { allIds.push(c.id); });
        if (allIds.length === 0) return;
        var batch = allIds.slice(0, 20);
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success || !res.results) return;
                var changed = false;
                dummyDMs.forEach(function(d) {
                    if (res.results[d.id]) {
                        var r = res.results[d.id];
                        if (r.timeRaw > (d.timeRaw || 0)) {
                            d.preview = r.preview || d.preview;
                            d.time = r.time || d.time;
                            d.timeRaw = r.timeRaw || d.timeRaw;
                            changed = true;
                        }
                    }
                });
                dummyChannels.forEach(function(c) {
                    if (res.results[c.id]) {
                        var r = res.results[c.id];
                        if (r.timeRaw > (c.timeRaw || 0)) {
                            c.preview = r.preview || c.preview;
                            c.time = r.time || c.time;
                            c.timeRaw = r.timeRaw || c.timeRaw;
                            changed = true;
                        }
                    }
                });
                if (changed) {
                    renderSlackChatList();
                    updateBrowserTitle();
                }
            })
            .getLastMessagesBatch(JSON.stringify(batch));
    }

    // [v1.0] 알림 소리
    function playSlackDing() {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        var ctx = new AC();
        var now = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
        gain.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.35);
        // 두 번째 톤
        var osc2 = ctx.createOscillator();
        var gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1108;
        osc2.type = 'sine';
        gain2.gain.setValueAtTime(0, now + 0.35);
        gain2.gain.linearRampToValueAtTime(0.2, now + 0.37);
        gain2.gain.linearRampToValueAtTime(0, now + 0.7);
        osc2.start(now + 0.35);
        osc2.stop(now + 0.75);
    }

    // [v5.2] 자동 시작 토글
    window.toggleAutostart = async function() {
        try {
            var as = window.__TAURI__ && window.__TAURI__.autostart;
            if (!as) { showToast('Autostart 미지원'); return; }
            var enabled = await as.isEnabled();
            if (enabled) {
                await as.disable();
                showToast('자동 시작 OFF');
            } else {
                await as.enable();
                showToast('자동 시작 ON — 부팅 시 트레이에서 실행됨');
            }
            // 메뉴 항목 갱신
            setTimeout(function() {
                as.isEnabled().then(function(e) {
                    var m = document.getElementById('autostartMenuItem');
                    if (m) m.textContent = (e ? '⏰✓ ' : '⏰ ') + 'Windows 시작 시 자동 실행';
                });
            }, 200);
        } catch(e) { showToast('자동시작 오류: ' + (e.message||e)); }
    };
    // 시작 시 메뉴 라벨에 현재 상태 반영
    setTimeout(function() {
        try {
            var as = window.__TAURI__ && window.__TAURI__.autostart;
            if (as && as.isEnabled) as.isEnabled().then(function(e) {
                var m = document.getElementById('autostartMenuItem');
                if (m) m.textContent = (e ? '⏰✓ ' : '⏰ ') + 'Windows 시작 시 자동 실행';
            });
        } catch(e) {}
    }, 3000);

    // [v4.13] 설정 드롭다운 메뉴
    window.toggleSettingsMenu = function(e) {
        if (e) { e.stopPropagation(); }
        var dd = document.getElementById('settingsDropdown');
        if (!dd) return;
        dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
        if (dd.style.display === 'block') {
            setTimeout(function() {
                document.addEventListener('click', closeSettingsOnOutside, { once: true });
            }, 0);
        }
    };
    window.closeSettingsMenu = function() {
        var dd = document.getElementById('settingsDropdown');
        if (dd) dd.style.display = 'none';
    };
    function closeSettingsOnOutside(e) {
        var dd = document.getElementById('settingsDropdown');
        if (!dd || dd.style.display !== 'block') return;
        if (!dd.contains(e.target)) { dd.style.display = 'none'; }
    }

    // [v1.7] 수동 새로고침 — 캐시 강제 삭제 + 재로드
    function manualRefresh() {
        if (!slackRealMode) {
            showToast('Slack 연동 후 사용 가능');
            return;
        }
        showToast('캐시 초기화 + 새로고침...');
        google.script.run
            .withSuccessHandler(function() {
                loadRealSlackData();
            })
            .clearSlackCache();
    }

    // [v0.5] 테스트용 새 메시지 시뮬레이션
    function simulateNewMessage() {
        var targets = ['dm1', 'dm_group1', 'ch1', 'ch3'];
        var targetId = targets[Math.floor(Math.random() * targets.length)];
        var senders = ['박승호', '김성환', '홍완식', '배현희'];
        var sender = senders[Math.floor(Math.random() * senders.length)];
        var texts = [
            '회의 시간 변경 가능할까요?',
            '자료 확인 부탁드립니다',
            '확인했습니다 👍',
            '내일 뵙겠습니다',
            '방금 보낸 파일 봐주세요',
            '@나 체크 부탁해요'
        ];
        var text = texts[Math.floor(Math.random() * texts.length)];
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var newMsg = {
            id: 'm_sim_' + Date.now(),
            from: sender,
            text: text,
            time: hh + ':' + mm,
            mine: false,
            ts: String(now.getTime() / 1000)
        };
        addMessageToChat(targetId, newMsg, { notify: true });
        showToast('시뮬: ' + sender + '님 → ' + targetId);
    }
</script>
