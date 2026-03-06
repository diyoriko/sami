# SAMI_TASKS.md — Execution Tasks (FlutterFlow-first)

## 0) Project setup
- [ ] Create FlutterFlow project: `SAMI`
- [ ] Define design tokens:
  - [ ] Colors (bg/base/text/accent)
  - [ ] Typography scale (H1/H2/body/caption)
  - [ ] Radius/spacing system
- [ ] Configure environments (dev/prod)
- [ ] Connect backend (Supabase/Firebase — pick one)

## 1) Data + backend foundation
- [ ] Create collections/tables:
  - [ ] users
  - [ ] workouts
  - [ ] exercises
  - [ ] activities
  - [ ] preferences
- [ ] Add indexes:
  - [ ] activities by `user_id + planned_for`
  - [ ] workouts by `creator_id + created_at`
  - [ ] feed query indexes by category/difficulty/duration
- [ ] Add security rules / row-level permissions

## 2) Navigation skeleton
- [ ] Bottom tabs:
  - [ ] Timeline
  - [ ] Feed
  - [ ] Create
  - [ ] Profile
- [ ] Global app shell + safe areas
- [ ] Empty/loading/error states component set

## 3) Onboarding flow
- [ ] Screen 1: goal selection
- [ ] Screen 2: available time/day
- [ ] Screen 3: level
- [ ] Screen 4: focus tags
- [ ] Save onboarding payload to `users/preferences`
- [ ] Route to Timeline

## 4) Timeline (Home)
- [ ] Build calendar strip (horizontal)
- [ ] Build daily activity cards:
  - [ ] title/category/duration/muscle focus
  - [ ] status chip (planned/completed/skipped)
- [ ] Completion interaction:
  - [ ] checkbox/action
  - [ ] update completion rate
- [ ] Streak logic (v1):
  - [ ] if completion_rate >= 80 → increment streak
  - [ ] if day missed → keep state for reminder engine

## 5) Feed
- [ ] Feed card component:
  - [ ] cover media
  - [ ] title
  - [ ] duration
  - [ ] difficulty
  - [ ] creator mini profile
- [ ] Filter bar:
  - [ ] category
  - [ ] duration range
  - [ ] muscle group
  - [ ] difficulty
- [ ] Feed query by preferences + active filters
- [ ] Empty-state: “no matching workouts”

## 6) Workout Creator (4-step wizard)
- [ ] Step 1: basic info
- [ ] Step 2: exercises builder (add/reorder/remove)
- [ ] Step 3: media attach (exercise-level or workout-level)
- [ ] Step 4: publish settings (public/private + description)
- [ ] Persist `workouts` + `exercises`
- [ ] Post-publish success state + route to Feed/Profile

## 7) Profile
- [ ] Header: avatar/name/level
- [ ] Stats widgets:
  - [ ] total sessions
  - [ ] streak
  - [ ] completion rate (weekly)
- [ ] User workouts grid/list
- [ ] Preferences editor

## 8) Notifications + reminders
- [ ] Push permission request flow
- [ ] Daily reminder schedule
- [ ] Gentle missed-day reminder
- [ ] Notification deep links to Timeline

## 9) Analytics (must-have events)
- [ ] onboarding_completed
- [ ] timeline_opened
- [ ] activity_completed
- [ ] feed_opened
- [ ] feed_filter_applied
- [ ] workout_creator_opened
- [ ] workout_published
- [ ] profile_opened

## 10) QA + release prep
- [ ] Test matrix:
  - [ ] iPhone small (SE-size)
  - [ ] iPhone standard
  - [ ] iPhone Pro Max
- [ ] Check all empty/loading/error states
- [ ] Verify no dead-end navigation
- [ ] App metadata draft (name/subtitle/keywords/description)
- [ ] Privacy policy URL ready
- [ ] TestFlight build checklist

---

## Priority order (do in this sequence)
1. Setup + data
2. Navigation + onboarding
3. Timeline core
4. Feed
5. Creator
6. Profile
7. Notifications
8. Analytics + QA + TestFlight

## Timebox suggestion
- P0 (Days 1–3): setup, data, onboarding, nav
- P1 (Days 4–7): timeline + streak core
- P2 (Days 8–10): feed + filters
- P3 (Days 11–12): creator + publish
- P4 (Days 13–14): profile + QA + release prep
