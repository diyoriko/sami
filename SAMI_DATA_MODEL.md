# SAMI — Data Model (v1)

## User
- id (uuid)
- name
- avatar_url
- level (beginner/intermediate/advanced)
- goal (enum)
- focus_tags (array)
- available_minutes
- streak_count
- last_active_at
- created_at

## Workout
- id (uuid)
- creator_id (fk users.id)
- title
- category (strength/mobility/boxing/run/breathwork)
- difficulty (1..3)
- est_duration_min
- muscle_groups (array)
- cover_media_url
- visibility (public/private)
- created_at
- updated_at

## Exercise
- id (uuid)
- workout_id (fk workouts.id)
- order_index
- title
- duration_sec
- sets
- reps
- rest_sec
- media_url
- notes

## Activity (timeline instance)
- id (uuid)
- user_id
- workout_id
- planned_for (date)
- completed_at (nullable)
- completion_rate (0..100)
- status (planned/completed/skipped)

## FeedItem (derived)
- id
- workout_id
- creator_id
- score
- created_at

## Preference
- user_id
- preferred_categories (array)
- preferred_duration_range
- preferred_difficulty_range

## Event Taxonomy (minimum)
- onboarding_completed
- timeline_opened
- activity_completed
- feed_opened
- feed_filter_applied
- workout_creator_opened
- workout_published
- profile_opened
