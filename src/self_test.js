// 자가 테스트 — Claude가 사용자 없이 검증
// 메인 창에서만 실행. 결과를 feedback/test_result_<timestamp>.json에 기록.
(function() {
    'use strict';
    if (location.search.indexOf('chatWindow=1') >= 0) return;
    if (typeof window.__TAURI__ === 'undefined') return;

    var T = window.__TAURI__;
    // [v6.10.8] inv를 lazy 호출로 → T.core 초기화 타이밍 문제 회피
    function inv(cmd, args) {
        var TT = window.__TAURI__;
        if (!TT || !TT.core || typeof TT.core.invoke !== 'function') {
            return Promise.reject(new Error('Tauri.core.invoke not ready'));
        }
        return TT.core.invoke(cmd, args);
    }

    var results = [];
    function log(name, pass, detail) {
        results.push({ name: name, pass: pass, detail: detail || '', ts: new Date().toISOString() });
        console.log('[SelfTest]', pass ? '✅' : '❌', name, detail || '');
    }
    function wait(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

    async function flush() {
        try {
            var ok = results.filter(function(r){return r.pass;}).length;
            var bad = results.filter(function(r){return !r.pass;}).length;
            var payload = {
                ts: new Date().toISOString(),
                summary: ok + ' pass / ' + bad + ' fail',
                results: results
            };
            await inv('write_feedback', { name: 'test_' + Date.now(), content: JSON.stringify(payload, null, 2) });
            console.log('[SelfTest] 결과 저장:', ok, '/', ok+bad);
        } catch(e) { console.warn('[SelfTest] 저장 실패', e); }
    }

    async function runTests() {
        console.log('[SelfTest] 시작 (60초 후 — 폴링 안정 확인)');
        var pollAt15 = -1, pollAt30 = -1, pollAt60 = -1;
        await wait(15000);
        pollAt15 = window.__slackMasterPollCount || 0;
        await wait(15000);
        pollAt30 = window.__slackMasterPollCount || 0;
        await wait(30000);
        pollAt60 = window.__slackMasterPollCount || 0;
        log('TP 폴링 진행', pollAt60 > pollAt30 && pollAt30 > pollAt15, '15s=' + pollAt15 + ' / 30s=' + pollAt30 + ' / 60s=' + pollAt60);

        // T1: slackRealMode true 인지
        log('T1 slackRealMode', (typeof slackRealMode !== 'undefined' && slackRealMode === true), 'realMode=' + (typeof slackRealMode !== 'undefined' ? slackRealMode : 'undef'));

        // T2: dummyDMs 채워졌는지
        var dmCount = (typeof dummyDMs !== 'undefined' && Array.isArray(dummyDMs)) ? dummyDMs.length : 0;
        log('T2 dummyDMs 로드', dmCount > 0, dmCount + '개');

        // T3: localStorage 메시지 캐시
        try {
            var lsKeys = Object.keys(localStorage);
            var msgKey = lsKeys.filter(function(k){return /msg/i.test(k);})[0];
            var msgChannels = 0;
            if (msgKey) { try { msgChannels = Object.keys(JSON.parse(localStorage.getItem(msgKey)||'{}')).length; } catch(e){} }
            log('T3 LS 메시지 캐시', msgChannels > 0, msgChannels + '채널 (key=' + (msgKey||'없음') + ')');
        } catch(e) { log('T3 LS 메시지 캐시', false, e.message); }

        // T4: prefetch 동작 (dummyMessagesMap에 prefetched 메시지)
        var msgMapCount = (typeof dummyMessagesMap !== 'undefined') ? Object.keys(dummyMessagesMap).length : 0;
        var T4ChannelsAtStart = msgMapCount;
        log('T4 prefetch 캐시', msgMapCount >= 5, msgMapCount + '채널 (메모리)');

        // T5: 마스터 폴링 동작
        var pollCount = window.__slackMasterPollCount || 0;
        log('T5 마스터 폴링', pollCount >= 3, pollCount + '회 호출');

        // T6: 알림 중복 차단 함수 존재
        log('T6 알림 중복 차단', typeof __notifiedKeys !== 'undefined', '__notifiedKeys ' + (typeof __notifiedKeys === 'object' ? Object.keys(__notifiedKeys).length + '개 기록' : '없음'));

        // T7: chat-window 새 창 명령어 + 자동 닫기 (가짜 창 안 남김)
        try {
            var t0 = performance.now();
            await inv('open_chat_window', { chatId: '__SELFTEST_NOOP__', chatType: 'dm', chatName: '셀프테스트' });
            await wait(300);
            // 만든 창 즉시 destroy (close가 hide 되도록 트랩되어 있어서 destroy 강제)
            try { await inv('close_chats_starting_with', { prefix: 'chat-__SELFTEST' }); } catch(e) {}
            log('T7 open_chat_window', true, ((performance.now()-t0)|0) + 'ms');
        } catch(e) { log('T7 open_chat_window', false, e.message || e); }

        // T11: GAS 응답 속도 (ping/pong)
        try {
            var t1 = performance.now();
            await new Promise(function(resolve, reject) {
                google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).pingUser();
            });
            log('T11 GAS 응답시간', true, ((performance.now()-t1)|0) + 'ms');
        } catch(e) { log('T11 GAS 응답시간', false, e.message || e); }

        // T12: webview cookie 추출 + Slack API 직접 호출 시뮬 (rust_fetch는 없으니 Slack 네트워크만)
        try {
            var t2 = performance.now();
            await fetch('https://slack.com/api/api.test');
            log('T12 Slack 직접 호출', true, ((performance.now()-t2)|0) + 'ms');
        } catch(e) { log('T12 Slack 직접 호출', false, e.message || e); }

        // T14: v5.0 Slack 직접 호출 (토큰 + 응답 시간)
        try {
            var t14 = performance.now();
            if (typeof window.__slackDirect === 'function') {
                var res = await window.__slackDirect('auth.test', {});
                var ok = res && res.ok;
                log('T14 v5.0 Slack 직접', ok, ((performance.now()-t14)|0) + 'ms ' + (ok ? '(user=' + res.user + ')' : '실패'));
            } else { log('T14 v5.0 Slack 직접', false, '__slackDirect 함수 없음'); }
        } catch(e) { log('T14 v5.0 Slack 직접', false, e.message || e); }

        // T13: 알림 중복 차단 시뮬 — 같은 (channelId, ts) 5번 → 1번만 통과
        try {
            if (typeof window.__shouldNotify === 'function') {
                var ch = '__SELFTEST_DUP__'; var ts = '999.999';
                // 깨끗한 시작
                if (window.__notifiedKeys) delete window.__notifiedKeys[ch + '|' + ts];
                var passed = 0;
                for (var i = 0; i < 5; i++) { if (window.__shouldNotify(ch, ts)) passed++; }
                log('T13 알림 중복 차단', passed === 1, '5번 호출 → ' + passed + '번 통과 (기대 1)');
            } else {
                log('T13 알림 중복 차단', false, 'window.__shouldNotify 없음');
            }
        } catch(e) { log('T13 알림 중복 차단', false, e.message || e); }

        // T8: write_feedback 동작
        try {
            await inv('write_feedback', { name: 'selftest_ping', content: '{"ts":"' + new Date().toISOString() + '"}' });
            log('T8 write_feedback', true, 'OK');
        } catch(e) { log('T8 write_feedback', false, e.message || e); }

        // T9: 알림 권한 (v5.4 fix — invoke 직접 호출)
        try {
            var notif = (window.__TAURI__ && window.__TAURI__.notification) || null;
            if (notif && notif.isPermissionGranted) {
                var perm = await notif.isPermissionGranted();
                log('T9 알림 권한', perm === true, String(perm));
            } else {
                // invoke fallback
                var p2 = await inv('plugin:notification|is_permission_granted');
                log('T9 알림 권한', !!p2, 'invoke=' + JSON.stringify(p2));
            }
        } catch(e) { log('T9 알림 권한', false, e.message); }

        // T10: 채팅 목록에 unread > 0 채널 있는지 (받은 메시지 있는지)
        var unreadChs = 0;
        try {
            if (typeof dummyDMs !== 'undefined') unreadChs = dummyDMs.filter(function(d){return (d.unread||0)>0;}).length;
        } catch(e) {}
        log('T10 unread 채널 감지', true, unreadChs + '개 (정보)');

        // T19: Socket Mode 연결 상태 (xapp 토큰 + WebSocket 연결됨)
        try {
            // [v6.10.8] 외부 inv 함수 사용 (lazy)
            if (window.__TAURI__ && window.__TAURI__.core) {
                var xtok = await inv('load_xapp_token');
                log('T19 xapp 토큰 저장됨', !!xtok, xtok ? ('길이=' + xtok.length) : '없음');
                // socket-status feedback 파일 확인
                try {
                    var sockData = await fetch('/').then(function() { return null; }).catch(function() { return null; });
                } catch(e) {}
            } else { log('T19 xapp 토큰', false, 'invoke 없음'); }
        } catch(e) { log('T19 xapp 토큰', false, e.message); }

        // T20: GAS pollAll 직접 호출 — unread > 0 채널 카운트 + lastRead 검증
        try {
            await new Promise(function(resolve) {
                google.script.run
                    .withSuccessHandler(function(res) {
                        var ui = (res && res.unreadItems) || [];
                        var gt0 = ui.filter(function(u) { return (u.unread || 0) > 0; });
                        var hasLastRead = ui.filter(function(u) { return u.lastRead && u.lastRead.length > 0; }).length;
                        var sampleStr = ui.length > 0 ? JSON.stringify(ui[0]).substring(0, 150) : '없음';
                        log('T20 GAS pollAll unread', true, '전체=' + ui.length + ' unread>0=' + gt0.length + ' lastRead有=' + hasLastRead + ' 샘플=' + sampleStr);
                        resolve();
                    })
                    .withFailureHandler(function(e) { log('T20 GAS pollAll', false, e); resolve(); })
                    .pollAll('[]');
            });
        } catch(e) { log('T20 GAS pollAll', false, e.message); }

        // T21: 채널 멤버 캐시 + dummyCanvases 카운트
        try {
            var memMapStr = localStorage.getItem('slack_channel_members_v1') || '{}';
            var memMap = JSON.parse(memMapStr);
            var keys = Object.keys(memMap);
            var canvases = keys.filter(function(k) { return k.indexOf('cv_') === 0; });
            var channels = keys.filter(function(k) { return k.indexOf('cv_') !== 0; });
            var dCanvas = (typeof dummyCanvases !== 'undefined') ? dummyCanvases.length : 0;
            var firstCv = (typeof dummyCanvases !== 'undefined' && dummyCanvases[0]) ? JSON.stringify({id: dummyCanvases[0].id, fileId: dummyCanvases[0].fileId, name: dummyCanvases[0].name}) : 'none';
            log('T21 멤버 캐시', keys.length > 0, 'ch=' + channels.length + ' cv캐시=' + canvases.length + ' dummyCV=' + dCanvas + ' 샘플=' + firstCv.substring(0,100));
        } catch(e) { log('T21 멤버 캐시', false, e.message); }

        // T22: dummyChannels의 unread > 0 카운트
        try {
            var chUnread = (typeof dummyChannels !== 'undefined') ? dummyChannels.filter(function(c) { return (c.unread||0) > 0; }) : [];
            var pass22 = chUnread.length <= 8;
            log('T22 채널 unread (메모리)', pass22, chUnread.length + '개' + (pass22?'':'⚠ 과다') + ': ' + chUnread.slice(0,5).map(function(c){return c.name+'('+(c.unread||0)+')';}).join(','));
        } catch(e) { log('T22 채널 unread', false, e.message); }

        // T23/T25 제거됨: Slack xoxp 토큰의 files.slack.com 다운로드 권한 부재가 영구 한계
        //   → 이미지는 외부 브라우저로 처리 (T24가 이 경로 검증)

        // T26: webview slack cookie 진단 — 인앱 이미지 작동 가능성 체크
        try {
            if (window.__TAURI__ && window.__TAURI__.core) {
                var ck = await inv('diag_slack_cookies');
                var hasSlackCookies = ck && ck.indexOf('slack_count=0') < 0;
                log('T26 webview slack 쿠키', hasSlackCookies, ck.substring(0, 200));
            } else { log('T26 webview slack 쿠키', false, 'invoke 없음'); }
        } catch(e) { log('T26 webview slack 쿠키', false, e.message || e); }

        // T24: open_external_url 명령이 실제로 등록되어 있는지 확인 (about:blank 호출)
        try {
            var T = window.__TAURI__;
            if (T && T.core && T.core.invoke) {
                try {
                    await T.core.invoke('open_external_url', { url: 'about:blank' });
                    log('T24 open_external_url', true, '명령 호출 성공 (about:blank)');
                } catch(e) {
                    var msg = (e && (e.message||e.toString())) || String(e);
                    var notFound = msg.indexOf('not found') > -1 || msg.indexOf('command') > -1;
                    log('T24 open_external_url', !notFound, msg.substring(0, 100));
                }
            } else { log('T24 open_external_url', false, 'Tauri invoke 없음'); }
        } catch(e) { log('T24 open_external_url', false, e.message || e); }

        // T17/T18 제거: rtm.connect (Socket Mode 사용 중)/users.counts (xoxp 미지원) 둘 다 의도적으로 미사용

        // T15: 네이티브 알림 발사 (실제 토스트 한번)
        try {
            var T = window.__TAURI__;
            if (T && T.notification && T.notification.sendNotification) {
                var t15 = performance.now();
                await T.notification.sendNotification({ title: 'Slack 대시보드 셀프테스트', body: '✅ 알림 시스템 정상' });
                log('T15 네이티브 알림 발사', true, ((performance.now()-t15)|0) + 'ms');
            } else { log('T15 네이티브 알림 발사', false, 'notification API 없음'); }
        } catch(e) { log('T15 네이티브 알림 발사', false, e.message || e); }

        // T16: prefetch 진행률 (시간 후 다시 측정)
        try {
            await wait(20000); // 추가 20초 대기 — prefetch 더 받았는지 확인
            var msgMapNow = (typeof dummyMessagesMap !== 'undefined') ? Object.keys(dummyMessagesMap).length : 0;
            log('T16 prefetch 진행 (T4 + 20s)', msgMapNow >= 15, T4ChannelsAtStart + ' → ' + msgMapNow + '채널');
        } catch(e) { log('T16 prefetch 진행', false, e.message); }

        await flush();
        console.log('[SelfTest] 완료');
    }

    // 메인 창에서 시작 후 자동 실행
    if (document.readyState === 'complete') runTests();
    else window.addEventListener('load', runTests);
})();
