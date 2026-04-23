# Nano Banana Pro - Frontend Deep Audit

- frontend: http://127.0.0.1:5173
- backend: http://127.0.0.1:8000
- total steps: 23
- passed: 23
- failed: 0

## Steps
| # | Step | Status | Duration (ms) | Error |
|---|------|--------|---------------|-------|
| 1 | boot | OK | 1167 |  |
| 2 | dashboard | OK | 408 |  |
| 3 | nav-create | OK | 355 |  |
| 4 | nav-batch | OK | 661 |  |
| 5 | nav-history | OK | 377 |  |
| 6 | nav-picker | OK | 398 |  |
| 7 | nav-admin | OK | 505 |  |
| 8 | nav-settings | OK | 286 |  |
| 9 | settings-toggle-cache-persist | OK | 1053 |  |
| 10 | tutorial-auto-open | OK | 1027 |  |
| 11 | tutorial-manual-reopen | OK | 413 |  |
| 12 | create-submit-job | OK | 1510 |  |
| 13 | history-filters | OK | 529 |  |
| 14 | batch-render | OK | 679 |  |
| 15 | picker-render | OK | 453 |  |
| 16 | picker-create-session | OK | 1618 |  |
| 17 | admin-filters | OK | 1485 |  |
| 18 | not-found | OK | 166 |  |
| 19 | keyboard-tab-nav | OK | 312 |  |
| 20 | settings-password-validation | OK | 1023 |  |
| 21 | history-pagination | OK | 445 |  |
| 22 | topnav-visible-on-admin | OK | 236 |  |
| 23 | responsive-mobile | OK | 653 |  |

## Console errors

### boot (1)
```
{"text":"[abort] [2026-04-23T14:56:14.776Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```

### dashboard (1)
```
{"text":"[abort] [2026-04-23T14:56:15.712Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```

### nav-create (2)
```
{"text":"[abort] [2026-04-23T14:56:16.132Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:16.133Z] [ERROR] [api] network request failed {method: GET, path: /admin/providers, url: http://127.0.0.1:8000/v1/admin/providers, message: si","abort":true}
```

### nav-batch (2)
```
{"text":"[abort] [2026-04-23T14:56:16.493Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:16.493Z] [ERROR] [api] network request failed {method: GET, path: /admin/providers, url: http://127.0.0.1:8000/v1/admin/providers, message: si","abort":true}
```

