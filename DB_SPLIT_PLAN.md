# SAMI db.ts Split Plan

> 2053 строк → 6 модулей. Только план, не рефакторинг.

## Текущая структура

`src/db.ts` — монолит, ~80 exported functions, high churn (меняется каждую неделю).

## Предложенная структура

```
src/
├── db.ts              # Core: getDb(), closeDb(), withTransaction(), migrate()
├── db-videos.ts       # Videos: upsertVideo, getVideoById, filterVideos, wasPostedRecently
├── db-posts.ts        # Posts: recordPost, getLatestPost, getRecentPosts, wasPostedToday
├── db-approval.ts     # Approval: createApprovalSession, getApprovalQueue, approve/reject
├── db-members.ts      # Members: upsertMember, getMemberProfile, getMemberLevel, favorites, warnings, checkins, mod actions
├── db-seasons.ts      # Seasons: createSeason, ensureActiveSeason, queue slots, rituals
└── db-impl.ts         # Implementor: createImplTask, getNextImplTask, updateImplTaskStatus
```

## Маппинг функций

| Модуль | Функции | ~Строк |
|---|---|---|
| **db.ts** (core) | getDb, closeDb, withTransaction, migrate*, saveCaptcha, getCaptcha, deleteCaptcha, getExpiredCaptchas, saveUgcState, getUgcState, deleteUgcState, wipeAllData, getStopPhrases, addStopPhrase, removeStopPhrase | ~550 |
| **db-videos.ts** | upsertVideo, getVideoById, filterVideos, wasPostedRecently, isVideoRejected, getRejectionCount, recordRejection | ~150 |
| **db-posts.ts** | recordPost, getLatestPost, getLatestPostForDate, wasPostedToday, getRecentPosts, getRecentPostsByCategory, getPostByMessageId | ~150 |
| **db-approval.ts** | createApprovalSession, getApprovedVideo, setApprovalStatus, getApprovalSessionBy*, resetApprovalSessions, setApprovalMessageId, markApprovalPosted, getApprovalQueue, cleanupOld*, softDeletePending* | ~250 |
| **db-members.ts** | upsertMember, setMemberGoal, addWarning, getMemberProfile, getMemberLevel, toggleFavorite, isUserFavorite, getUserFavorites, recordCheckin, getCheckinStats, wasBuddyInviteSent, markBuddyInviteSent, getInactiveUsers, markReminderSent, logModAction, getModLogCount, getRecentModActions, getNewMembersToday | ~400 |
| **db-seasons.ts** | createSeason, getActiveSeason, getUpcomingSeason, getLatestSeason, activateSeason, completeSeason, ensureActiveSeason, getSeasonDay, getSeasonWeekNumber, initSeasonWeekSlots, getSeasonWeekStatus, setSeasonQueueVideo, getSeasonQueueForDay, markSeasonQueuePosted, getNextEmptySlot, createRitual, getCurrentRitual, setRitualMessageId, recordRitualParticipation, getRitualProgress, getRitualParticipantCount, getWeeklyTopMembers | ~350 |
| **db-impl.ts** | createImplTask, getImplTask, getNextImplTask, updateImplTaskStatus, listImplTasks | ~100 |

## Правила рефакторинга (когда будет время)

1. Все модули импортируют `getDb()` из `db.ts`
2. Миграции остаются в `db.ts` (единая точка)
3. Re-export из `db.ts` для обратной совместимости: `export { upsertVideo } from './db-videos'`
4. Переносить по одному модулю за сессию, запускать тесты после каждого
5. НЕ менять API — только перемещение функций
