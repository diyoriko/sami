# SAMI_UI_MAP.md — Screen & Component Map (v1)

## Design system primitives
- **Spacing:** 4 / 8 / 12 / 16 / 20 / 24 / 32
- **Radius:** 10 / 14 / 18 / 24
- **Typography:** H1, H2, Title, Body, Caption
- **Core components:**
  - AppTopBar
  - SectionHeader
  - StatWidget
  - ActivityCard
  - WorkoutCard
  - FilterChip
  - PrimaryButton / SecondaryButton
  - EmptyState / ErrorState / LoadingState

---

## 1) Auth & Onboarding

### 1.1 Welcome / Auth
**Purpose:** Вход в приложение

**Components:**
- Logo mark
- Intro copy
- PrimaryButton: Continue with Email
- Optional: Apple sign-in button

**States:**
- Loading auth
- Auth error

### 1.2 Onboarding: Goal
**Components:**
- Progress indicator (step 1/4)
- SelectCard list (goals)
- Next button

### 1.3 Onboarding: Time
**Components:**
- Progress indicator
- Time range selector (10/20/30/45/60)
- Next button

### 1.4 Onboarding: Level
**Components:**
- Progress indicator
- Segmented control (Beginner/Intermediate/Advanced)
- Next button

### 1.5 Onboarding: Focus
**Components:**
- Progress indicator
- Multi-select chips (core/legs/mobility/boxing/breathwork/run)
- Finish button

---

## 2) Timeline (Home)

### 2.1 Timeline Screen
**Purpose:** Daily rhythm + planned/completed activities

**Header area:**
- Greeting + date
- Mini streak badge

**Main components:**
- Horizontal CalendarStrip
- SectionHeader: Today
- ActivityCard list
- Floating action (quick add)

**ActivityCard fields:**
- Workout title
- Category tag
- Duration
- Muscle focus badges
- Status chip
- Complete action

**States:**
- Empty: no activities today
- Loading skeleton cards
- Error with retry

---

## 3) Feed

### 3.1 Feed Screen
**Purpose:** Discover structured workouts

**Header:**
- Title: Community
- Filter button

**Top controls:**
- Horizontal filter chips:
  - Category
  - Duration
  - Muscle group
  - Difficulty

**Main list:**
- WorkoutCard list

**WorkoutCard fields:**
- Cover image/video thumbnail
- Workout title
- Meta row (duration, difficulty, category)
- Creator mini block (avatar + name)

**States:**
- Empty filter result
- Loading shimmer
- Error state

---

## 4) Create (Workout Wizard)

### 4.1 Create — Step 1 (Basic)
**Fields:**
- Title
- Category
- Difficulty
- Estimated duration

### 4.2 Create — Step 2 (Structure)
**Components:**
- Reorderable Exercise list
- Add exercise button
- Inline editor row:
  - title
  - duration
  - sets/reps
  - rest

### 4.3 Create — Step 3 (Media)
**Components:**
- Upload picker
- Option: per exercise / full workout cover
- Media preview tiles

### 4.4 Create — Step 4 (Publish)
**Components:**
- Description textarea
- Visibility toggle (Public/Private)
- Publish button

**Success state:**
- Confirmation card
- Buttons: Go to Feed / Go to Profile

---

## 5) Profile

### 5.1 Profile Screen
**Header:**
- Avatar
- Name
- Level badge

**Stats row:**
- StatWidget: Total sessions
- StatWidget: Streak
- StatWidget: Weekly completion

**Content:**
- Section: My workouts
- Grid/List of own WorkoutCards

**Actions:**
- Edit preferences
- Notification settings

**States:**
- Empty workouts
- Loading
- Error

---

## 6) Shared overlays

### 6.1 Filter Bottom Sheet
- Multi-select chips
- Reset / Apply actions

### 6.2 Confirmation Modal
- “Mark activity complete?”
- Confirm / cancel

### 6.3 Toasts
- Workout published
- Activity completed
- Save failed

---

## 7) Navigation map (v1)
- Auth → Onboarding(4 steps) → Timeline
- Timeline ↔ Feed ↔ Create ↔ Profile (tab bar)
- Feed → Workout details (optional v1.1)
- Profile → Preferences

---

## 8) MVP screen list (must build)
1. Auth
2. Onboarding Goal
3. Onboarding Time
4. Onboarding Level
5. Onboarding Focus
6. Timeline
7. Feed
8. Create Step 1
9. Create Step 2
10. Create Step 3
11. Create Step 4
12. Profile
13. Filter Sheet
14. Generic Empty/Error states
