// ============================================================
// [v0.5] Slack 대시보드 - 멀티윈도우 + 컴팩트 모드
// ============================================================

(function() {
    'use strict';

    var MOBILE_WIDTH = 768;
    var CHAT_WIN_WIDTH = 400;
    var CHAT_WIN_HEIGHT = 620;
    var POPUP_CHECK_DELAY = 200;

    // [v4.0] Tauri 네이티브 앱 감지 — popup 차단되므로 in-page 모달만 사용
    function isTauri() {
        return typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_INTERNALS__ !== 'undefined';
    }

    function isMobile() {
        // [v3.6 fix] 단순 너비 체크 X — 진짜 모바일 기기만 감지
        //   (PWA 창을 좁게 줄여도 데스크톱이면 별도 창 시도해야 함 — 카톡 PC 스타일)
        var ua = navigator.userAgent || '';
        var isMobileUA = /Mobi|Android|iPhone|iPad|iPod/.test(ua);
        var hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        // 모바일 UA + 터치 + 좁은 창 모두 만족해야 모바일
        return isMobileUA && hasTouch && window.innerWidth < MOBILE_WIDTH;
    }

    // [v3.3] PWA standalone 감지 — PWA에서는 window.open이 외부 브라우저로 빠지므로
    //        인앱 플로팅 패널(_original)을 사용해야 함
    function isPWA() {
        try {
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
            if (window.matchMedia && window.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
            if (window.navigator && window.navigator.standalone === true) return true;
        } catch(e) {}
        return false;
    }

    function detectBrowser() {
        var ua = navigator.userAgent;
        var isMac = /Mac|iPhone|iPad|iPod/.test(ua);
        if (/Edg\//.test(ua)) return { name: 'Edge', isMac: isMac };
        if (/Chrome\//.test(ua)) return { name: 'Chrome', isMac: isMac };
        if (/Firefox\//.test(ua)) return { name: 'Firefox', isMac: isMac };
        if (/Safari\//.test(ua)) return { name: 'Safari', isMac: isMac };
        return { name: 'Unknown', isMac: isMac };
    }

    function isPopupBlocked(popup) {
        if (!popup) return true;
        if (popup.closed) return true;
        if (typeof popup.closed === 'undefined') return true;
        return false;
    }

    function createHelpModal() {
        var existing = document.getElementById('popupHelpModal');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.id = 'popupHelpModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:none;align-items:center;justify-content:center;padding:20px;';
        var browser = detectBrowser();
        var instructions = getBrowserInstructions(browser);
        modal.innerHTML =
            '<div style="background:white;border-radius:16px;padding:25px;max-width:500px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:15px;">' +
                    '<div style="font-size:32px;">🚫</div>' +
                    '<div>' +
                        '<h3 style="margin:0;color:#1e293b;font-size:18px;">팝업이 차단됐어요!</h3>' +
                        '<div style="font-size:12px;color:#64748b;margin-top:4px;">대화방을 별도 창으로 열려면 팝업 허용이 필요해요</div>' +
                    '</div>' +
                '</div>' +
                '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:15px;margin-bottom:15px;">' +
                    '<div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;">감지된 브라우저</div>' +
                    '<div style="font-size:14px;font-weight:700;color:#1e293b;">' + browser.name + (browser.isMac ? ' (Mac)' : ' (Windows)') + '</div>' +
                '</div>' +
                '<div style="background:#dbeafe;border-left:4px solid #3b82f6;padding:15px;border-radius:8px;margin-bottom:15px;">' +
                    '<div style="font-size:13px;font-weight:800;color:#1e3a8a;margin-bottom:10px;">🔓 팝업 허용 방법</div>' +
                    '<div style="font-size:13px;color:#1e40af;line-height:1.8;">' + instructions + '</div>' +
                '</div>' +
                '<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:8px;margin-bottom:15px;font-size:12px;color:#78350f;">' +
                    '💡 <strong>참고:</strong> 팝업을 허용해도 우리 대시보드에서만 뜨는 거예요.' +
                '</div>' +
                '<div style="display:flex;gap:10px;">' +
                    '<button id="popupHelpRetry" style="flex:1;padding:12px;background:#10b981;color:white;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">🔄 다시 시도</button>' +
                    '<button id="popupHelpClose" style="flex:1;padding:12px;background:#e2e8f0;color:#475569;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">닫기</button>' +
                '</div>' +
            '</div>';
        modal.addEventListener('click', function(e) { if (e.target === modal) closeHelpModal(); });
        document.body.appendChild(modal);
        document.getElementById('popupHelpClose').addEventListener('click', closeHelpModal);
        document.getElementById('popupHelpRetry').addEventListener('click', function() {
            closeHelpModal();
            if (window._lastBlockedChat) {
                setTimeout(function() {
                    tryOpenChatWindow(window._lastBlockedChat.type, window._lastBlockedChat.id);
                }, 100);
            }
        });
        return modal;
    }

    function getBrowserInstructions(browser) {
        var name = browser.name;
        if (name === 'Chrome') {
            return '1. 주소창 오른쪽의 <strong>🔒 자물쇠 아이콘</strong> 클릭<br>2. <strong>"팝업 및 리디렉션"</strong> 찾기<br>3. <strong>"허용"</strong> 으로 변경<br>4. 페이지 새로고침 (F5)';
        } else if (name === 'Edge') {
            return '1. 주소창 오른쪽의 <strong>🔒 자물쇠 아이콘</strong> 클릭<br>2. <strong>"이 사이트에 대한 권한"</strong> 클릭<br>3. <strong>"팝업 및 리디렉션"</strong> → <strong>"허용"</strong><br>4. 페이지 새로고침 (F5)';
        } else if (name === 'Firefox') {
            return '1. 주소창에 <strong>차단 아이콘</strong> 클릭<br>2. <strong>"팝업 허용"</strong> 선택<br>3. 페이지 새로고침 (F5)';
        } else if (name === 'Safari') {
            if (browser.isMac) {
                return '<strong>Mac Safari:</strong><br>1. 상단 <strong>Safari 메뉴 → 설정</strong><br>2. <strong>웹사이트</strong> 탭 → <strong>팝업 창</strong><br>3. 현재 사이트를 <strong>"허용"</strong><br>4. 새로고침';
            } else {
                return '<strong>iOS Safari:</strong><br>1. <strong>설정 앱</strong> → <strong>Safari</strong><br>2. <strong>"팝업 차단"</strong> 끄기<br>3. 페이지 새로고침';
            }
        } else {
            return '브라우저 설정에서 <strong>팝업 허용</strong>을 찾아 켜주세요.';
        }
    }

    function showHelpModal() {
        if (isTauri()) return; // Tauri는 popup 차단 모달 띄우지 않음 (어차피 in-page 모달 사용)
        var modal = document.getElementById('popupHelpModal') || createHelpModal();
        modal.style.display = 'flex';
    }
    function closeHelpModal() {
        var modal = document.getElementById('popupHelpModal');
        if (modal) modal.style.display = 'none';
    }

    function tryOpenChatWindow(type, id) {
        window._lastBlockedChat = { type: type, id: id };
        var url = window.location.pathname + '?chat=' + encodeURIComponent(id) + '&type=' + encodeURIComponent(type);

        // [v3.3] 메인 창 오른쪽에 나란히 (카톡 스타일). 화면 밖이면 여러 열로 stacking.
        var mainW = window.outerWidth || window.innerWidth || 0;
        var screenW = window.screen.availWidth || window.screen.width;
        var screenH = window.screen.availHeight || window.screen.height;
        var winCount = (window._openedChatWins = (window._openedChatWins || 0) + 1);
        var baseLeft = (window.screenX || 0) + mainW + 10;
        var baseTop = (window.screenY || 0);
        // 너무 오른쪽이면 화면 안으로 되돌리기
        if (baseLeft + CHAT_WIN_WIDTH > screenW) {
            baseLeft = screenW - CHAT_WIN_WIDTH - 20;
        }
        // 여러 개 열면 조금씩 어긋나게
        var offset = ((winCount - 1) % 5) * 30;
        var finalLeft = Math.max(0, baseLeft + offset);
        var finalTop = Math.max(0, baseTop + offset);
        if (finalTop + CHAT_WIN_HEIGHT > screenH) finalTop = Math.max(0, screenH - CHAT_WIN_HEIGHT - 20);

        // [v3.4] popup 키워드만 사용 — noopener는 window.open이 null을 반환하게 해서
        //   "두 번 열리는 버그" 원인이었음. 동일 winName 재사용으로 중복 열림 방지.
        var features = 'popup,width=' + CHAT_WIN_WIDTH + ',height=' + CHAT_WIN_HEIGHT + ',left=' + finalLeft + ',top=' + finalTop + ',resizable=yes,scrollbars=yes';
        var winName = 'slack_chat_' + id;
        var popup = null;
        try { popup = window.open(url, winName, features); } catch(e) { popup = null; }
        if (isPopupBlocked(popup)) {
            if (!isPWA()) showHelpModal();
            return false;
        }
        setTimeout(function() {
            if (popup && popup.closed && !isPWA()) showHelpModal();
        }, POPUP_CHECK_DELAY);
        try { popup.focus(); } catch(e) {}
        return true;
    }

    function patchOpenSlackChatPopup() {
        if (typeof window.openSlackChatPopup !== 'function') {
            setTimeout(patchOpenSlackChatPopup, 1000);
            return;
        }
        if (window.openSlackChatPopup._patched) return;
        var original = window.openSlackChatPopup;
        window.openSlackChatPopup = function(type, id) {
            var __isChatWin = location.search.indexOf('chatWindow=1') >= 0;
            // [v6.10.23] Tauri 별창 복원 (원래 동작 — T7 selftest 통과)
            if (isTauri() && !__isChatWin) {
                // friends/canvas/__user_ 등은 우선 변환 단계 거치므로 original 호출
                if (type === 'canvas' || type === 'friends') return original.apply(this, arguments);
                if (typeof id === 'string' && id.indexOf('__user_') === 0) return original.apply(this, arguments);
                var name = id;
                try {
                    if (typeof getChatMetaById === 'function') {
                        var m = getChatMetaById(type, id);
                        if (m && m.name) name = m.name;
                    }
                } catch(e) {}
                console.log('[Tauri] 채팅창 열기:', type, id, name);
                // [v6.10.18] 즉시 파일 기록 — 클릭이 핸들러 도달 확인용
                try {
                    var ts0 = Date.now();
                    window.__TAURI__.core.invoke('write_feedback', { name: 'chat_click_' + ts0, content: JSON.stringify({ ts: new Date().toISOString(), event: 'click', type: type, id: id, name: name }) }).catch(function(){});
                } catch(e) {}
                window.__TAURI__.core.invoke('open_chat_window', { chatId: id, chatType: type, chatName: name })
                    .then(function() {
                        console.log('[Tauri] open_chat_window 성공');
                        try { window.__TAURI__.core.invoke('write_feedback', { name: 'chat_ok_' + Date.now(), content: JSON.stringify({ ts: new Date().toISOString(), event: 'invoke_ok', id: id }) }).catch(function(){}); } catch(e) {}
                    })
                    .catch(function(e){
                        var msg = (e && (e.message || e.toString())) || String(e);
                        console.warn('[Tauri] open_chat_window 실패:', msg, 'type=', type, 'id=', id);
                        try { window.__TAURI__.core.invoke('write_feedback', { name: 'chat_fail_' + Date.now(), content: JSON.stringify({ ts: new Date().toISOString(), event: 'invoke_fail', err: msg, id: id, type: type }) }).catch(function(){}); } catch(ee) {}
                        try { if (typeof showToast === 'function') showToast('채팅 열기 실패: ' + msg); } catch(ee){}
                        original.apply(window, [type, id]);
                    });
                return;
            }
            if (__isChatWin) return original.apply(this, arguments);
            if (isMobile()) return original.apply(this, arguments);
            if (type === 'canvas') return original.apply(this, arguments);
            if (type === 'friends') return original.apply(this, arguments);
            if (typeof id === 'string' && id.indexOf('__user_') === 0) return original.apply(this, arguments);
            var ok = tryOpenChatWindow(type, id);
            if (!ok) return original.apply(this, arguments);
        };
        window.openSlackChatPopup._patched = true;
        window.openSlackChatPopup._original = original;
        console.log('[multi-window] openSlackChatPopup 패치 완료!');

        // [v6.10.18] 자동 진단: 30초 후 첫 채널/DM 클릭 시뮬 (메인 창에서만)
        if (location.search.indexOf('chatWindow=1') < 0 && isTauri()) {
            setTimeout(function() {
                try {
                    var firstChat = null;
                    var firstType = null;
                    if (typeof dummyChannels !== 'undefined' && dummyChannels.length > 0) {
                        firstChat = dummyChannels[0];
                        firstType = 'channel';
                    } else if (typeof dummyDMs !== 'undefined' && dummyDMs.length > 0) {
                        firstChat = dummyDMs[0];
                        firstType = 'dm';
                    }
                    if (firstChat && firstChat.id) {
                        var diag = { ts: new Date().toISOString(), event: 'auto_click_test', type: firstType, id: firstChat.id, name: firstChat.name };
                        window.__TAURI__.core.invoke('write_feedback', { name: 'auto_click_' + Date.now(), content: JSON.stringify(diag) }).catch(function(){});
                        console.log('[v6.10.18 자동 진단] 시뮬 클릭:', firstType, firstChat.id);
                        // 직접 호출 (UI 클릭 시뮬)
                        try { window.openSlackChatPopup(firstType, firstChat.id); } catch(e) {
                            window.__TAURI__.core.invoke('write_feedback', { name: 'auto_click_err_' + Date.now(), content: JSON.stringify({ts: new Date().toISOString(), err: String(e)}) }).catch(function(){});
                        }
                        // 5초 후 자동 닫기
                        setTimeout(function() {
                            try { window.__TAURI__.core.invoke('close_chats_starting_with', { prefix: 'chat-' + firstChat.id.replace(/[^a-zA-Z0-9_]/g, '') }).catch(function(){}); } catch(e) {}
                        }, 5000);
                    }
                } catch(e) {
                    try { window.__TAURI__.core.invoke('write_feedback', { name: 'auto_click_outer_err_' + Date.now(), content: JSON.stringify({err: String(e)}) }).catch(function(){}); } catch(ee){}
                }
            }, 30000);
        }
    }

    function addHelpButton() {
        var actions = document.querySelector('.top-bar-actions');
        if (!actions) { setTimeout(addHelpButton, 500); return; }
        if (document.getElementById('multiWinHelpBtn')) return;
        var btn = document.createElement('button');
        btn.id = 'multiWinHelpBtn';
        btn.className = 'sim-btn';
        btn.title = '대화창 팝업이 안 열릴 때 도움말';
        btn.textContent = '❓';
        btn.className = 'action-btn btn-icon';
        btn.style.marginLeft = '4px';
        btn.addEventListener('click', showHelpModal);
        actions.appendChild(btn);
        console.log('[multi-window] 도움말 버튼 추가!');
    }

    function handleChildWindowMode() {
        var params = new URLSearchParams(window.location.search);
        var chatId = params.get('chat');
        var chatType = params.get('type');
        if (!chatId) return;
        var waitForUi = setInterval(function() {
            var layout = document.querySelector('.slack-layout');
            if (!layout) return;
            clearInterval(waitForUi);
            layout.style.display = 'none';
            var banner = document.querySelector('.slack-demo-banner');
            if (banner) banner.style.display = 'none';
            var topBar = document.querySelector('.top-bar');
            if (topBar) topBar.style.display = 'none';
            document.body.style.background = '#b2c7d9';
            if (typeof window.openSlackChatPopup === 'function') {
                setTimeout(function() {
                    try {
                        // [v3.4] 메인 창이 저장해둔 캐시 먼저 로드 → 이름/목록 즉시 사용 가능
                        if (typeof window.__slackLoadCache === 'function') {
                            try { window.__slackLoadCache(); } catch(e) {}
                        }
                        if (window.openSlackChatPopup._original) {
                            window.openSlackChatPopup._original(chatType, chatId);
                        } else {
                            window.openSlackChatPopup(chatType, chatId);
                        }
                        setTimeout(function() {
                            var popup = document.querySelector('.slack-popup');
                            if (popup) {
                                popup.style.position = 'fixed';
                                popup.style.inset = '0';
                                popup.style.width = '100%';
                                popup.style.height = '100%';
                                popup.style.borderRadius = '0';
                            }
                            // [v3.3] 자식 창의 X/뒤로가기/최소화는 창 자체를 닫기
                            var origClose = window.closeSlackPopup;
                            window.closeSlackPopup = function(pid) {
                                try { if (origClose) origClose.call(window, pid); } catch(e) {}
                                setTimeout(function() { try { window.close(); } catch(e) {} }, 50);
                            };
                            var origMinimize = window.toggleSlackPopupMinimize;
                            if (origMinimize) {
                                window.toggleSlackPopupMinimize = function(pid) {
                                    // 자식 창에서는 최소화 = OS 창 최소화
                                    try { window.blur(); } catch(e) {}
                                };
                            }
                        }, 300);
                    } catch(e) { console.error('[multi-window] 자식 창 오류:', e); }
                }, 500);
            }
        }, 200);
        setTimeout(function() { clearInterval(waitForUi); }, 10000);
    }

    var broadcastChannel = null;
    function setupBroadcastChannel() {
        if (typeof BroadcastChannel === 'undefined') return;
        broadcastChannel = new BroadcastChannel('slack-dashboard');
        broadcastChannel.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
        });
        console.log('[multi-window] BroadcastChannel 연결!');
    }

    function broadcast(type, data) {
        if (broadcastChannel) {
            try { broadcastChannel.postMessage({ type: type, data: data }); } catch(e) {}
        }
    }

    // ============================================================
    // [v0.5] 컴팩트 모드 — 좁은 창에서 아이콘만 + 호버 툴팁
    // ============================================================
    function setupCompactMode() {
        var css = document.createElement('style');
        css.textContent =
            '@media (max-width: 500px) {' +
                '.top-bar-actions .btn-text { display: none; }' +
                '.top-bar-actions .action-btn, .top-bar-actions .sim-btn {' +
                    'padding: 6px 10px; min-width: 34px; font-size: 14px;' +
                '}' +
                '.top-bar-actions { gap: 4px; }' +
                '.top-bar-title { font-size: 13px; }' +
                '.top-bar { padding: 0 8px; gap: 6px; }' +
                '.slack-layout {' +
                    'width: 100% !important; max-width: 100% !important;' +
                    'margin-left: 0 !important; margin-right: 0 !important;' +
                '}' +
                '.app-container { left: 0 !important; right: 0 !important; }' +
            '}' +
            '@media (max-width: 380px) {' +
                '.top-bar-title { display: none; }' +
                '.top-bar-actions .action-btn, .top-bar-actions .sim-btn {' +
                    'padding: 6px 8px;' +
                '}' +
            '}' +
            '.top-bar-actions button[title]:hover::after {' +
                'content: attr(title);' +
                'position: absolute;' +
                'top: 100%; left: 50%;' +
                'transform: translateX(-50%);' +
                'margin-top: 8px;' +
                'background: #1e293b;' +
                'color: white;' +
                'padding: 6px 10px;' +
                'border-radius: 6px;' +
                'font-size: 11px;' +
                'font-weight: 600;' +
                'white-space: nowrap;' +
                'z-index: 100001;' +
                'pointer-events: none;' +
                'box-shadow: 0 4px 12px rgba(0,0,0,0.2);' +
            '}' +
            '.top-bar-actions button[title] { position: relative; }';
        document.head.appendChild(css);

        function wrapButtonText() {
            var buttons = document.querySelectorAll('.top-bar-actions button');
            buttons.forEach(function(btn) {
                if (btn.dataset.wrapped === '1') return;
                var html = btn.innerHTML.trim();
                var match = html.match(/^(\S+)(\s+)(.+)$/);
                if (match) {
                    btn.innerHTML = match[1] + '<span class="btn-text">' + match[2] + match[3] + '</span>';
                    btn.dataset.wrapped = '1';
                }
            });
        }

        wrapButtonText();
        setTimeout(wrapButtonText, 1500);
        setTimeout(wrapButtonText, 3000);
        console.log('[multi-window] 컴팩트 모드 준비!');
    }

    window.slackMultiWindow = {
        broadcast: broadcast,
        showHelp: showHelpModal,
        isMobile: isMobile
    };

    function init() {
        console.log('[multi-window] 초기화 시작');
        setupBroadcastChannel();
        handleChildWindowMode();
        setTimeout(addHelpButton, 1000);
        setTimeout(setupCompactMode, 1200);
        setTimeout(patchOpenSlackChatPopup, 1500);
        console.log('[multi-window] 초기화 완료!');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
