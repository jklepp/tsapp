---
id: 003-footer-build-date
title: Show the build date in the footer using formatDate
priority: 3
depends_on: [002-format-date-util]
touches: [src/components/Footer.tsx]
---

## Goal

The footer shows when the app was built, formatted with the shared `formatDate` helper.

## Requirements

- Read the build date from `import.meta.env.VITE_BUILD_DATE` (an ISO string). If it is missing, do not render the build-date element at all.
- Format it with `formatDate` from `src/utils/date.ts`.
- Extend `src/components/Footer.test.tsx`: one test with the variable set, one without.

## Out of scope

- Setting `VITE_BUILD_DATE` in CI. That is a separate PR.
