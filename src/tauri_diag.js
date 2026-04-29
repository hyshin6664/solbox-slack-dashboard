// Tauri 네이티브 진단 모듈 — 우상단 🔧 버튼으로 상태 확인
(function() {
    'use strict';
    if (typeof window.__TAURI__ === 'undefined' && typeof window.__TAURI_INTERNALS__ === 'undefined') return;

    var T = window.__TAURI__ || {};

    // [Tauri] window.open → shell.open (외부 브라우저에서 열기, 카톡 링크 미리보기처럼 매끄럽게)
    try {
        var origOpen = window.open;
        window.open = function(url, target) {
            try {
                var u = String(url || '');
                if (/^https?:|^mailto:|^slack:/.test(u) && T.shell && T.shell.open) {
                    T.shell.open(u);
                    return null;
                }
            } catch(e) {}
            return origOpen.apply(window, arguments);
        };
    } catch(e) {}
    var results = [];
    var add = function(name, ok, detail) { results.push({ name: name, ok: ok, detail: detail || '' }); };

    async function runChecks() {
        results = [];
        // 1. Tauri 전역
        add('Tauri 전역 주입', !!window.__TAURI__, 'withGlobalTauri=true');
        add('Tauri internals', !!window.__TAURI_INTERNALS__, '');

        // 2. OS / 플랫폼
        try {
            var os = T.os || (T.core && T.core.os);
            if (os && os.platform) {
                var p = await os.platform();
                add('플랫폼', true, String(p));
            } else {
                add('플랫폼', true, 'Windows (UA 기반)');
            }
        } catch(e) { add('플랫폼', false, e.message); }

        // 3. 알림 플러그인
        try {
            var notif = T.notification || (window.__TAURI_PLUGIN_NOTIFICATION__);
            if (notif && notif.isPermissionGranted) {
                var granted = await notif.isPermissionGranted();
                if (!granted && notif.requestPermission) {
                    var perm = await notif.requestPermission();
                    granted = (perm === 'granted');
                }
                add('알림 권한', granted, granted ? 'granted' : 'denied');
            } else {
                add('알림 플러그인', false, 'notification API 접근 불가');
            }
        } catch(e) { add('알림 권한', false, e.message); }

        // 4. 쉘 플러그인 (URL 열기)
        try {
            var shell = T.shell || (window.__TAURI_PLUGIN_SHELL__);
            add('쉘(Shell) 플러그인', !!(shell && shell.open), shell ? 'open 사용 가능' : '불가');
        } catch(e) { add('쉘 플러그인', false, e.message); }

        // 5. 대화상자 플러그인
        try {
            var dlg = T.dialog || (window.__TAURI_PLUGIN_DIALOG__);
            add('대화상자 플러그인', !!(dlg && (dlg.message || dlg.ask)), dlg ? 'message/ask 사용 가능' : '불가');
        } catch(e) { add('대화상자 플러그인', false, e.message); }

        // 6. 창 제어
        try {
            var win = T.window || (T.webviewWindow) || null;
            add('창 제어 API', !!win, win ? 'window API 사용 가능' : '불가');
        } catch(e) { add('창 제어', false, e.message); }

        // 7. 네트워크 (Slack 접근)
        try {
            var r = await fetch('https://slack.com/api/api.test', { method: 'GET' });
            add('Slack 네트워크', r.ok, 'HTTP ' + r.status);
        } catch(e) { add('Slack 네트워크', false, e.message); }

        // 8. Apps Script 접근
        try {
            var gasUrl = (window.GAS_URL || (window.google && google.script && '(proxy)') || null);
            add('Apps Script URL', !!gasUrl, gasUrl ? String(gasUrl).slice(0, 60) : '미설정');
        } catch(e) { add('Apps Script', false, e.message); }

        // 9. SingleInstance / WebView
        add('WebView2 (렌더러)', true, navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] || '미확인');

        // 10. localStorage 진단 — 캐시 저장/공유 확인
        try {
            var lsKeys = Object.keys(localStorage || {});
            var msgKey = lsKeys.filter(function(k) { return k.indexOf('slack') >= 0 && k.indexOf('msg') >= 0; })[0];
            var msgData = msgKey ? localStorage.getItem(msgKey) : null;
            var msgCount = 0;
            if (msgData) { try { msgCount = Object.keys(JSON.parse(msgData) || {}).length; } catch(e) {} }
            add('localStorage 캐시', !!msgKey, msgKey ? (msgKey + ': ' + msgCount + '채널, ' + (msgData.length/1024).toFixed(1) + 'KB') : '메시지 캐시 없음');
            add('localStorage 전체', true, lsKeys.length + '개 키');
        } catch(e) { add('localStorage', false, e.message); }

        // 11. 윈도우 / URL 정보
        add('URL (chatWindow 모드?)', true, location.href.indexOf('chatWindow=1') >= 0 ? 'chat-window 모드' : '메인');
        add('dummyMessagesMap (메모리)', true, (Object.keys(window.__slackDummyMessagesMap||{}).length) + '개 채널');
        add('LS key name', !!window.__slackLSKey, String(window.__slackLSKey||'없음'));

        renderPanel();
    }

    function renderPanel() {
        var panel = document.getElementById('tauriDiagPanel');
        if (!panel) return;
        var body = panel.querySelector('.diag-body');
        var allOk = results.every(function(r) { return r.ok; });
        body.innerHTML = '<div style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;color:' + (allOk ? '#16a34a' : '#dc2626') + ';">전체 상태: ' + (allOk ? '✅ 정상' : '⚠️ 일부 실패') + '</div>' +
            results.map(function(r) {
                return '<div style="padding:8px 12px;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;gap:12px;">' +
                    '<span style="font-size:13px;">' + (r.ok ? '✅' : '❌') + ' ' + r.name + '</span>' +
                    '<span style="font-size:11px;color:#64748b;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (r.detail||'').replace(/"/g,'&quot;') + '">' + (r.detail || '') + '</span>' +
                    '</div>';
            }).join('') +
            '<div style="padding:10px 12px;display:flex;gap:8px;">' +
                '<button id="diagRerun" style="flex:1;padding:6px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;">🔄 다시 검사</button>' +
                '<button id="diagTestNotif" style="flex:1;padding:6px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;">🔔 알림 테스트</button>' +
            '</div>';
        document.getElementById('diagRerun').onclick = runChecks;
        document.getElementById('diagTestNotif').onclick = testNotification;
    }

    async function testNotification() {
        try {
            var notif = (window.__TAURI__ && window.__TAURI__.notification) || null;
            if (!notif) { alert('알림 플러그인 불가'); return; }
            var ok = await notif.isPermissionGranted();
            if (!ok) { await notif.requestPermission(); }
            await notif.sendNotification({ title: 'Slack 대시보드', body: '알림이 정상 동작합니다 ✅' });
        } catch(e) { alert('알림 실패: ' + e.message); }
    }

    function createButton() {
        // [v4.18] floating 🔧 버튼 제거 — 설정 메뉴에서 호출 (window.__tauriDiag.toggle())
        var panel = document.createElement('div');
        panel.id = 'tauriDiagPanel';
        panel.style.cssText = 'position:fixed;top:48px;right:8px;width:340px;max-height:70vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:99998;display:none;font-family:sans-serif;';
        panel.innerHTML = '<div style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-weight:700;display:flex;justify-content:space-between;align-items:center;"><span>🔧 Tauri 진단</span><span id="diagClose" style="cursor:pointer;color:#64748b;">✕</span></div><div class="diag-body"><div style="padding:20px;text-align:center;color:#64748b;">검사 중...</div></div>';
        document.body.appendChild(panel);
        panel.querySelector('#diagClose').onclick = function() { panel.style.display = 'none'; };
    }

    function togglePanel() {
        var panel = document.getElementById('tauriDiagPanel');
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            runChecks();
        } else {
            panel.style.display = 'none';
        }
    }

    // ===== 자동 피드백 로깅 — Claude가 읽을 수 있도록 파일에 저장 =====
    var __logBuffer = [];
    function pushLog(level, args) {
        try {
            var ts = new Date().toISOString();
            var msg = Array.prototype.map.call(args, function(a) {
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch(e) { return String(a); }
            }).join(' ');
            __logBuffer.push(ts + ' [' + level + '] ' + msg);
            if (__logBuffer.length > 2000) __logBuffer.shift();
        } catch(e) {}
    }
    ['log','warn','error','info'].forEach(function(lv) {
        var orig = console[lv];
        console[lv] = function() { pushLog(lv, arguments); orig.apply(console, arguments); };
    });
    window.addEventListener('error', function(e) {
        pushLog('uncaught', ['ERROR', e.message, 'at', e.filename + ':' + e.lineno]);
        flushFeedback('error_' + Date.now());
    });
    window.addEventListener('unhandledrejection', function(e) {
        pushLog('promise', ['UNHANDLED', e.reason && (e.reason.message || e.reason)]);
        flushFeedback('reject_' + Date.now());
    });

    async function flushFeedback(tag) {
        try {
            var T = window.__TAURI__;
            var invoke = T && T.core && T.core.invoke;
            if (!invoke) return;
            var payload = {
                ts: new Date().toISOString(),
                tag: tag || 'manual',
                url: location.href,
                userAgent: navigator.userAgent,
                diagnostics: results,
                logs: __logBuffer.slice(-200)
            };
            var content = JSON.stringify(payload, null, 2);
            var safeName = String(tag || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_');
            var path = await invoke('write_feedback', { name: safeName, content: content });
            console.log('[TauriDiag] feedback:', path);
        } catch(e) { console.warn('[TauriDiag] feedback fail', e); }
    }
    window.__tauriFeedback = flushFeedback;

    function init() {
        createButton();
        console.log('[TauriDiag] 활성 — 우상단 🔧 버튼 클릭');
        setTimeout(runChecks, 1500);
        // 30초마다 진단+로그 자동 저장
        setInterval(function() { flushFeedback('periodic'); }, 30000);
        setTimeout(function() { flushFeedback('startup'); }, 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    window.__tauriDiag = { run: runChecks, toggle: togglePanel, results: function() { return results; } };
})();
