import { formatDate } from "./date";

test("formats a normal date", () => {
  expect(formatDate(new Date(2024, 9, 15))).toBe("2024-10-15");
});

test("pads a single-digit month and day", () => {
  expect(formatDate(new Date(2024, 0, 5))).toBe("2024-01-05");
});

test("formats December 31st", () => {
  expect(formatDate(new Date(2023, 11, 31))).toBe("2023-12-31");
});
