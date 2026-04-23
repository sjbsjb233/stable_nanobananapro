# Nano Banana Pro - Frontend Deep Audit

- frontend: http://127.0.0.1:5173
- backend: http://127.0.0.1:8000
- total steps: 23
- passed: 23
- failed: 0

## Steps
| # | Step | Status | Duration (ms) | Error |
|---|------|--------|---------------|-------|
| 1 | boot | OK | 1959 |  |
| 2 | dashboard | OK | 549 |  |
| 3 | nav-create | OK | 418 |  |
| 4 | nav-batch | OK | 780 |  |
| 5 | nav-history | OK | 230 |  |
| 6 | nav-picker | OK | 577 |  |
| 7 | nav-admin | OK | 538 |  |
| 8 | nav-settings | OK | 346 |  |
| 9 | settings-toggle-cache-persist | OK | 1135 |  |
| 10 | tutorial-auto-open | OK | 1974 |  |
| 11 | tutorial-manual-reopen | OK | 488 |  |
| 12 | create-submit-job | OK | 1987 |  |
| 13 | history-filters | OK | 598 |  |
| 14 | batch-render | OK | 712 |  |
| 15 | picker-render | OK | 435 |  |
| 16 | picker-create-session | OK | 1648 |  |
| 17 | admin-filters | OK | 1346 |  |
| 18 | not-found | OK | 176 |  |
| 19 | keyboard-tab-nav | OK | 345 |  |
| 20 | settings-password-validation | OK | 1062 |  |
| 21 | history-pagination | OK | 452 |  |
| 22 | topnav-visible-on-admin | OK | 232 |  |
| 23 | responsive-mobile | OK | 650 |  |

## Console errors
_none_

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