### nav-history (1)
```
{"text":"[abort] [2026-04-23T14:56:17.124Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### nav-admin (1)
```
{"text":"[abort] [2026-04-23T14:56:17.956Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### nav-settings (1)
```
{"text":"[abort] [2026-04-23T14:56:18.410Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### settings-toggle-cache-persist (4)
```
{"text":"[abort] [2026-04-23T14:56:18.720Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:18.750Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:19.210Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:19.256Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### tutorial-manual-reopen (3)
```
{"text":"[abort] [2026-04-23T14:56:20.762Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:20.790Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:20.791Z] [ERROR] [api] network request failed {method: GET, path: /admin/providers, url: http://127.0.0.1:8000/v1/admin/providers, message: si","abort":true}
```

### create-submit-job (11)
```
{"text":"[abort] [2026-04-23T14:56:21.175Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.202Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.203Z] [ERROR] [api] network request failed {method: GET, path: /admin/providers, url: http://127.0.0.1:8000/v1/admin/providers, message: si","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.698Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.699Z] [ERROR] [api] network request failed {method: POST, path: /jobs/batch-meta, url: http://127.0.0.1:8000/v1/jobs/batch-meta, message: s","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.699Z] [ERROR] [api] network request failed {method: POST, path: /jobs/active, url: http://127.0.0.1:8000/v1/jobs/active, message: signal is","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.700Z] [ERROR] [api] network request failed {method: POST, path: /jobs/batch-meta, url: http://127.0.0.1:8000/v1/jobs/batch-meta, message: s","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.700Z] [ERROR] [api] network request failed {method: GET, path: /jobs/164d0af05d49ea16e1042b8f84fc80e4, url: http://127.0.0.1:8000/v1/jobs/1","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.729Z] [ERROR] [api] network request failed {method: POST, path: /jobs/active, url: http://127.0.0.1:8000/v1/jobs/active, message: signal is","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.730Z] [ERROR] [api] network request failed {method: POST, path: /jobs/batch-meta, url: http://127.0.0.1:8000/v1/jobs/batch-meta, message: s","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:21.731Z] [ERROR] [api] network request failed {method: GET, path: /jobs/164d0af05d49ea16e1042b8f84fc80e4, url: http://127.0.0.1:8000/v1/jobs/1","abort":true}
```

### history-filters (3)
```
{"text":"[abort] [2026-04-23T14:56:22.688Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:22.713Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:22.714Z] [ERROR] [api] network request failed {method: POST, path: /jobs/batch-meta, url: http://127.0.0.1:8000/v1/jobs/batch-meta, message: s","abort":true}
```

### batch-render (3)
```
{"text":"[abort] [2026-04-23T14:56:23.196Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:23.222Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:23.223Z] [ERROR] [api] network request failed {method: GET, path: /admin/providers, url: http://127.0.0.1:8000/v1/admin/providers, message: si","abort":true}
```

### picker-render (1)
```
{"text":"[abort] [2026-04-23T14:56:23.883Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```

### picker-create-session (1)
```
{"text":"[abort] [2026-04-23T14:56:24.336Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```

### admin-filters (2)
```
{"text":"[abort] [2026-04-23T14:56:25.949Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:25.983Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### not-found (1)
```
{"text":"[abort] [2026-04-23T14:56:27.437Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```

### keyboard-tab-nav (1)
```
{"text":"[abort] [2026-04-23T14:56:27.606Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```

### settings-password-validation (2)
```
{"text":"[abort] [2026-04-23T14:56:27.921Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:27.950Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### history-pagination (3)
```
{"text":"[abort] [2026-04-23T14:56:28.943Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:28.971Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:28.972Z] [ERROR] [api] network request failed {method: POST, path: /jobs/batch-meta, url: http://127.0.0.1:8000/v1/jobs/batch-meta, message: s","abort":true}
```

### topnav-visible-on-admin (2)
```
{"text":"[abort] [2026-04-23T14:56:29.387Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:29.419Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```

### responsive-mobile (4)
```
{"text":"[abort] [2026-04-23T14:56:29.654Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:30.044Z] [ERROR] [api] network request failed {method: GET, path: /auth/me, url: http://127.0.0.1:8000/v1/auth/me, message: signal is aborted ","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:30.074Z] [ERROR] [api] network request failed {method: GET, path: /models, url: http://127.0.0.1:8000/v1/models, message: signal is aborted wi","abort":true}
```
```
{"text":"[abort] [2026-04-23T14:56:30.075Z] [ERROR] [api] network request failed {method: GET, path: /admin/providers, url: http://127.0.0.1:8000/v1/admin/providers, message: si","abort":true}
```

## Page errors (uncaught)
_none_

## Failed/5xx network requests

### boot (1)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```

### dashboard (1)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```

### nav-create (2)
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/admin/providers","failure":"net::ERR_ABORTED","abort":true}
```

### nav-batch (2)
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/admin/providers","failure":"net::ERR_ABORTED","abort":true}
```

### nav-history (1)
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### nav-admin (1)
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### nav-settings (1)
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### settings-toggle-cache-persist (4)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### tutorial-manual-reopen (3)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/admin/providers","failure":"net::ERR_ABORTED","abort":true}
```

### create-submit-job (7)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/admin/providers","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/jobs/batch-meta","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/jobs/active","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/jobs/active","failure":"net::ERR_ABORTED","abort":true}
```

### history-filters (3)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/jobs/batch-meta","failure":"net::ERR_ABORTED","abort":true}
```

### batch-render (3)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/admin/providers","failure":"net::ERR_ABORTED","abort":true}
```

### picker-render (1)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```

### picker-create-session (1)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```

### admin-filters (2)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### not-found (1)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```

### keyboard-tab-nav (1)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```

### settings-password-validation (2)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### history-pagination (3)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/jobs/batch-meta","failure":"net::ERR_ABORTED","abort":true}
```

### topnav-visible-on-admin (2)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```

### responsive-mobile (4)
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/auth/me","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/models","failure":"net::ERR_ABORTED","abort":true}
```
```
{"url":"http://127.0.0.1:8000/v1/admin/providers","failure":"net::ERR_ABORTED","abort":true}
```

## Findings
_none_