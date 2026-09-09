---
id: 001-footer-year
title: Show the current year in the footer
priority: 2
depends_on: []
touches: [src/components/Footer.tsx]
---

## Goal

The footer should display the current calendar year instead of a hard-coded value.

## Requirements

- Compute the year at render time with `new Date().getFullYear()`.
- Keep the rest of the footer text unchanged.
- Add a unit test `src/components/Footer.test.tsx` that renders the footer and asserts the current year is present.

## Out of scope

- Any styling changes.
- Any change to other components.
