---
id: 002-format-date-util
title: Add a formatDate utility
priority: 3
depends_on: []
touches: [src/utils/date.ts]
---

## Goal

Add a small, tested date-formatting helper that other features can reuse.

## Requirements

- Create `src/utils/date.ts` exporting `formatDate(date: Date): string`.
- Output format is `YYYY-MM-DD` using the local timezone.
- Add `src/utils/date.test.ts` covering a normal date, a single-digit month and day, and December 31st.

## Out of scope

- Localisation. Do not add a dependency.
