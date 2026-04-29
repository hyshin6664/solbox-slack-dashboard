// ============================================================
// Slack 대시보드 Service Worker
// - 앱이 닫혀 있어도 백그라운드에서 대기
// - Push 알림 수신 시 자동 표시
// - 알림 클릭 시 대시보드 열기
// ============================================================

var CACHE_VERSION = 'slack-dashboard-v0.3';

// ============================================================
// [설치] Service Worker 등록 시
// ============================================================
self.addEventListener('install', function(event) {
    console.log('[SW] 설치됨:', CACHE_VERSION);
    // 즉시 활성화 (기존 SW 대기 X)
    self.skipWaiting();
});

// ============================================================
// [활성화] 등록 완료 시
// ============================================================
self.addEventListener('activate', function(event) {
    console.log('[SW] 활성화됨:', CACHE_VERSION);
    // 모든 탭 즉시 제어
    event.waitUntil(self.clients.claim());
});

// ============================================================
// [Push 알림 수신]
// Slack → 서버 → Push 서비스 → Service Worker
// 앱이 닫혀 있어도 작동!
// ============================================================
self.addEventListener('push', function(event) {
    console.log('[SW] Push 알림 수신!');

    var data = {};
    try {
        if (event.data) {
            data = event.data.json();
        }
    } catch(e) {
        console.log('[SW] Push 데이터 파싱 실패:', e);
        data = {
            title: '💬 Slack 대시보드',
            body: '새 메시지가 있어요!'
        };
    }

    var title = data.title || '💬 Slack 대시보드';
    var options = {
        body: data.body || '새 메시지가 있어요!',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.tag || 'slack-message',
        requireInteraction: true,   // 사용자가 닫을 때까지 유지
        renotify: true,              // 같은 태그여도 다시 알림
        data: {
            url: data.url || './',
            channelId: data.channelId || ''
        },
        actions: [
            { action: 'open', title: '💬 대시보드 열기' },
            { action: 'close', title: '닫기' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// ============================================================
// [알림 클릭] 사용자가 알림 클릭 시
// ============================================================
self.addEventListener('notificationclick', function(event) {
    console.log('[SW] 알림 클릭됨:', event.action);

    event.notification.close();

    // "닫기" 버튼이면 아무것도 안 함
    if (event.action === 'close') {
        return;
    }

    // 그 외: 대시보드 열기
    var url = (event.notification.data && event.notification.data.url) || './';

    event.waitUntil(
        self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then(function(clientList) {
            // 이미 열려 있는 창이 있으면 그걸로 포커스
            for (var i = 0; i < clientList.length; i++) {
                var client = clientList[i];
                if (client.url.indexOf(self.registration.scope) === 0) {
                    if ('focus' in client) {
                        return client.focus();
                    }
                }
            }
            // 없으면 새로 열기
            if (self.clients.openWindow) {
                return self.clients.openWindow(url);
            }
        })
    );
});

// ============================================================
// [알림 닫힘] 사용자가 알림 닫을 때
// ============================================================
self.addEventListener('notificationclose', function(event) {
    console.log('[SW] 알림 닫힘:', event.notification.tag);
});

// ============================================================
// [메시지 수신] 메인 페이지에서 SW로 메시지 전달 시
// ============================================================
self.addEventListener('message', function(event) {
    console.log('[SW] 메시지 수신:', event.data);

    // 테스트용: 'TEST_NOTIFICATION' 메시지 받으면 알림 보여주기
    if (event.data && event.data.type === 'TEST_NOTIFICATION') {
        self.registration.showNotification(event.data.title || '💬 SW 테스트', {
            body: event.data.body || 'Service Worker가 작동 중이에요!',
            icon: 'icon-192.png',
            badge: 'icon-192.png',
            tag: 'sw-test',
            requireInteraction: true
        });
    }
});
